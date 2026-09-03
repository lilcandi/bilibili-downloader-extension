// B站下载助手 - 内容脚本
// 在视频页工具栏（点赞/投币/收藏/转发）旁注入下载按钮：
//   - 点击主体：按上次选择的画质（默认最高）直接下载
//   - 点击 ▾  : 打开画质选择面板（数据来自 DASH 接口，只列当前账号有权限的画质）
// API 请求在页面环境中发起（Origin 为 www.bilibili.com，带登录 Cookie），
// 后台 service worker 直接请求会被 B 站风控返回 HTML 错误页。
//
// 画质说明：
//   - DASH 模式（fnval=4048）：可下载账号可用的全部画质（大会员可用 1080P 高码率/4K/HDR 等），
//     但视频、音频分离，需 ffmpeg 合并（命令自动复制）
//   - MP4 模式（platform=html5）：单文件免合并，上限 720P/1080P

(() => {
    'use strict';

    const BTN_ID = 'bili-dl-ext-btn';
    const PANEL_ID = 'bili-dl-ext-panel';
    const TAG = '[b抖下载器]';
    const LS_KEY = 'biliDlExtQuality';

    // ---------- 平台识别：B站 / 抖音 ----------
    function isBiliPage() {
        return /bilibili\.com$/.test(location.hostname) && /\/video\/[a-zA-Z0-9]+/.test(location.pathname);
    }
    function isDouyinPage() {
        return /(^|\.)douyin\.com$/.test(location.hostname) && isDouyinVideo();
    }
    function isDouyinVideo() {
        return /\/video\/\d+/.test(location.pathname) ||
               /\/note\/\d+/.test(location.pathname) ||
               /modal_id=\d+/.test(location.search);
    }
    const PLATFORM = isBiliPage() ? 'bili' : isDouyinPage() ? 'douyin' : 'none';

    const CSS = `
        #${BTN_ID} {
            display: inline-flex;
            align-items: stretch;
            height: 34px;
            padding: 0;
            margin: 0 4px;
            background: #fb7299;
            color: #fff;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            line-height: 1;
            cursor: pointer;
            white-space: nowrap;
            transition: background-color .2s, opacity .2s;
            overflow: hidden;
        }
        #${BTN_ID}:hover { background: #ec5e8b; }
        #${BTN_ID}:active { transform: scale(.96); }
        #${BTN_ID}:disabled { opacity: .6; cursor: wait; }
        #${BTN_ID} svg { width: 16px; height: 16px; fill: currentColor; }
        #${BTN_ID} .bili-dl-ext-main {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 0 10px 0 14px;
        }
        /* 箭头区域：整高、约 30px 宽的独立点击区，带分隔线 */
        #${BTN_ID} .bili-dl-ext-arrow {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            align-self: stretch;
            min-width: 30px;
            font-size: 10px;
            opacity: .9;
            border-left: 1px solid rgba(255,255,255,.4);
        }
        #${BTN_ID} .bili-dl-ext-arrow:hover { background: rgba(0,0,0,.12); }
        /* 抖音右侧操作栏样式：白色竖排图标+文字，与点赞/评论/分享对齐 */
        #${BTN_ID}.bili-dl-ext-douyin {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            height: auto;
            margin: 6px 0;
            padding: 0;
            background: transparent;
            border-radius: 0;
            overflow: visible;
            color: #fff;
            font-size: 14px;
            white-space: nowrap;
        }
        #${BTN_ID}.bili-dl-ext-douyin:hover { background: transparent; opacity: .85; }
        #${BTN_ID}.bili-dl-ext-douyin svg { width: 30px; height: 30px; fill: #fff; }
        #bili-dl-ext-float {
            position: fixed;
            right: 24px;
            bottom: 96px;
            z-index: 2147483647;
            height: 44px;
            padding: 0 20px;
            background: #fb7299;
            color: #fff;
            border: none;
            border-radius: 22px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(0,0,0,.25);
        }
        #bili-dl-ext-float:hover { background: #ec5e8b; }
        /* 画质选择面板 */
        #${PANEL_ID} {
            position: fixed;
            z-index: 2147483647;
            min-width: 260px;
            max-width: 320px;
            background: #fff;
            border-radius: 10px;
            box-shadow: 0 6px 24px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.04);
            padding: 8px;
            font-size: 13px;
            color: #18191c;
            font-family: inherit;
        }
        #${PANEL_ID} .bili-dl-ext-panel-title {
            font-weight: bold;
            padding: 6px 8px 8px;
        }
        #${PANEL_ID} .bili-dl-ext-opt {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 9px 10px;
            border-radius: 7px;
            cursor: pointer;
        }
        #${PANEL_ID} .bili-dl-ext-opt:hover { background: #f3f5f8; }
        #${PANEL_ID} .bili-dl-ext-opt.active { background: #ffe9f0; }
        #${PANEL_ID} .bili-dl-ext-qlabel { flex: 1; font-weight: 500; }
        #${PANEL_ID} .bili-dl-ext-opt.active .bili-dl-ext-qlabel { color: #fb7299; }
        #${PANEL_ID} .bili-dl-ext-qsize { color: #9499a0; font-size: 12px; }
        #${PANEL_ID} .bili-dl-ext-qbadge {
            font-size: 11px;
            color: #fb7299;
            border: 1px solid #fb7299;
            border-radius: 3px;
            padding: 0 4px;
            line-height: 16px;
        }
        #${PANEL_ID} .bili-dl-ext-panel-tip {
            padding: 8px 8px 4px;
            color: #9499a0;
            font-size: 11px;
            line-height: 1.5;
        }
        #${PANEL_ID} .bili-dl-ext-panel-loading {
            padding: 18px 10px;
            text-align: center;
            color: #9499a0;
        }
        #${PANEL_ID} .bili-dl-ext-extras {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 8px 10px;
            margin-top: 4px;
            border-top: 1px solid #f1f2f3;
            color: #61666d;
            user-select: none;
        }
        #${PANEL_ID} .bili-dl-ext-extras .bili-dl-ext-extras-title {
            font-size: 12px;
            color: #9499a0;
        }
        #${PANEL_ID} .bili-dl-ext-extras label {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 12px;
            cursor: pointer;
        }
        #${PANEL_ID} .bili-dl-ext-extras input[type="checkbox"] {
            accent-color: #fb7299;
            cursor: pointer;
        }
    `;

    const QUALITY_LABEL = {
        127: '8K 超高清', 126: '杜比视界', 125: 'HDR 真彩', 120: '4K 超清',
        116: '1080P 60帧', 112: '1080P 高码率', 100: '智能修复', 80: '1080P 高清',
        74: '720P 60帧', 64: '720P 高清', 32: '480P 清晰', 16: '360P 流畅'
    };

    function injectStyle() {
        if (document.getElementById('bili-dl-ext-style')) return;
        const style = document.createElement('style');
        style.id = 'bili-dl-ext-style';
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    function isVideoPage() {
        return isBiliPage() || isDouyinPage();
    }

    // 定位“转发”按钮：类名优先，文本匹配兜底
    function findShareButton() {
        const selectors = [
            '.video-toolbar-left-main .video-share',
            '.video-share',
            '[class*="video-share"]',
            '.video-share-btn',
            '.share-btn'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        const candidates = document.querySelectorAll('.video-toolbar span, .video-toolbar div, span, div');
        for (const el of candidates) {
            if (el.children.length > 2) continue;
            const text = (el.textContent || '').trim();
            if (/^(转发|分享)/.test(text) && text.length <= 8) {
                const item = el.closest('[class*="share"], [class*="toolbar"]') || el.parentElement;
                if (item) return item;
            }
        }
        return null;
    }

    function findToolbarContainer() {
        return document.querySelector(
            '.video-toolbar-left-main, .video-toolbar-left, .video-toolbar, [class*="video-toolbar"]'
        );
    }

    // 抖音右侧操作栏的“分享”项：data-e2e 锚点稳定，但类名混淆，
    // 从锚点向上找到"含多个子项的操作项容器"（与点赞/评论/收藏同级的兄弟）
    function findDouyinShareItem() {
        const icon = document.querySelector('[data-e2e="share-icon"]');
        if (!icon) return null;
        let el = icon;
        for (let i = 0; i < 6 && el.parentElement; i++) {
            el = el.parentElement;
            if (el.children.length >= 2) return el;
        }
        return icon;
    }

    function createButton() {
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.type = 'button';
        if (PLATFORM === 'douyin') {
            // 抖音：竖排白色图标按钮，与点赞/评论/分享同列同风格
            btn.classList.add('bili-dl-ext-douyin');
            btn.title = '下载当前视频（原画 MP4）';
            btn.innerHTML = `
                <svg viewBox="0 0 24 24"><path d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>
                <span class="bili-dl-ext-text">下载</span>`;
        } else {
            btn.title = '下载当前视频\n点击：按上次画质下载（默认最高）\n点右侧箭头：选择画质';
            btn.innerHTML = `
                <span class="bili-dl-ext-main">
                    <svg viewBox="0 0 24 24"><path d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>
                    <span class="bili-dl-ext-text">下载</span>
                </span>
                <span class="bili-dl-ext-arrow" title="选择画质">▼</span>`;
        }
        btn.addEventListener('click', e => {
            if (e.target.closest('.bili-dl-ext-arrow')) {
                e.preventDefault();
                e.stopPropagation();
                togglePanel(btn);
            } else {
                onMainClick(e);
            }
        }, true);
        return btn;
    }

    function injectButton() {
        if (!isVideoPage()) return;
        injectStyle();
        if (document.getElementById(BTN_ID)) return;

        // 抖音：优先插入右侧操作栏（分享按钮旁，与点赞/评论/收藏同列）
        if (PLATFORM === 'douyin') {
            const anchor = findDouyinShareItem();
            if (anchor) {
                anchor.insertAdjacentElement('afterend', createButton());
                console.log(TAG, '已注入按钮到抖音右侧操作栏');
            } else {
                showFloatFallback(); // 操作栏未渲染时兜底
            }
            return;
        }

        const share = findShareButton();
        if (share) {
            share.insertAdjacentElement('afterend', createButton());
            console.log(TAG, '已注入按钮到转发按钮旁');
            return;
        }
        const toolbar = findToolbarContainer();
        if (toolbar) {
            toolbar.appendChild(createButton());
            console.log(TAG, '已注入按钮到工具栏容器');
        }
    }

    // ---------- 数据获取（页面环境，带登录 Cookie） ----------

    const playCache = new Map(); // cid -> { fetchedAt, ... }（直链 120 分钟过期，缓存 60 分钟）
    const PLAY_CACHE_TTL = 60 * 60 * 1000;

    async function fetchJson(url) {
        const resp = await fetch(url, { credentials: 'include' });
        const text = await resp.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error(TAG, '接口返回非 JSON:', text.slice(0, 200));
            throw new Error('接口返回异常（可能触发风控，请稍后重试）');
        }
        if (data.code !== 0 || !data.data) {
            throw new Error(data.message || '接口返回错误');
        }
        return data.data;
    }

    async function getPlayInfo() {
        const bvid = location.pathname.match(/BV[\w]+|av\d+/)?.[0];
        if (!bvid) throw new Error('当前页面不是视频页');
        const page = new URLSearchParams(location.search).get('p');

        const info = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
        let cid = info.cid;
        if (page && info.pages?.length) {
            cid = (info.pages[page - 1] || info.pages[0]).cid;
        }

        if (playCache.has(cid)) {
            const cached = playCache.get(cid);
            if (Date.now() - cached.fetchedAt < PLAY_CACHE_TTL) return cached;
            playCache.delete(cid); // 直链临近过期，重新获取
        }

        const play = await fetchJson(
            `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}` +
            `&qn=0&fnver=0&fnval=4048&fourk=1&otype=json`
        );

        // 按 id 去重（同一画质可能有 hev/avc/av01 多个编码），保留码率最高的一条
        const videoMap = new Map();
        for (const v of play.dash?.video || []) {
            const prev = videoMap.get(v.id);
            if (!prev || (v.bandwidth || 0) > (prev.bandwidth || 0)) videoMap.set(v.id, v);
        }
        if (!videoMap.size && !play.durl?.length) {
            throw new Error('未获取到可用视频流');
        }

        // 音频：按音质优先级选择（Hi-Res 30251 > 杜比 30250 > 320K 30280 > 128K 30232）。
        // 不能按 id 数值排序：Hi-Res/杜比的 id 反而比 320K 小。
        // Hi-Res 在 dash.flac、杜比在 dash.dolby.audio，普通音质在 dash.audio。
        const AUDIO_RANK = { 30251: 50, 30250: 40, 30280: 30, 30232: 20, 30216: 10 };
        const flac = play.dash?.flac;
        const audio = [
            ...(play.dash?.audio || []),
            ...(play.dash?.dolby?.audio || []),
            ...(Array.isArray(flac?.audio) ? flac.audio : flac ? [flac] : [])
        ].sort((a, b) =>
            (AUDIO_RANK[b.id] || b.id || 0) - (AUDIO_RANK[a.id] || a.id || 0) ||
            (b.bandwidth || 0) - (a.bandwidth || 0)
        )[0] || null;

        const entry = {
            fetchedAt: Date.now(),
            bvid,
            cid,
            title: info.title || 'Bilibili_Video',
            page,
            multiPage: (info.pages?.length || 1) > 1,
            timelength: play.timelength || 0,
            videoMap,
            audio,
            durl: play.durl || null
        };
        playCache.set(cid, entry);
        return entry;
    }

    // ---------- 下载流程 ----------

    function getSavedChoice() {
        try { return localStorage.getItem(LS_KEY); } catch (e) { return null; }
    }

    function saveChoice(key) {
        try { localStorage.setItem(LS_KEY, key); } catch (e) { /* 忽略 */ }
    }

    function normalizeBackups(stream) {
        const b = stream?.backup_url;
        if (!b) return [];
        return Array.isArray(b) ? b : [b];
    }

    // P2P/边缘节点（mcdn、第三方域名）在浏览器直连经常失败，
    // 把常规 CDN 域名（bilivideo.com/.cn、akamaized）排到前面（允许带端口，如 mcdn 的 :8082）
    const coveredHost = u => /^https:\/\/([\w-]+\.)*(bilivideo\.com|bilivideo\.cn|akamaized\.net)(:\d+)?\//.test(u);
    function orderUrls(stream) {
        const urls = [stream.base_url, ...normalizeBackups(stream)];
        return urls.sort((a, b) => (coveredHost(b) ? 1 : 0) - (coveredHost(a) ? 1 : 0));
    }

    function baseName(info, label) {
        let name = info.title;
        // 多 P 视频：未带 ?p= 参数时默认 P1，避免连续下载不同 P 时文件重名
        if (info.multiPage) name += `-P${info.page ? +info.page : 1}`;
        if (label) name += `[${label}]`;
        return sanitize(name);
    }

    function sanitize(name) {
        return (name || 'Bilibili_Video').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    function fmtSize(bitsPerSec, ms) {
        if (!bitsPerSec || !ms) return '';
        const bytes = bitsPerSec / 8 * (ms / 1000);
        return bytes >= 1 << 30 ? `≈${(bytes / (1 << 30)).toFixed(1)}GB` : `≈${Math.round(bytes / (1 << 20))}MB`;
    }

    let busy = false;

    async function withStatus(btn, fn) {
        if (busy) return;
        busy = true;
        const label = btn.querySelector('.bili-dl-ext-text');
        const original = label.textContent;
        btn.disabled = true;
        try {
            label.textContent = '解析中…';
            await fn(label);
        } catch (err) {
            console.error(TAG, err);
            alert('下载失败：' + err.message);
            label.textContent = original;
        } finally {
            btn.disabled = false;
            busy = false;
            setTimeout(() => {
                if (label.textContent !== original) label.textContent = original;
            }, 3000);
        }
    }

    async function onMainClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        closePanel();
        await withStatus(btn, async label => {
            // 抖音：直接下载原画 MP4（免合并、无字幕/弹幕）
            if (PLATFORM === 'douyin') {
                const info = await getDouyinInfo();
                await downloadDouyin(info, label);
                return;
            }
            const info = await getPlayInfo();
            const ids = [...info.videoMap.keys()].sort((a, b) => b - a);
            if (!ids.length) return downloadMp4(info, label);

            let choice = getSavedChoice();
            if (!choice || (choice.startsWith('dash:') && !info.videoMap.has(+choice.split(':')[1]))) {
                choice = `dash:${ids[0]}`; // 默认/失效画质回退：最高可用
            }
            await executeChoice(choice, info, label);
        });
    }

    async function executeChoice(key, info, label) {
        saveChoice(key);
        if (key === 'mp4') return downloadMp4(info, label);

        const qid = +key.split(':')[1];
        const video = info.videoMap.get(qid);
        if (!video) throw new Error('该画质在当前视频不可用');
        if (!info.audio) throw new Error('未找到音频流');

        const qLabel = QUALITY_LABEL[qid] || `${qid}P`;
        const base = baseName(info, qLabel);
        const mergedName = `${base}.mp4`;

        // 体积估算（bandwidth 为 bit/s）。浏览器内合并的峰值内存约为文件体积的 3 倍：
        // fetchStream 的 chunks + 拼接副本（2x），以及 ffmpeg MEMFS 中的输入+输出，
        // 实测 600MB 以上就可能 OOM，超过时自动回退为"分别下载两个文件 + ffmpeg 命令"
        const estBytes = ((video.bandwidth || 0) + (info.audio.bandwidth || 0)) / 8 * (info.timelength / 1000);
        if (estBytes > 600 * (1 << 20)) {
            const videoName = `${base}[仅视频].mp4`;
            const audioName = `${base}[仅音频].m4a`;
            await sendDownload(orderUrls(video), videoName);
            await sendDownload(orderUrls(info.audio), audioName);
            const cmd = `ffmpeg -i "${videoName}" -i "${audioName}" -c copy "${mergedName}"`;
            console.log(TAG, 'ffmpeg 合并命令:\n' + cmd);
            try { navigator.clipboard.writeText(cmd).catch(() => {}); } catch (e) { /* 忽略 */ }
            label.textContent = `已开始下载 ${qLabel} ✓`;
            saveExtras(info);
            alert(`「${qLabel}」体积约 ${fmtSize(video.bandwidth, info.timelength)}，超出浏览器内合并上限（约 600MB），
已改为分别下载视频、音频两个文件，合并命令已复制到剪贴板（F12 控制台也可查看）。`);
            return;
        }

        // 默认：浏览器内合并（打开合并标签页，自动下载→合并→保存）
        await sendMergeJob({
            label: qLabel,
            filename: mergedName,
            video: { urls: orderUrls(video) },
            audio: { urls: orderUrls(info.audio) }
        });
        label.textContent = `合并下载已开始 ${qLabel} ✓`;
        saveExtras(info);
    }

    function sendMergeJob(job) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'MERGE_JOB', job }, resp => {
                if (chrome.runtime.lastError) {
                    console.error(TAG, chrome.runtime.lastError.message);
                    return reject(new Error('无法连接扩展后台，请重新加载扩展'));
                }
                if (resp && resp.ok) resolve(resp);
                else reject(new Error(resp?.error || '合并任务发起失败'));
            });
        });
    }

    // MP4 单文件模式（免合并，画质由 B 站 html5 接口决定，上限 720P/1080P）
    async function downloadMp4(info, label) {
        const play = await fetchJson(
            `https://api.bilibili.com/x/player/playurl?bvid=${info.bvid}&cid=${info.cid}` +
            `&qn=80&fnver=0&fnval=0&fourk=1&otype=json&type=mp4&platform=html5&high_quality=1`
        );
        if (!play.durl?.length) throw new Error('未获取到 MP4 播放地址（大会员/付费视频需登录后再试）');

        const qLabel = QUALITY_LABEL[play.quality] || `${play.quality}P`;
        const base = baseName(info, `MP4-${qLabel}`);
        const segments = play.durl;
        for (let i = 0; i < segments.length; i++) {
            const suffix = segments.length > 1 ? `(${i + 1}of${segments.length})` : '';
            const name = `${base}${suffix}.mp4`;
            await sendDownload(orderUrls(segments[i]), name);
        }
        label.textContent = `已开始下载 MP4 ${qLabel} ✓`;
        saveExtras(info);
    }

    function sendDownload(urls, filename) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', urls, filename }, resp => {
                if (chrome.runtime.lastError) {
                    console.error(TAG, chrome.runtime.lastError.message);
                    return reject(new Error('无法连接扩展后台，请重新加载扩展'));
                }
                if (resp && resp.ok) resolve(resp);
                else reject(new Error(resp?.error || '浏览器下载启动失败'));
            });
        });
    }

    // ---------- 字幕 / 弹幕附加保存 ----------

    const EXTRAS_KEY = 'biliDlExtExtras';

    function getExtras() {
        try { return JSON.parse(localStorage.getItem(EXTRAS_KEY)) || {}; } catch (e) { return {}; }
    }

    function saveExtrasPref(extras) {
        try { localStorage.setItem(EXTRAS_KEY, JSON.stringify(extras)); } catch (e) { /* 忽略 */ }
    }

    function utf8ToBase64(text) {
        const bytes = new TextEncoder().encode(text);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
    }

    // 文本内容经后台转为 data URL 下载（background 可直接下载 base64 data URL）
    function saveTextFile(text, filename) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { type: 'SAVE_TEXT', base64: utf8ToBase64(text), filename },
                resp => {
                    if (chrome.runtime.lastError) {
                        return reject(new Error('无法连接扩展后台，请重新加载扩展'));
                    }
                    if (resp && resp.ok) resolve(resp);
                    else reject(new Error(resp?.error || '文本文件保存失败'));
                }
            );
        });
    }

    // B 站字幕 JSON 的 body: [{from, to, content}] → SRT
    function subtitleToSrt(body) {
        const fmt = sec => {
            const ms = Math.round(sec * 1000);
            const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
            const m = String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0');
            const s = String(Math.floor(ms % 60000 / 1000)).padStart(2, '0');
            return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
        };
        return body.map((item, i) =>
            `${i + 1}\n${fmt(item.from)} --> ${fmt(item.to)}\n${item.content}`
        ).join('\n\n') + '\n';
    }

    async function downloadSubtitle(info, baseNameNoLabel) {
        // player/wbi/v2 需登录 Cookie 才返回字幕列表，subtitle_url 有时效，需实时获取
        const player = await fetchJson(
            `https://api.bilibili.com/x/player/wbi/v2?bvid=${info.bvid}&cid=${info.cid}`
        );
        const subs = player?.subtitle?.subtitles || [];
        if (!subs.length) {
            console.warn(TAG, '该视频无可用字幕（未登录或未生成字幕）');
            return;
        }
        // 优先中文轨道（ai-zh / zh-Hans / zh-CN），其次第一条
        const zh = subs.find(s => /^zh/i.test(s.lan)) || subs[0];
        let url = zh.subtitle_url || '';
        if (!url) throw new Error('字幕地址为空');
        if (url.startsWith('//')) url = 'https:' + url;

        const sub = await fetchJson(url);
        if (!sub?.body?.length) throw new Error('字幕内容为空');
        await saveTextFile(subtitleToSrt(sub.body), `${baseNameNoLabel}.srt`);
        console.log(TAG, `字幕已保存：${zh.lan_doc}，共 ${sub.body.length} 条`);
    }

    async function downloadDanmaku(info, baseNameNoLabel) {
        // 实时弹幕池（XML 格式，播放器/弹幕工具通用）；fetch 自动处理 deflate 解压
        const resp = await fetch(`https://comment.bilibili.com/${info.cid}.xml`, { credentials: 'include' });
        if (!resp.ok) throw new Error('弹幕接口 HTTP ' + resp.status);
        const xml = await resp.text();
        if (!/<d\s/.test(xml)) {
            console.warn(TAG, '该视频弹幕池为空或弹幕已关闭');
            return;
        }
        await saveTextFile(xml, `${baseNameNoLabel}.xml`);
        const count = (xml.match(/<d\s/g) || []).length;
        console.log(TAG, `弹幕已保存：共 ${count} 条`);
    }

    // 附加内容总入口：字幕/弹幕保存失败不影响主下载，仅在控制台提示
    function saveExtras(info) {
        const extras = getExtras();
        if (!extras.subtitle && !extras.danmaku) return;
        const base = baseName(info); // 不带画质标签，字幕/弹幕与画质无关
        if (extras.subtitle) {
            downloadSubtitle(info, base).catch(e => console.warn(TAG, '字幕保存失败：', e.message));
        }
        if (extras.danmaku) {
            downloadDanmaku(info, base).catch(e => console.warn(TAG, '弹幕保存失败：', e.message));
        }
    }

    // ---------- 抖音：解析 + 下载（单文件 MP4，无需合并） ----------

    // 递归收集页面嵌入式数据中的 play_addr（每个含 url_list 数组）
    function collectDouyinPlayAddrs(obj) {
        const out = [];
        (function walk(o) {
            if (!o) return;
            if (Array.isArray(o)) { o.forEach(walk); return; }
            if (typeof o === 'object') {
                if (o.play_addr && Array.isArray(o.play_addr.url_list) && o.play_addr.url_list.length) {
                    out.push(o.play_addr);
                }
                Object.keys(o).forEach(k => walk(o[k]));
            }
        })(obj);
        return out;
    }

    function absoluteUrl(u) {
        if (!u) return '';
        return u.startsWith('//') ? 'https:' + u : u;
    }

    function getDouyinTitle() {
        const og = document.querySelector('meta[property="og:title"]')?.content;
        if (og && og.trim()) return og.trim();
        const t = document.title.replace(/\s*[-–—_].*$/, '').trim();
        return t || 'douyin_video';
    }

    async function getDouyinInfo() {
        const urls = [];
        const title = getDouyinTitle();

        // 策略1：<script id="RENDER_DATA">（URL 编码的 SSR JSON，含 aweme_detail.video.play_addr）
        const render = document.querySelector('script#RENDER_DATA');
        if (render && render.textContent) {
            try {
                const data = JSON.parse(decodeURIComponent(render.textContent));
                collectDouyinPlayAddrs(data).forEach(pa =>
                    pa.url_list.forEach(u => { const a = absoluteUrl(u); if (a && !urls.includes(a)) urls.push(a); })
                );
            } catch (e) {
                console.warn(TAG, '抖音源码解析失败:', e.message);
            }
        }

        // 策略2：页面上已加载的 <video> 元素真实地址
        if (!urls.length) {
            const v = document.querySelector('video');
            const src = (v && (v.currentSrc || v.src)) || '';
            if (src.startsWith('http')) urls.push(src);
        }

        // 策略3：全页面脚本中匹配 "playAddr":[...] 里的 http 地址（处理 \u002f 转义）
        if (!urls.length) {
            document.querySelectorAll('script').forEach(s => {
                const m = (s.textContent || '').match(/"playAddr"\s*:\s*\[([^\]]*)\]/);
                if (!m) return;
                m[1].match(/https?:\/\/[^"\\,\]]+|\\u002f\\u002f[^"\\,\]]+/g).forEach(u => {
                    const a = u.startsWith('http') ? u : absoluteUrl('//' + u);
                    const clean = a.replace(/\\u002f/g, '/');
                    if (clean.startsWith('http') && !urls.includes(clean)) urls.push(clean);
                });
            });
        }

        if (!urls.length) throw new Error('未能获取视频播放地址，请等待页面加载完成后再试');
        return { title, urls };
    }

    async function downloadDouyin(info, label) {
        const name = sanitize(info.title) + '.mp4';
        await sendDownload(info.urls, name);
        label.textContent = '已开始下载抖音视频 ✓';
    }

    // ---------- 画质选择面板 ----------

    function togglePanel(btn) {
        if (document.getElementById(PANEL_ID)) { closePanel(); return; }
        openPanel(btn);
    }

    async function openPanel(btn) {
        closePanel();
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `<div class="bili-dl-ext-panel-loading">正在获取画质列表…</div>`;
        document.body.appendChild(panel);
        positionPanel(panel, btn);

        let info;
        try {
            info = PLATFORM === 'douyin' ? await getDouyinInfo() : await getPlayInfo();
        } catch (err) {
            console.error(TAG, err);
            panel.innerHTML = `<div class="bili-dl-ext-panel-loading">获取失败：${err.message}</div>`;
            setTimeout(closePanel, 2500);
            return;
        }
        if (!document.getElementById(PANEL_ID)) return; // 面板已被关闭

        // 抖音面板：单文件 MP4，无画质列表/字幕/弹幕
        if (PLATFORM === 'douyin') {
            panel.innerHTML = `
                <div class="bili-dl-ext-panel-title">抖音下载</div>
                <div class="bili-dl-ext-opt active" data-key="douyin-main">
                    <span class="bili-dl-ext-qlabel">视频 MP4（原画）</span>
                    <span class="bili-dl-ext-qbadge">单文件</span>
                </div>
                <div class="bili-dl-ext-panel-tip">抖音视频为单文件 MP4，直接保存到下载目录。若获取失败请刷新页面重试。</div>`;
            positionPanel(panel, btn);
            panel.addEventListener('click', e => {
                const opt = e.target.closest('.bili-dl-ext-opt');
                if (!opt) return;
                closePanel();
                withStatus(btn, async label => { await downloadDouyin(info, label); });
            });
            bindPanelDismiss(panel);
            return;
        }

        const ids = [...info.videoMap.keys()].sort((a, b) => b - a);
        const saved = getSavedChoice();
        const extras = getExtras();

        let html = `<div class="bili-dl-ext-panel-title">选择画质</div>`;
        for (const id of ids) {
            const v = info.videoMap.get(id);
            const size = fmtSize(v.bandwidth, info.timelength);
            const active = saved === `dash:${id}` ? ' active' : '';
            html += `
                <div class="bili-dl-ext-opt${active}" data-key="dash:${id}">
                    <span class="bili-dl-ext-qlabel">${QUALITY_LABEL[id] || id + 'P'}</span>
                    ${size ? `<span class="bili-dl-ext-qsize">${size}</span>` : ''}
                    <span class="bili-dl-ext-qbadge">DASH</span>
                </div>`;
        }
        html += `
            <div class="bili-dl-ext-opt${saved === 'mp4' ? ' active' : ''}" data-key="mp4">
                <span class="bili-dl-ext-qlabel">MP4 单文件</span>
                <span class="bili-dl-ext-qbadge">免合并</span>
            </div>
            <div class="bili-dl-ext-extras">
                <span class="bili-dl-ext-extras-title">同时保存</span>
                <label><input type="checkbox" data-extra="subtitle"${extras.subtitle ? ' checked' : ''}>字幕 .srt</label>
                <label><input type="checkbox" data-extra="danmaku"${extras.danmaku ? ' checked' : ''}>弹幕 .xml</label>
            </div>
            <div class="bili-dl-ext-panel-tip">DASH 画质音视分离，超过 600MB 自动回退双文件下载；MP4 单文件上限 720P/1080P。字幕/弹幕随下载自动保存（字幕需登录）。</div>`;
        panel.innerHTML = html;
        positionPanel(panel, btn);

        // 开关状态即时保存
        panel.querySelectorAll('input[data-extra]').forEach(cb => {
            cb.addEventListener('change', () => {
                const cur = getExtras();
                cur[cb.dataset.extra] = cb.checked;
                saveExtrasPref(cur);
            });
        });

        panel.addEventListener('click', e => {
            const opt = e.target.closest('.bili-dl-ext-opt');
            if (!opt) return;
            closePanel();
            withStatus(btn, async label => {
                await executeChoice(opt.dataset.key, info, label);
            });
        });

        // 外部点击 / 滚动 / Esc 关闭
        setTimeout(() => {
            document.addEventListener('pointerdown', onOutside, true);
            document.addEventListener('scroll', closePanel, true);
            document.addEventListener('keydown', onEsc, true);
        });
        function onOutside(e) {
            // 点在下载按钮上时交给按钮自己的 click 处理（toggle），否则会先关后开
            if (!panel.contains(e.target) && !e.target.closest(`#${BTN_ID}`)) closePanel();
        }
        function onEsc(e) { if (e.key === 'Escape') closePanel(); }
        panel._cleanup = () => {
            document.removeEventListener('pointerdown', onOutside, true);
            document.removeEventListener('scroll', closePanel, true);
            document.removeEventListener('keydown', onEsc, true);
        };
    }

    function positionPanel(panel, btn) {
        const arrow = btn.querySelector('.bili-dl-ext-arrow');
        const rect = (arrow || btn).getBoundingClientRect();
        const w = panel.offsetWidth || 280;
        const h = panel.offsetHeight || 200;
        let left = Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8);
        let top = rect.bottom + 8;
        if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 8);
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
    }

    function closePanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel._cleanup?.();
        panel.remove();
    }

    // 面板关闭监听：外部点击 / 滚动 / Esc
    function bindPanelDismiss(panel) {
        setTimeout(() => {
            document.addEventListener('pointerdown', onOutside, true);
            document.addEventListener('scroll', closePanel, true);
            document.addEventListener('keydown', onEsc, true);
        });
        function onOutside(e) {
            if (!panel.contains(e.target) && !e.target.closest(`#${BTN_ID}`)) closePanel();
        }
        function onEsc(e) { if (e.key === 'Escape') closePanel(); }
        panel._cleanup = () => {
            document.removeEventListener('pointerdown', onOutside, true);
            document.removeEventListener('scroll', closePanel, true);
            document.removeEventListener('keydown', onEsc, true);
        };
    }

    // ---------- 浮动兜底按钮 ----------

    function showFloatFallback() {
        if (!isVideoPage() || document.getElementById(BTN_ID)) return;
        if (document.getElementById('bili-dl-ext-float')) return;
        const floatBtn = document.createElement('button');
        floatBtn.id = 'bili-dl-ext-float';
        floatBtn.textContent = '⬇ 下载视频';
        floatBtn.addEventListener('click', async e => {
            const proxy = createButton();
            proxy.style.display = 'none';
            document.body.appendChild(proxy);
            await onMainClick({ currentTarget: proxy, preventDefault() {}, stopPropagation() {} });
            proxy.remove();
        });
        document.body.appendChild(floatBtn);
        console.warn(TAG, '工具栏定位失败，已启用右下角浮动下载按钮');
    }

    // ---------- SPA 感知 ----------

    let timer = null;
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                playCache.clear();
                closePanel();
                document.getElementById(BTN_ID)?.remove();
                document.getElementById('bili-dl-ext-float')?.remove();
            }
            injectButton();
        }, 500);
    });

    function start() {
        if (!document.body) {
            setTimeout(start, 200);
            return;
        }
        observer.observe(document.body, { childList: true, subtree: true });
        console.log(TAG, '内容脚本已加载 v' + chrome.runtime.getManifest().version + ':', location.href);
        injectButton();
        setTimeout(() => {
            if (!document.getElementById(BTN_ID)) showFloatFallback();
        }, 8000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
