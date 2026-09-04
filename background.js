// B站下载助手 - 后台脚本
// 接收 content.js 解析好的直链（含备用地址），调用浏览器下载。
// 启动成功立即响应；下载中断时在后台自动切换备用地址重试。

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type === 'DOWNLOAD_FILE' && Array.isArray(request.urls) && request.urls.length) {
        downloadWithFailover(request.urls, request.filename);
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
    if (request.type === 'MERGE_JOB' && request.job) {
        // 任务交给合并页面：storage 传递 → 打开合并标签页
        chrome.storage.local.set({ mergeJob: request.job }, () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('merger.html') });
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
async function downloadWithFailover(urls, filename) {
    activeJobs++;
    startKeepAlive();
    try {
        const queue = urls.slice();
        while (queue.length) {
            const url = queue.shift();
            const started = await startDownload(url, filename);
            if (!started.ok) continue; // 启动失败（无效地址等），换下一个

            const result = await waitForDownload(started.id);
            if (result === 'complete') return;

            console.warn('[B站下载助手] 下载中断，尝试备用地址:', result, filename);
            chrome.downloads.erase({ id: started.id }).catch(() => {});
        }
        console.error('[B站下载助手] 所有地址均下载失败:', filename);
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
