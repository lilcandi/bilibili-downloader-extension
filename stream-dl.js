// 流式下载页（后台标签页宿主，大文件兜底通道）
//
// 背景：常规 B站 CDN（upos-*.bilivideo.com）强制校验 Referer，而 DNR 的 Referer 注入
// 对 chrome.downloads 发起的请求不生效（对 fetch 生效），且 downloads.headers 禁止携带
// Referer（"Unsafe request header name"）。因此 chrome.downloads 直连这些 CDN 必 403。
//
// 方案：在本扩展页里用 fetch（xmlhttprequest 类型，DNR 正常注入 Referer）流式读取 →
// 逐块写入 OPFS（磁盘级临时文件，内存恒定，规避 600MB 合并上限）→ 完成后用
// file-backed blob URL（不再占内存）经 chrome.downloads 落到下载目录 → 清理临时文件。
//
// 大文件可靠性（v1.6.4 重写）：
//   - 分块 Range 下载（8MB/块），单块失败就地重试并轮换候选地址（B站 CDN 支持 Range，
//     同一文件的各镜像主机字节一致，可跨主机续块）；没有按总时长掐任务的硬超时，
//     慢速但持续推进的下载可以一直跑
//   - 首块请求（bytes=0-8M）兼任 Range 探测，不发单独的 0-0 小请求
//     （部分环境对 1 字节响应异常迟钝）；CDN 不支持 Range 时回退整流下载
//   - 单次 read 无数据 30s 判定卡死（换地址重试该块）；整体 3 分钟无任何字节
//     进展或 4 小时绝对上限才放弃
//   - blob 转存 downloads 失败自动重试（重建 blob URL）
//
// 宿主选用后台标签页而非 offscreen 文档：offscreen 的 chrome.* API 是受限子集
// （实测没有 chrome.downloads），扩展标签页则是完整 API 面（已实证 OPFS+blob 链路可用）。
// 每个任务独立 OPFS 临时文件，视频/音频双任务可并发。

const CHUNK_SIZE = 8 * 1024 * 1024;      // 初始块 8MB：短连接不容易被 CDN/中间设备掐断
const CHUNK_MIN = 256 * 1024;            // 块下限：连接被掐的极限也至少能传 256KB
const STALL_MS = 30 * 1000;              // 单次 read 无数据 30s → 卡死，换地址重试
const FETCH_TIMEOUT_MS = 45 * 1000;      // fetch 建连+响应头超时
const NO_PROGRESS_MS = 3 * 60 * 1000;    // 整体无字节进展上限
const ABSOLUTE_DEADLINE_MS = 4 * 60 * 60 * 1000; // 任务绝对上限（慢速连接按进度继续，不限总时长）
const PROGRESS_TICK_MS = 3000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'STREAM_DL_PING') {
        sendResponse({ pong: true });
        return;
    }
    if (msg.type === 'STREAM_DL_START' && Array.isArray(msg.urls) && msg.urls.length) {
        if (msg.mergeCmd) showMergeCmd(msg.mergeCmd);
        runOpfsDownload(msg.urls, msg.filename);
        sendResponse({ started: true });
    }
});

// ffmpeg 合并命令展示 + 一键复制（>600MB 双文件模式由 content.js 随任务下发）
let mergeCmdText = '';
function showMergeCmd(cmd) {
    if (!cmd) return;
    mergeCmdText = cmd;
    document.getElementById('mergeCmd').textContent = cmd;
    document.getElementById('merge').style.display = 'block';
}

async function copyMergeCmd() {
    const btn = document.getElementById('copyBtn');
    const ok = () => { btn.textContent = '已复制 ✓'; btn.disabled = true; setTimeout(() => { btn.textContent = '一键复制合并命令'; btn.disabled = false; }, 2000); };
    try {
        await navigator.clipboard.writeText(mergeCmdText);
        ok();
    } catch (e) {
        // 剪贴板 API 不可用时退回 execCommand
        try {
            const ta = document.createElement('textarea');
            ta.value = mergeCmdText;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            ok();
        } catch (e2) {
            btn.textContent = '复制失败，请手动选中命令复制';
            setTimeout(() => { btn.textContent = '一键复制合并命令'; }, 3000);
        }
    }
}
document.getElementById('copyBtn').addEventListener('click', copyMergeCmd);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 进度页 UI ----------
// 每个 STREAM_DL_START 一张卡片；心跳更新进度条；终态标记完成/失败。
// 页面同时承载多个并发任务（视频+音频），全部结束且成功才自动关页（任一失败保留页面展示原因）。
const jobsEl = document.getElementById('jobs');
const uiRows = new Map();   // filename -> {root, bar, size, status, err, lastT, lastB}
const jobRegistry = new Map(); // filename -> die(why)（页面被关/手动中止时调用）
let activeJobCount = 0;
let anyJobFailed = false;
let pageCloseTimer = null;

const fmtMB = n => n >= 100 * (1 << 20) ? (n / (1 << 30)).toFixed(2) + 'GB' : (n / (1 << 20)).toFixed(1) + 'MB';

function jobRow(filename) {
    if (uiRows.has(filename)) return uiRows.get(filename);
    jobsEl.querySelector('.empty')?.remove();
    const root = document.createElement('div');
    root.className = 'job';
    root.innerHTML = `<div class="name"></div><div class="bar"><i></i></div>
        <div class="row"><span class="size"></span><span class="status">连接中…</span></div><div class="err"></div>`;
    root.querySelector('.name').textContent = filename;
    jobsEl.appendChild(root);
    const row = {
        root,
        bar: root.querySelector('.bar i'),
        size: root.querySelector('.size'),
        status: root.querySelector('.status'),
        err: root.querySelector('.err'),
        lastT: 0, lastB: 0,
    };
    uiRows.set(filename, row);
    return row;
}

function uiProgress(filename, received, total) {
    const r = jobRow(filename);
    const pct = total ? Math.min(100, received / total * 100) : 0;
    r.bar.style.width = pct.toFixed(1) + '%';
    let speed = '';
    const now = Date.now();
    if (r.lastT && now > r.lastT) {
        const mbps = (received - r.lastB) / (now - r.lastT) / 1048.576; // MB/s
        if (mbps > 0.05) speed = ' · ' + (mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)) + 'MB/s';
    }
    r.lastT = now; r.lastB = received;
    r.size.textContent = fmtMB(received) + (total ? ' / ' + fmtMB(total) : '') + speed;
    r.status.textContent = total ? pct.toFixed(1) + '%' : '下载中';
}

function uiPhase(filename, text) {
    jobRow(filename).status.textContent = text;
}

function uiDone(filename, ok, error) {
    const r = jobRow(filename);
    r.root.classList.add(ok ? 'done' : 'fail');
    if (ok) {
        r.bar.style.width = '100%';
        r.status.textContent = '完成 ✓ 已转入下载列表';
    } else {
        r.status.textContent = '失败 ✗';
        r.err.textContent = error || '未知错误';
    }
}


// 清理历史任务残留（浏览器被强杀时 writer 的 .crswap 与临时文件会留下）；只动超过 24h 的
(async () => {
    try {
        const root = await navigator.storage.getDirectory();
        const names = [];
        for await (const [name] of root.entries()) if (/^bdl-/.test(name)) names.push(name);
        for (const name of names) {
            try {
                const fh = await root.getFileHandle(name);
                const f = await fh.getFile();
                if (Date.now() - f.lastModified > 24 * 3600 * 1000) await root.removeEntry(name);
            } catch (_) { /* 忽略 */ }
        }
    } catch (_) { /* 忽略 */ }
})();

async function runOpfsDownload(urls, filename) {
    activeJobCount++;
    clearTimeout(pageCloseTimer); // 新任务进入：撤销已排期的自动关页（错峰竞态）
    jobRow(filename);
    const root = await navigator.storage.getDirectory();
    const tmp = 'bdl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' +
        String(filename).replace(/[^\w.-]/g, '_').slice(-60);
    const t0 = Date.now();
    let received = 0;
    let lastByteAt = Date.now();
    let lastBeat = 0;
    let plan = null;
    let writer = null;
    let currentCtrl = null;
    let fatalErr = null;
    // 自适应块大小：连接被掐在固定字节数处时，减半块大小直到能整块传完；
    // 连续 3 块完整传完则逐步恢复（掐断只是一次性网络抖动时保住带宽）
    let stride = CHUNK_SIZE;
    let cleanStreak = 0;
    let chunkGot = 0; // 当前区块尝试已收到的字节数（失败时要据此判断是否掐断）
    const noteChunkDone = () => { cleanStreak++; if (cleanStreak >= 3) stride = Math.min(CHUNK_SIZE, stride * 2); };
    const noteChunkBroke = () => {
        cleanStreak = 0;
        if (chunkGot > 0) stride = Math.max(CHUNK_MIN, Math.floor(stride / 2));
    };

    const die = why => {
        if (!fatalErr) fatalErr = why;
        try { if (currentCtrl) currentCtrl.abort(); } catch (e) { /* 忽略 */ }
    };
    jobRegistry.set(filename, die);
    const watchdog = setInterval(() => {
        if (Date.now() - lastByteAt > NO_PROGRESS_MS) die('no-progress（3 分钟无任何字节）');
        else if (Date.now() - t0 > ABSOLUTE_DEADLINE_MS) die('deadline（4 小时上限）');
    }, 15000);

    const beat = force => {
        const now = Date.now();
        if (!force && now - lastBeat < PROGRESS_TICK_MS) return;
        lastBeat = now;
        // 进度心跳：更新本页进度条（顺带重置 SW 空闲计时器，防止长下载期间 SW 被回收）
        uiProgress(filename, received, plan ? plan.total : 0);
        chrome.runtime.sendMessage({ type: 'STREAM_DL_PROGRESS', filename, received, total: plan ? plan.total : 0 }).catch(() => { });
    };

    try {
        await root.removeEntry(tmp).catch(() => { });
        const fh = await root.getFileHandle(tmp, { create: true });
        writer = await fh.createWritable();

        await downloadFirst(urls);
        await writer.close();
        writer = null;

        const file = await fh.getFile();
        if (file.size === 0) throw new Error('empty body');
        if (plan.total && file.size !== plan.total) throw new Error(`size-mismatch ${file.size}/${plan.total}`);

        for (let attempt = 1; attempt <= 3; attempt++) {
            uiPhase(filename, '转存到下载列表…');
            const blobUrl = URL.createObjectURL(file);
            const ok = await transferToDownloads(blobUrl, filename);
            URL.revokeObjectURL(blobUrl);
            if (ok) {
                await root.removeEntry(tmp).catch(() => { });
                return finish(true);
            }
            console.warn(`[bdl-stream] downloads 转存第 ${attempt} 次失败${attempt < 3 ? '，重建 blob URL 重试' : ''}`);
            await sleep(2000);
        }
        throw new Error('downloads 转存失败');
    } catch (e) {
        try { if (writer) await writer.abort(); } catch (_) { /* 忽略 */ }
        writer = null;
        await root.removeEntry(tmp).catch(() => { });
        finish(false, fatalErr || (e && e.message) || String(e));
    } finally {
        clearInterval(watchdog);
        jobRegistry.delete(filename);
    }

    // ---- 首块请求（bytes=0-stride）兼任 Range 探测：206 → 分块模式；200 → 整流模式 ----
    async function downloadFirst(candidateUrls) {
        const attempts = Math.max(8, candidateUrls.length * 3);
        let lastErr = '';
        for (let attempt = 0; attempt < attempts && !fatalErr; attempt++) {
            const url = candidateUrls[attempt % candidateUrls.length];
            const ctrl = new AbortController();
            currentCtrl = ctrl;
            try {
                const resp = await fetchWithTimeout(url,
                    { headers: { Range: `bytes=0-${stride - 1}` }, signal: ctrl.signal }, ctrl);
                if (resp.status === 206 && resp.body) {
                    const m = /\/(\d+)\s*$/.exec(resp.headers.get('content-range') || '');
                    if (!m || +m[1] <= 0) {
                        try { await resp.body.cancel(); } catch (_) { /* 忽略 */ }
                        throw new Error('content-range-unparsable');
                    }
                    plan = { ranged: true, total: +m[1] };
                    console.log(`[bdl-stream] Range 可用，总长 ${(plan.total / (1 << 20)).toFixed(1)}MB，当前块 ${(stride / (1 << 20)).toFixed(0)}MB`);
                    const want = Math.min(stride, plan.total);
                    const got = await pipeBody(resp, 0, ctrl);
                    if (got !== want) throw new Error(`short-read ${got}/${want}`);
                    noteChunkDone();
                    await downloadRanged(candidateUrls, plan.total, want);
                    return;
                }
                if (resp.status === 200 && resp.body) {
                    plan = { ranged: false, total: +(resp.headers.get('content-length') || 0) };
                    console.log('[bdl-stream] CDN 不支持 Range，整流下载');
                    const got = await pipeBody(resp, 0, ctrl);
                    if (plan.total && got !== plan.total) throw new Error(`short-read ${got}/${plan.total}`);
                    if (got === 0) throw new Error('empty body');
                    return;
                }
                try { if (resp.body) await resp.body.cancel(); } catch (_) { /* 忽略 */ }
                throw new Error('HTTP ' + resp.status);
            } catch (e) {
                if (fatalErr) throw new Error(fatalErr);
                lastErr = (e && e.message) || String(e);
                console.warn(`[bdl-stream] 首块第 ${attempt + 1} 次失败（${url.slice(0, 60)}）:`, lastErr);
                noteChunkBroke();
                try { await writer.seek(0); received = 0; } catch (w) { throw new Error('write-failed: ' + w.message); }
                await sleep(Math.min(3000, 400 * (attempt + 1)));
            } finally {
                if (currentCtrl === ctrl) currentCtrl = null;
            }
        }
        throw new Error('all-candidates-failed(first): ' + lastErr);
    }

    // ---- 分块下载余下部分：单块失败就地重试、轮换候选地址、按掐断情况缩放块大小 ----
    async function downloadRanged(candidateUrls, total, startOffset) {
        for (let offset = startOffset; offset < total;) {
            const end = Math.min(offset + stride, total) - 1;
            const want = end - offset + 1;
            const rounds = Math.max(8, candidateUrls.length * 3);
            let lastErr = '';
            let done = false;
            for (let attempt = 0; attempt < rounds && !fatalErr; attempt++) {
                const url = candidateUrls[attempt % candidateUrls.length];
                try {
                    const got = await fetchRangeInto(url, offset, end);
                    if (got !== want) throw new Error(`short-read ${got}/${want}`);
                    noteChunkDone();
                    done = true;
                    break;
                } catch (e) {
                    if (fatalErr) break;
                    lastErr = (e && e.message) || String(e);
                    console.warn(`[bdl-stream] 区块 ${offset}-${end}（${(want / (1 << 20)).toFixed(1)}MB）第 ${attempt + 1} 次失败（${url.slice(0, 60)}）:`, lastErr);
                    noteChunkBroke();
                    // 写指针拨回区块起点，按（可能已缩小的）块重写该区块
                    try { await writer.seek(offset); received = offset; } catch (w) { die('write-failed: ' + w.message); break; }
                    await sleep(Math.min(3000, 400 * (attempt + 1)));
                }
            }
            if (!done) throw new Error(`chunk-failed@${offset}: ${lastErr}`);
            beat(true);
            offset += want;
        }
    }

    // 拉取一个区块写入 writer（writer 由调用方持有）；返回实际写入字节数
    async function fetchRangeInto(url, offset, end) {
        const ctrl = new AbortController();
        currentCtrl = ctrl;
        try {
            const resp = await fetchWithTimeout(url,
                { headers: { Range: `bytes=${offset}-${end}` }, signal: ctrl.signal }, ctrl);
            if (resp.status !== 206 || !resp.body) {
                try { if (resp.body) await resp.body.cancel(); } catch (_) { /* 忽略 */ }
                throw new Error('HTTP ' + resp.status);
            }
            const cr = resp.headers.get('content-range') || '';
            if (!cr.startsWith(`bytes ${offset}-`)) throw new Error('range-mismatch: ' + cr);
            return await pipeBody(resp, offset, ctrl);
        } finally {
            if (currentCtrl === ctrl) currentCtrl = null;
        }
    }

    // 把响应体流式写入 writer（卡死检测）；返回写入字节数
    async function pipeBody(resp, baseOffset, ctrl) {
        chunkGot = 0;
        const reader = resp.body.getReader();
        let got = 0;
        for (; ;) {
            const { done, value } = await readStall(reader, ctrl.signal);
            if (done) break;
            try { await writer.write(value); } catch (w) { die('write-failed: ' + w.message); throw w; }
            got += value.byteLength;
            chunkGot = got;
            received = baseOffset + got;
            lastByteAt = Date.now();
            beat();
        }
        return got;
    }

    // fetch 建连+响应头超时；超时同时 abort 底层连接（ctrl 由调用方持有）。
    // 每次尝试都刷新 lastByteAt：看门狗的"无进展"只针对真正停滞，活跃重试不算停滞
    function fetchWithTimeout(url, options, ctrl) {
        lastByteAt = Date.now();
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                try { if (ctrl) ctrl.abort(); } catch (_) { /* 忽略 */ }
                reject(new Error('fetch-timeout'));
            }, FETCH_TIMEOUT_MS);
            fetch(url, options).then(
                r => { clearTimeout(t); resolve(r); },
                e => { clearTimeout(t); reject(e); });
        });
    }

    // 带卡死检测的 read：30s 无数据 reject('stall')（调用方 abort 连接后换地址重试）
    function readStall(reader, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
            const t = setTimeout(() => reject(new Error('stall')), STALL_MS);
            const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            reader.read().then(
                r => { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); resolve(r); },
                e => { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
        });
    }

    function finish(ok, error) {
        clearInterval(watchdog);
        activeJobCount--;
        if (!ok) anyJobFailed = true;
        uiDone(filename, ok, error);
        // 结果先回 SW（opfs 兜底通道的等待方），页面关闭由 maybeClosePage 统一决定
        send({ type: 'STREAM_DL_RESULT', filename, ok, error });
        maybeClosePage();
    }
}

// 页面承载多个并发任务（视频+音频）：必须等全部任务结束后才允许关页，
// 且任一失败时保留页面展示原因——绝不能先完成的任务把还在下载的任务一起带走
function maybeClosePage() {
    if (activeJobCount > 0) return;
    if (anyJobFailed) return; // 失败时保留页面，用户需要看到错误
    clearTimeout(pageCloseTimer);
    pageCloseTimer = setTimeout(() => { try { window.close(); } catch (e) { } }, 8000);
}

// 用户手动关闭页面 = 中止全部任务（SW 的兜底等待会收到失败结果并走 failover 收尾）
window.addEventListener('pagehide', () => {
    for (const die of jobRegistry.values()) { try { die('页面被关闭'); } catch (e) { /* 忽略 */ } }
});

// blob URL → 浏览器下载列表，等终态（blob 生命周期绑定本页面，完成前不能关）
function transferToDownloads(blobUrl, filename) {
    return new Promise(resolve => {
        try {
            chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, id => {
                if (chrome.runtime.lastError || id === undefined) {
                    console.warn('[bdl-stream] downloads 启动失败:', chrome.runtime.lastError?.message);
                    return resolve(false);
                }
                const t0 = Date.now();
                const poll = () => chrome.downloads.search({ id }, items => {
                    const it = items && items[0];
                    if (!it) return (Date.now() - t0 < 5 * 60 * 1000) ? setTimeout(poll, 500) : resolve(false);
                    if (it.state === 'complete') return resolve(true);
                    if (it.state === 'interrupted') return resolve(false);
                    setTimeout(poll, 500);
                });
                poll();
            });
        } catch (e) {
            resolve(false);
        }
    });
}

function send(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => { }); } catch (e) { }
}
