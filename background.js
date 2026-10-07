// B站下载助手 - 后台脚本
// 接收 content.js 解析好的直链（含备用地址），调用浏览器下载。
// 启动成功立即响应；下载中断时在后台自动切换备用地址重试。

// ---------- 批量下载完成通知（回传给发起页所在标签页） ----------
// Chrome 限制：扩展页/背景的 runtime.sendMessage 不会送达内容脚本，必须用 tabs.sendMessage 定向转发。
// 发起下载任务时记录 filename -> tabId，任务终态时通知该标签页（批量队列据此推进）。
const noticeTabs = new Map(); // filename -> tabId
const NOTICE_LIMIT = 200;

function rememberNotice(filename, tabId) {
    if (tabId == null || tabId < 0 || !filename) return;
    if (noticeTabs.size > NOTICE_LIMIT) noticeTabs.clear();
    noticeTabs.set(filename, tabId);
}

function notifyTab(filename, type, ok) {
    const tabId = noticeTabs.get(filename);
    if (tabId == null) return;
    noticeTabs.delete(filename);
    try { chrome.tabs.sendMessage(tabId, { type, filename, ok }).catch(() => { }); } catch (e) { /* 忽略 */ }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    // 合并页/流式页报结果 → 转发给发起页（批量等待）
    if ((request.type === 'MERGE_DONE' || request.type === 'DOWNLOAD_DONE') && request.filename) {
        notifyTab(request.filename, request.type, !!request.ok);
        return;
    }
    if (request.type === 'DOWNLOAD_FILE' && Array.isArray(request.urls) && request.urls.length) {
        rememberNotice(request.filename, _sender.tab?.id);
        downloadWithFailover(request.urls, request.filename, request.mergeCmd, !!request.quiet);
        // 立即响应"已启动"，failover 在后台继续
        sendResponse({ ok: true, pending: true });
        return true;
    }
    if (request.type === 'GET_DOUYIN_STREAMS') {
        // content 点击下载时取回本标签页捕获到的真实播放直链（最近的在前）
        const tabId = _sender.tab?.id;
        const list = (douyinStreams.get(tabId) || [])
            .filter(e => Date.now() - e.ts < 3 * 60 * 1000)
            .map(e => e.url);
        sendResponse({ ok: true, urls: [...new Set(list)].slice(0, 10) });
        return true;
    }
    if (request.type === 'GET_DOUYIN_AWEME') {
        // 直读抖音播放器全局对象 window.player.config.awemeInfo（MAIN 世界）。
        // 这是 xg-video 播放器注入的当前作品完整数据：bitRateList 码率列表、图集 images、
        // 标题/作者等，页面打开即可用，无需先播放（比 webRequest 被动捕获更强）。
        // content script 在隔离世界拿不到 window.player，故经 background 用 scripting API 读取。
        const tabId = _sender.tab?.id;
        if (!tabId || tabId < 0) {
            sendResponse({ ok: true, data: null });
            return true;
        }
        chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            args: [Number.isFinite(request.nearTop) ? request.nearTop : null],
            func: (nearTop) => {
                // 字段裁剪：awemeInfo 与 feed 项 slideData 同构，共用
                const extract = (info) => {
                    if (!info) return null;
                    const v = info.video || null;
                    return {
                        awemeId: info.awemeId || '',
                        desc: info.desc || '',
                        author: info.authorInfo?.nickname || '',
                        images: Array.isArray(info.images)
                            ? info.images.map(im => (Array.isArray(im.url_list) ? im.url_list : []))
                            : null,
                        video: v ? {
                            playApi: v.playApi || '',
                            playApiH265: v.playApiH265 || '',
                            bitRateList: (v.bitRateList || []).map(br => ({
                                gearName: br.gearName || '',
                                format: br.format || '',
                                dataSize: br.dataSize || 0,
                                width: br.width || 0,
                                height: br.height || 0,
                                playApi: br.playApi || '',
                                playAddr: Array.isArray(br.playAddr) ? br.playAddr.map(a => a.src || '') : []
                            }))
                        } : null
                    };
                };
                // 有可用媒体才返回（直播卡片 cellRoom 无 bitRateList/playAddr/images）
                const usable = (info) => {
                    if (!info) return null;
                    const hasVideo = info.video && ((info.video.bitRateList || []).length || info.video.playApi || (info.video.playAddr || []).length);
                    return (hasVideo || (info.images || []).length) ? extract(info) : null;
                };

                // 优先：详情页播放器全局对象（xg-video 注入的当前作品完整数据）
                const fromPlayer = usable(window.player?.config?.awemeInfo);
                if (fromPlayer) return fromPlayer;

                // 回退：信息流页（推荐 /discover）没有 window.player，
                // 作品数据挂在 feed 项的 React fiber slideData 上。
                // nearTop：按钮所在 feed 项的视口 top，精确匹配点击的那个作品；
                // 缺省取"矩形中心离视口中心最近"的项 = 当前正在播放的视频
                const items = [...document.querySelectorAll('[data-e2e="feed-item"]')];
                if (!items.length) return null;
                const mid = nearTop !== null ? nearTop : innerHeight / 2;
                items.sort((a, b) => {
                    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                    const da = Math.abs(ra.top + ra.height / 2 - mid), db = Math.abs(rb.top + rb.height / 2 - mid);
                    return da - db;
                });
                for (const el of items) {
                    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
                    let f = fk ? el[fk] : null;
                    let hops = 0;
                    while (f && hops < 30) {
                        const sd = f.memoizedProps?.slideData;
                        if (sd) {
                            const hit = usable(sd);
                            if (hit) return hit;
                            break; // 该项是直播/无媒体，不再向上翻
                        }
                        f = f.return;
                        hops++;
                    }
                }
                return null;
            }
        }, results => {
            void chrome.runtime.lastError;
            sendResponse({ ok: true, data: results?.[0]?.result ?? null });
        });
        return true;
    }
    if (request.type === 'MERGE_JOB' && request.job) {
        // 任务交给合并页面：storage 传递 → 打开合并标签页
        rememberNotice(request.job.filename, _sender.tab?.id);
        chrome.storage.local.set({ mergeJob: request.job }, () => {
            void chrome.runtime.lastError;
            chrome.tabs.create({ url: chrome.runtime.getURL('merger.html'), active: !request.job.quiet });
            sendResponse({ ok: true });
        });
        return true;
    }
    if (request.type === 'SAVE_TEXT' && request.filename && request.base64) {
        // 字幕/弹幕等文本内容：base64 转 data URL 保存（UTF-8 已在 content 侧编码）
        const url = 'data:application/octet-stream;base64,' + request.base64;
        chrome.downloads.download({ url, filename: request.filename, saveAs: false }, id => {
            if (chrome.runtime.lastError || id === undefined) {
                console.warn('[B站下载助手] 文本保存失败:', chrome.runtime.lastError?.message, request.filename);
                sendResponse({ ok: false, error: chrome.runtime.lastError?.message || '保存失败' });
            } else {
                sendResponse({ ok: true });
            }
        });
        return true;
    }
});

// MV3 下 SW 空闲约 30 秒会被杀掉，异步注册的监听器会随 Promise 链一起丢失。
// 解决：onChanged 监听在顶层同步注册；下载期间定时调用扩展 API 重置 SW 空闲计时器。

console.log('[B站下载助手] SW loaded', new Date().toISOString());

// ---------- 抖音播放流捕获 ----------
// 抖音页面是客户端渲染：RENDER_DATA 可能缺失、<video> 的 src 常为 blob:，
// 脚本里也不一定有 playAddr。唯一稳定的事实是"浏览器真实播放过的 CDN 直链"，
// 用 webRequest 被动记录，点击下载时优先使用（SPA/未登录/水印逻辑全部免疫）。

const douyinStreams = new Map(); // tabId -> [{url, ts}]
const DOUYIN_STREAM_FILTER = {
    urls: [
        '*://*.douyinvod.com/*',
        '*://*.amemv.com/*',
        '*://*.awemv.com/*',
        '*://*.snssdk.com/*',
        '*://*.bytecdntp.com/*'
    ],
    types: ['media', 'xmlhttprequest', 'other']
};

chrome.webRequest.onResponseStarted.addListener(details => {
    // 只记录视频流特征（douyinvod 视频地址必含 video_id 或 /video/ 或 mime_type=video）
    if (!/video_id=|\/video\/|mime_type=video|\.mp4/i.test(details.url)) return;
    if (!details.tabId || details.tabId < 0) return;
    const list = douyinStreams.get(details.tabId) || [];
    list.push({ url: details.url, ts: Date.now() });
    // 每标签页最多记 30 条，整体最多 50 个标签页，防 SW 内存膨胀
    if (list.length > 30) list.splice(0, list.length - 30);
    if (douyinStreams.size > 50) {
        for (const k of douyinStreams.keys()) { douyinStreams.delete(k); if (douyinStreams.size <= 40) break; }
    }
    douyinStreams.set(details.tabId, list);
}, DOUYIN_STREAM_FILTER);

chrome.tabs.onRemoved.addListener(tabId => douyinStreams.delete(tabId));

const pending = new Map(); // downloadId -> resolve

chrome.downloads.onChanged.addListener(delta => {
    if (!delta.state) return;
    const resolve = pending.get(delta.id);
    if (resolve && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        pending.delete(delta.id);
        resolve(delta.state.current);
    }
});

let activeJobs = 0;
let keepAliveTimer = null;

function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
        chrome.downloads.search({ state: 'in_progress' }, () => void chrome.runtime.lastError);
    }, 20000);
}

function stopKeepAlive() {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
}

// 启动第一个可用地址；监控中断并依次切换备用地址（fire-and-forget）
// 中断处理策略：
//   - 有进度（>1MB）的中断 → 自动续传一次（B站 CDN 支持 Range，断流最常见，续传可救）
//     续传仍失败 → 保留下载记录（列表可见、可手动续传），绝不静默删除
//   - 零进度失败（403/地址过期等）→ 保留记录换下一地址
//   - 不可重试错误（磁盘满/拒绝访问/安全拦截）→ 立即终止，换地址没有意义
const NON_RETRYABLE = new Set([
    'FILE_ACCESS_DENIED', 'FILE_NO_SPACE', 'FILE_VIRUS_INFECTED', 'FILE_BLOCKED',
    'FILE_TOO_LARGE', 'FILE_SLOTS_FULL', 'USER_CANCELED', 'USER_SHUTDOWN', 'CRASH'
]);

const PROGRESS_THRESHOLD = 1 << 20; // 1MB

function getDownloadState(id) {
    return new Promise(resolve => {
        chrome.downloads.search({ id }, items => {
            void chrome.runtime.lastError;
            resolve(items?.[0] || null);
        });
    });
}

function tryResume(id) {
    return new Promise(resolve => {
        try {
            chrome.downloads.resume(id, () => resolve(!chrome.runtime.lastError));
        } catch (e) {
            resolve(false);
        }
    });
}

// resume 后 Chromium 的状态翻转有延迟（事件监听可能读到过期终态），
// 改用轮询等终态。返回前先等 3 秒让 in_progress 生效
async function pollTerminal(id, maxMs = 10 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 3000));
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const st = await getDownloadState(id);
        if (!st) return 'interrupted'; // 记录已消失
        if (st.state === 'complete' || st.state === 'interrupted') return st.state;
        await new Promise(r => setTimeout(r, 2000));
    }
    return 'timeout';
}

// upos 常规 CDN 强制校验 Referer，而 downloads 通道带不上 Referer（DNR 对其不生效），
// 直连必 403，只会留下 0 字节的失败记录。只对不校验 Referer 的主机
// （mcdn P2P 节点实测放行、非 upos 域名）先试 downloads 通道，其余直接交流式通道。
const UPOS_LIKE = /^https:\/\/upos-[a-z0-9-]+\.(bilivideo\.com|bilivideo\.cn|akamaized\.net)(:\d+)?\//i;

function flashBadge(text) {
    try {
        chrome.action.setBadgeBackgroundColor({ color: '#d63031' });
        chrome.action.setBadgeText({ text });
        setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 60000);
    } catch (e) { /* 忽略 */ }
}

// ---------- 流式下载兜底（后台标签页宿主） ----------
// chrome.downloads 直连会被"需要 Referer 的常规 CDN"403：DNR 的 Referer 注入对
// downloads 请求不生效，且 downloads.headers 禁止携带 Referer。此时改由扩展的
// 后台标签页（stream-dl.html）用 fetch（DNR 生效）流式写 OPFS 后经 blob URL
// 转入下载列表（内存恒定）。不用 offscreen 文档：其 chrome.* API 是受限子集，
// 实测没有 chrome.downloads，无法完成最后的转存。
let streamTabId = null;
const opfsWaiters = new Map(); // filename -> resolve
const streamResults = new Map(); // filename -> ok（本页批次结果，决定是否自动关页）
let streamCloseTimer = null;

chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'STREAM_DL_RESULT' && opfsWaiters.has(msg.filename)) {
        const finish = opfsWaiters.get(msg.filename);
        opfsWaiters.delete(msg.filename);
        streamResults.set(msg.filename, !!msg.ok);
        finish(msg);
        scheduleStreamTabClose();
    }
});

async function pingStreamTab() {
    if (streamTabId == null) return false;
    return new Promise(res => {
        try {
            chrome.tabs.sendMessage(streamTabId, { type: 'STREAM_DL_PING' }, r =>
                res(!chrome.runtime.lastError && !!r && r.pong === true));
        } catch (e) {
            res(false);
        }
    });
}

async function ensureStreamTab(quiet) {
    if (streamTabId != null) {
        if (await pingStreamTab()) return true;
        try { await chrome.tabs.remove(streamTabId); } catch (e) { /* 已关 */ }
        streamTabId = null;
    }
    try {
        const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('stream-dl.html'), active: !quiet });
        streamTabId = tab.id;
        streamResults.clear();
        for (let i = 0; i < 40; i++) {
            if (await pingStreamTab()) return true;
            await new Promise(r => setTimeout(r, 250));
        }
        console.warn('[B站下载助手] 流式下载页 ping 超时');
        return false;
    } catch (e) {
        console.warn('[B站下载助手] 流式下载页创建失败:', e.message);
        return false;
    }
}

async function sendToStreamTab(msg) {
    return new Promise(res => {
        try {
            chrome.tabs.sendMessage(streamTabId, msg, r => res(!chrome.runtime.lastError && !!r));
        } catch (e) {
            res(false);
        }
    });
}

function scheduleStreamTabClose() {
    clearTimeout(streamCloseTimer);
    streamCloseTimer = setTimeout(async () => {
        if (opfsWaiters.size) return; // 还有并发任务在等
        // 本批次任一任务失败 → 保留页面（用户需要在进度页看到失败原因），不自动关
        if ([...streamResults.values()].some(ok => !ok)) return;
        const id = streamTabId;
        streamTabId = null;
        if (id != null) {
            try { await chrome.tabs.remove(id); } catch (e) { /* 已关 */ }
        }
    }, 10000);
}

function opfsFallback(urls, filename, mergeCmd, quiet, timeoutMs = 4 * 60 * 60 * 1000) {
    // 超时只是安全网：真正的卡死判定在 stream-dl 页内（单 read 30s 卡死、整体 3 分钟
    // 无进展、4 小时绝对上限），不再按固定总时长掐任务——慢速连接靠进度继续。
    return new Promise(async resolve => {
        let done = false;
        const finish = r => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            opfsWaiters.delete(filename);
            resolve(r);
        };
        const timer = setTimeout(() => finish({ ok: false, error: 'stream-timeout' }), timeoutMs);
        opfsWaiters.set(filename, finish);
        if (!await ensureStreamTab(quiet)) return finish({ ok: false, error: 'stream-tab-unavailable' });
        const ack = await sendToStreamTab({ type: 'STREAM_DL_START', urls, filename, mergeCmd });
        if (!ack) finish({ ok: false, error: 'stream-tab-no-ack' });
    });
}

async function downloadWithFailover(urls, filename, mergeCmd, quiet) {
    activeJobs++;
    startKeepAlive();
    const trace = [];
    const zeroByteIds = []; // downloads 通道留下的 0 字节 403 残留记录，兜底成功后清理
    try {
        const queue = urls.filter(u => !UPOS_LIKE.test(u));
        while (queue.length) {
            const url = queue.shift();
            const started = await startDownload(url, filename);
            if (!started.ok) { trace.push({ url: url.slice(0, 80), err: 'start-failed' }); continue; }

            let result = await waitForDownload(started.id);

            if (result === 'interrupted') {
                const st = await getDownloadState(started.id);
                const reason = st?.interruptReason || '';
                if (NON_RETRYABLE.has(reason)) {
                    trace.push({ url: url.slice(0, 80), err: reason, bytes: st?.bytesReceived || 0 });
                    chrome.storage.local.set({ lastDlTrace: { filename, ok: false, fatal: reason, trace } }).catch(() => {});
                    flashBadge('!');
                    console.error('[B站下载助手] 下载终止（', reason, '）:', filename, '— 已在扩展图标标记，请检查磁盘/安全软件');
                    chrome.runtime.sendMessage({ type: 'DOWNLOAD_DONE', filename, ok: false }).catch(() => {});
                    return;
                }
                // 有进度的中断先自动续传一次（CDN 断流最常见，B站 CDN 支持 Range）
                if ((st?.bytesReceived || 0) > PROGRESS_THRESHOLD && await tryResume(started.id)) {
                    console.warn('[B站下载助手] 下载中断（已收', Math.round((st?.bytesReceived || 0) / (1 << 20)), 'MB），自动续传:', reason, filename);
                    result = await pollTerminal(started.id);
                }
            }

            if (result === 'complete') {
                chrome.storage.local.set({ lastDlTrace: { filename, ok: true, url: url.slice(0, 80) } }).catch(() => {});
                chrome.runtime.sendMessage({ type: 'DOWNLOAD_DONE', filename, ok: true }).catch(() => {});
                return;
            }

            // 失败一律保留下载记录（下载列表可见、可手动重试/续传），绝不静默删除——
            // 曾经的"中断即擦除"导致用户看到弹窗说已开始下载、列表却空空如也
            const endState = await getDownloadState(started.id);
            if (endState && (endState.bytesReceived || 0) === 0) zeroByteIds.push(started.id);
            trace.push({ url: url.slice(0, 80), state: result });
            console.warn('[B站下载助手] 下载未完成（记录已保留，可手动续传），尝试备用地址:', result, filename);
        }

        // downloads 通道全部失败（最常见：常规 CDN 403 —— DNR Referer 注入对 downloads
        // 请求不生效）。切换后台标签页流式通道兜底（fetch 可携带 Referer，写 OPFS 不占内存）
        console.warn('[B站下载助手] downloads 通道全部失败，切换流式下载通道:', filename);
        const r = await opfsFallback(urls, filename, mergeCmd, quiet);
        if (r && r.ok) {
            console.log('[B站下载助手] 流式下载完成:', filename);
            // 文件已完整落盘，顺手清掉 downloads 通道的 0 字节残留记录（避免列表里
            // 出现成对的 interrupted 空记录；成功后的清理不同于中断时的"静默删除"）
            for (const id of zeroByteIds) {
                try { chrome.downloads.erase({ id }, () => void chrome.runtime.lastError); } catch (e) { /* 忽略 */ }
            }
            chrome.storage.local.set({ lastDlTrace: { filename, ok: true, via: 'opfs-stream' } }).catch(() => {});
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_DONE', filename, ok: true }).catch(() => {});
            return;
        }

        trace.push({ err: 'all-failed', stream: (r && r.error) || 'failed' });
        chrome.storage.local.set({ lastDlTrace: { filename, ok: false, trace } }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_DONE', filename, ok: false }).catch(() => {});
        flashBadge('!');
        console.error('[B站下载助手] 所有地址均下载失败:', filename, JSON.stringify(trace));
    } finally {
        activeJobs--;
        if (activeJobs === 0) stopKeepAlive();
    }
}

function startDownload(url, filename) {
    return new Promise(resolve => {
        try {
            chrome.downloads.download({ url, filename, saveAs: false }, id => {
                if (chrome.runtime.lastError || id === undefined) {
                    console.warn('[B站下载助手] 启动失败:', chrome.runtime.lastError?.message, url.slice(0, 80));
                    resolve({ ok: false });
                } else {
                    resolve({ ok: true, id });
                }
            });
        } catch (e) {
            console.warn('[B站下载助手] 启动异常:', e.message);
            resolve({ ok: false });
        }
    });
}

function waitForDownload(id) {
    return new Promise(resolve => {
        pending.set(id, resolve);
        // 兜底：注册前下载可能已进入终态
        chrome.downloads.search({ id }, items => {
            void chrome.runtime.lastError;
            const state = items?.[0]?.state;
            if (state === 'complete' || state === 'interrupted') {
                pending.delete(id);
                resolve(state);
            }
        });
    });
}
