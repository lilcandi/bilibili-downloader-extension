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
// 宿主选用后台标签页而非 offscreen 文档：offscreen 的 chrome.* API 是受限子集
// （实测没有 chrome.downloads），扩展标签页则是完整 API 面（已实证 OPFS+blob 链路可用）。
// 每个任务独立 OPFS 临时文件，视频/音频双任务可并发。

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'STREAM_DL_PING') {
        sendResponse({ pong: true });
        return;
    }
    if (msg.type === 'STREAM_DL_START' && Array.isArray(msg.urls) && msg.urls.length) {
        runOpfsDownload(msg.urls, msg.filename);
        sendResponse({ started: true });
    }
});

async function runOpfsDownload(urls, filename) {
    const root = await navigator.storage.getDirectory();
    const tmp = 'bdl-' + Date.now() + '-' + String(filename).replace(/[^\w.-]/g, '_').slice(-60);
    let lastErr = '';

    for (const url of urls) {
        let writer = null;
        try {
            const fh = await root.getFileHandle(tmp, { create: true });
            const resp = await fetch(url);
            if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);

            writer = await fh.createWritable();
            const reader = resp.body.getReader();
            let received = 0;
            let lastBeat = 0;
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                await writer.write(value);
                received += value.length;
                const now = Date.now();
                if (now - lastBeat > 3000) {
                    lastBeat = now;
                    // 进度心跳（顺带重置 SW 空闲计时器，防止长下载期间 SW 被回收）
                    chrome.runtime.sendMessage({ type: 'STREAM_DL_PROGRESS', filename, received }).catch(() => { });
                }
            }
            await writer.close();
            writer = null;

            const file = await fh.getFile();
            if (file.size === 0) throw new Error('empty body');

            const blobUrl = URL.createObjectURL(file);
            const ok = await transferToDownloads(blobUrl, filename);
            URL.revokeObjectURL(blobUrl);
            if (ok) {
                await root.removeEntry(tmp).catch(() => { });
                return finish(true);
            }
            throw new Error('downloads 转存失败');
        } catch (e) {
            lastErr = (e && e.message) || String(e);
            console.warn('[bdl-stream] 候选地址失败:', lastErr, url.slice(0, 80));
            try { if (writer) await writer.abort(); } catch (_) { }
            await root.removeEntry(tmp).catch(() => { });
        }
    }
    finish(false, lastErr || 'all-candidates-failed');

    function finish(ok, error) {
        send({ type: 'STREAM_DL_RESULT', filename, ok, error });
    }
}

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
    // SW 负责关闭本页；若 SW 已不在，5 秒后自兜底关闭（仅 RESULT 时触发）
    if (msg && msg.type === 'STREAM_DL_RESULT') {
        setTimeout(() => { try { window.close(); } catch (e) { } }, 5000);
    }
}
