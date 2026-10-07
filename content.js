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
        return /(^|\.)douyin\.com$/.test(location.hostname) && (isDouyinVideo() || isDouyinFeed());
    }
    function isDouyinVideo() {
        return /\/video\/\d+/.test(location.pathname) ||
               /\/note\/\d+/.test(location.pathname) ||
               /modal_id=\d+/.test(location.search);
    }
    // 沉浸式信息流页（推荐 /discover 等）：URL 不含 /video/，但每条视频有完整操作栏
    function isDouyinFeed() {
        return location.pathname === '/' ||
               /^\/discover\b/.test(location.pathname) ||
               /(^|[?&])recommend=1/.test(location.search);
    }
    // 按当前 URL 动态判断：抖音是 SPA，从首页/用户页点开视频只变地址不重载页面，
    // 脚本加载时的路径可能还不是视频页，不能在加载时把平台固定下来
    function getPlatform() {
        if (isBiliPage()) return 'bili';
        if (isDouyinPage()) return 'douyin';
        return 'none';
    }

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
            min-width: 44px;
            min-height: 56px;
            height: auto;
            margin: 6px 0;
            padding: 0;
            background: transparent;
            border-radius: 0;
            overflow: visible;
            color: #fff;
            font-size: 14px;
            white-space: nowrap;
            visibility: visible;
            opacity: 1;
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
        /* 合集/分P 选集区 */
        #${PANEL_ID} .bili-dl-ext-batch {
            border-top: 1px solid #f1f2f3;
            margin-top: 4px;
            padding-top: 6px;
        }
        #${PANEL_ID} .bili-dl-ext-batch-head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px 6px;
            font-size: 12px;
            color: #61666d;
            cursor: pointer;
            user-select: none;
        }
        #${PANEL_ID} .bili-dl-ext-batch-head input { accent-color: #fb7299; cursor: pointer; }
        #${PANEL_ID} .bili-dl-ext-batch-head .bili-dl-ext-batch-title {
            flex: 1;
            font-weight: 600;
            color: #18191c;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #${PANEL_ID} .bili-dl-ext-batch-head .bili-dl-ext-batch-count {
            color: #fb7299;
            font-size: 11px;
        }
        #${PANEL_ID} .bili-dl-ext-batch-list {
            max-height: 176px;
            overflow-y: auto;
            padding: 0 4px 4px;
        }
        #${PANEL_ID} .bili-dl-ext-batch-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 5px 6px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
        }
        #${PANEL_ID} .bili-dl-ext-batch-item:hover { background: #f3f5f8; }
        #${PANEL_ID} .bili-dl-ext-batch-item.cur { background: #fff5f8; }
        #${PANEL_ID} .bili-dl-ext-batch-item input {
            accent-color: #fb7299;
            cursor: pointer;
            flex: none;
        }
        #${PANEL_ID} .bili-dl-ext-batch-item .bili-dl-ext-bi-title {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #${PANEL_ID} .bili-dl-ext-batch-item .bili-dl-ext-bi-dur {
            color: #9499a0;
            font-size: 11px;
            flex: none;
        }
        #${PANEL_ID} .bili-dl-ext-batch-item .bili-dl-ext-bi-cur {
            color: #fb7299;
            font-size: 11px;
            flex: none;
        }
    `;

    const QUALITY_LABEL = {
        127: '8K 超高清', 126: '杜比视界', 125: 'HDR 真彩', 120: '4K 超清',
        116: '1080P 60帧', 112: '1080P 高码率', 100: '智能修复', 80: '1080P 高清',
        74: '720P 60帧', 64: '720P 高清', 32: '480P 清晰', 16: '360P 流畅'
    };

    // 音质标签（与 AUDIO_RANK 对应；Hi-Res/杜比的 id 数值反而更小）
    const AUDIO_LABEL = {
        30251: 'Hi-Res 无损', 30250: '杜比全景声', 30280: '320K', 30232: '128K', 30216: '64K'
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

    // 元素可见性：rect 非零 + 祖先链上无 display:none/visibility:hidden
    // （抖音页面常驻整套隐藏的旧版播放器 DOM，querySelector 极易命中不可见副本）
    function isVisibleEl(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
        }
        return true;
    }

    // 抖音操作栏锚点：改版多次（横向操作栏 video-share-icon-container /
    // 竖排侧栏 video-player-share / 更旧的 share-icon / digg-icon 等）。
    // 同名锚点可能同时存在可见与隐藏两套副本，必须选可见的那个
    const DOUYIN_ANCHOR_KEYS = [
        'video-share-icon-container',
        'video-player-share',
        'share-icon',
        'video-player-collect',
        'collect-icon',
        'video-player-digg',
        'digg-icon',
        'feed-comment-icon',
        'comment-icon'
    ];

    // 找到可见锚点后向上定位"含多个子项的操作项容器"（与点赞/评论/分享同级）
    // scope：信息流页传入 feed 项元素（只在该项内找，避免命中相邻视频的锚点）
    function findDouyinAnchor(scope) {
        const root = scope || document;
        for (const key of DOUYIN_ANCHOR_KEYS) {
            for (const icon of root.querySelectorAll(`[data-e2e="${key}"]`)) {
                if (!isVisibleEl(icon)) continue;
                let el = icon;
                for (let i = 0; i < 6 && el.parentElement; i++) {
                    el = el.parentElement;
                    if (el.children.length >= 2 && isVisibleEl(el)) return el;
                }
                return icon;
            }
        }
        return null;
    }

    function createButton() {
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.type = 'button';
        if (getPlatform() === 'douyin') {
            // 抖音：竖排白色图标按钮，与点赞/评论/分享同列同风格
            btn.classList.add('bili-dl-ext-douyin');
            btn.title = '下载当前作品（视频原画 MP4 / 图集）';
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

        // 抖音：详情页单按钮；信息流页每个 feed 项的操作栏各一个按钮
        // （上下滑切换视频后新项自带按钮；直播卡片项无视频数据，跳过）
        if (getPlatform() === 'douyin') {
            injectDouyin();
            return;
        }

        if (document.getElementById(BTN_ID)) return;

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
            return;
        }
        showFloatFallback(); // 工具栏定位失败（B站改版等）时兜底
    }

    // 抖音注入：详情页 scope=null（全页找锚点）；信息流页逐 feed 项注入，
    // 已注入过的项用 data 标记跳过（不能靠全局 ID 判断，feed 同时存在多个按钮）
    function injectDouyin() {
        const scopes = isDouyinFeed()
            ? [...document.querySelectorAll('[data-e2e="feed-item"]')]
            : [null];
        let injected = 0;
        for (const scope of scopes) {
            const root = scope || document;
            if (root.querySelector('[data-bili-dl-btn]')) continue; // 该项已有按钮
            // 直播卡片（feed-live）没有可下载的作品，跳过
            if (scope && scope.querySelector('[data-e2e="feed-live"]')) continue;
            const anchor = findDouyinAnchor(scope);
            if (!anchor) continue;
            const btn = createButton();
            btn.dataset.biliDlBtn = '1';
            anchor.insertAdjacentElement('afterend', btn);
            // 注入后校验：若命中隐藏副本（按钮 0×0）则撤掉
            if (!isVisibleEl(btn)) {
                btn.remove();
                continue;
            }
            injected++;
        }
        if (injected) {
            document.getElementById('bili-dl-ext-float')?.remove(); // 操作栏已渲染，撤掉浮动兜底
            console.log(TAG, `已注入 ${injected} 个下载按钮到抖音操作栏`);
        } else if (!scopes.length || scopes.some(s => s === null)) {
            showFloatFallback(); // 信息流/操作栏未渲染时兜底
        } else {
            document.getElementById('bili-dl-ext-float')?.remove(); // feed 项存在但都是直播卡片，不兜底
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

    // 用 bvid+cid 拉取 playurl 并组装下载信息（当前视频与合集/分P 批量下载共用）
    async function buildPlayInfo({ bvid, cid, title, page, multiPage }) {
        if (playCache.has(cid)) {
            const cached = playCache.get(cid);
            if (Date.now() - cached.fetchedAt < PLAY_CACHE_TTL) {
                return { ...cached, bvid, title: title || cached.title, page, multiPage: !!multiPage };
            }
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
        // B站音频字段形态不一：dash.audio 为数组；dolby.audio 为数组或 null；
        // flac 为 {display, audio}，其 audio 是单个对象（Hi-Res）或 null。统一归一化为数组，
        // 避免把无 base_url 的包装对象误当音轨（曾导致大会员下载 Hi-Res 视频时音频流取错）
        const asList = x => Array.isArray(x) ? x : x ? [x] : [];
        // 全部候选音质按优先级排序（仅音频下载会逐条列出），audio 取最优一条
        const audioList = [
            ...asList(play.dash?.audio),
            ...asList(play.dash?.dolby?.audio),
            ...asList(play.dash?.flac?.audio)
        ].sort((a, b) =>
            (AUDIO_RANK[b.id] || b.id || 0) - (AUDIO_RANK[a.id] || a.id || 0) ||
            (b.bandwidth || 0) - (a.bandwidth || 0)
        );

        const entry = {
            fetchedAt: Date.now(),
            bvid,
            cid,
            title: title || 'Bilibili_Video',
            page,
            multiPage: !!multiPage,
            timelength: play.timelength || 0,
            videoMap,
            audio: audioList[0] || null,
            audioList,
            durl: play.durl || null
        };
        playCache.set(cid, entry);
        return entry;
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

        const entry = await buildPlayInfo({
            bvid,
            cid,
            title: info.title || 'Bilibili_Video',
            page,
            multiPage: (info.pages?.length || 1) > 1
        });
        // 合集/分P 元信息（面板展示与批量下载用）
        entry.pages = info.pages || null;
        entry.ugcSeason = info.ugc_season || null;
        return entry;
    }

    // 合集/分P 列表 → 批量候选项；无合集且非多P 时返回 null
    function listBatchItems(info) {
        const season = info.ugcSeason;
        if (season?.sections?.length) {
            const items = [];
            for (const sec of season.sections) {
                for (const ep of sec.episodes || []) {
                    if (!ep?.bvid) continue;
                    items.push({
                        bvid: ep.bvid,
                        cid: ep.cid || null,
                        title: ep.title || ep.arc?.title || '视频',
                        page: null,
                        multiPage: false,
                        duration: ep.arc?.duration || 0
                    });
                }
            }
            if (items.length) return { kind: 'season', title: season.title || '合集', items };
        }
        if (info.pages?.length > 1) {
            return {
                kind: 'pages',
                title: '本视频分P',
                items: info.pages.map(p => ({
                    bvid: info.bvid,
                    cid: p.cid,
                    title: p.part || `P${p.page}`,
                    page: p.page,
                    multiPage: true,
                    duration: p.duration || 0
                }))
            };
        }
        return null;
    }

    // 批量条目 → 下载信息（合集条目可能缺 cid，按 bvid 补查）
    async function resolveBatchItem(it, key) {
        let { cid, title } = it;
        if (!cid) {
            const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${it.bvid}`);
            cid = view.cid;
            if (!title) title = view.title;
        }
        if (key === 'mp4') return { bvid: it.bvid, cid, title, page: it.page, multiPage: it.multiPage };
        return buildPlayInfo({ bvid: it.bvid, cid, title, page: it.page, multiPage: it.multiPage });
    }

    // 批量下载（合集/分P）：逐个解析直链并按所选画质下载；串行 + 间隔，避免风控与多开合并
    async function batchDownload(items, key, label) {
        const total = items.length;
        let ok = 0, fail = 0;
        for (let i = 0; i < total; i++) {
            const it = items[i];
            const tag = `${it.page ? `P${it.page}` : it.title}`;
            label.textContent = `批量 ${i + 1}/${total}：${tag.slice(0, 12)}`;
            try {
                console.log(TAG, `批量 [${i + 1}/${total}] 开始：${tag}`);
                const info = await resolveBatchItem(it, key);
                console.log(TAG, `批量 [${i + 1}/${total}] 解析完成：${tag}`, `画质数=${info.videoMap?.size || 0}`);
                await executeChoice(key, info, label, { quiet: true, waitMerge: true });
                console.log(TAG, `批量 [${i + 1}/${total}] 完成：${tag}`);
                ok++;
            } catch (e) {
                fail++;
                console.warn(TAG, `批量下载失败（${tag}）：`, e.message);
            }
            if (i < total - 1) await new Promise(r => setTimeout(r, 1200));
        }
        label.textContent = `批量完成 ${ok}/${total} ✓`;
        if (fail) alert(`批量下载结束：成功 ${ok} 个，失败 ${fail} 个（失败详情见 F12 控制台）。`);
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
    // 候选顺序分三档：常规 https CDN（upos-*、akamaized）→ 其他 https 域名 →
    // mcdn P2P 节点与非 https 地址（mcdn 不校验 Referer 但给长时间拉流容易卡死，垫底）。
    // mcdn 虽被排后仍保留在列表里：downloads 通道与逐块重试轮换都会用到它。
    const HOST_RE = /^https?:\/\/([^/]+)\//;
    const regularHost = host => /(^|\.)upos-[a-z0-9-]+\.(bilivideo\.com|bilivideo\.cn|akamaized\.net)$/.test(host);
    const mcdnHost = host => /(^|\.)mcdn\.(bilivideo\.com|bilivideo\.cn)$/.test(host);
    function tierOf(u) {
        const m = HOST_RE.exec(u);
        if (!m) return 3;
        const host = m[1].toLowerCase().split(':')[0]; // 去掉端口（mcdn 常带 :8082）
        const https = u.startsWith('https:');
        if (regularHost(host)) return https ? 0 : 2;
        if (mcdnHost(host)) return https ? 2 : 3;
        return https ? 1 : 3;
    }
    function orderUrls(stream) {
        const urls = [stream.base_url, ...normalizeBackups(stream)];
        return urls.sort((a, b) => tierOf(a) - tierOf(b));
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

    // B 站 SPA 常重渲染工具栏，把我们的按钮换成新元素（面板打开/鼠标交互期间很常见）。
    // 长任务（批量下载）期间闭包里的 btn 可能已脱离 DOM，文字要写到"当前活着的按钮"上。
    function liveLabelProxy(fallbackEl) {
        const find = () => document.getElementById(BTN_ID)?.querySelector('.bili-dl-ext-text') || fallbackEl;
        return {
            get textContent() { return find().textContent; },
            set textContent(v) { find().textContent = v; }
        };
    }

    async function withStatus(btn, fn) {
        if (busy) return;
        busy = true;
        const label = liveLabelProxy(btn.querySelector('.bili-dl-ext-text'));
        const original = label.textContent;
        btn.disabled = true;
        try {
            label.textContent = '解析中…';
            await fn(label);
        } catch (err) {
            console.error(TAG, '任务失败:', err && (err.stack || err.message || err));
            try { alert('下载失败：' + (err && err.message || err)); } catch (e) { /* 忽略 */ }
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
            // 抖音：直接下载原画 MP4（免合并、无字幕/弹幕）。
            // 信息流页把按钮所在 feed 项的位置带给后台，精确解析点击的那一条
            if (getPlatform() === 'douyin') {
                const item = btn.closest('[data-e2e="feed-item"]');
                const nearTop = item ? item.getBoundingClientRect().top : undefined;
                const info = await getDouyinInfo(nearTop);
                await downloadDouyin(info, label);
                return;
            }
            const info = await getPlayInfo();
            const ids = [...info.videoMap.keys()].sort((a, b) => b - a);
            if (!ids.length) return downloadMp4(info, label);

            let choice = getSavedChoice();
            if (!choice ||
                (choice.startsWith('dash:') && !info.videoMap.has(+choice.split(':')[1])) ||
                (choice.startsWith('audio:') && !(info.audioList || []).some(a => a.id === +choice.split(':')[1]))) {
                choice = `dash:${ids[0]}`; // 默认/失效画质回退：最高可用
            }
            await executeChoice(choice, info, label);
        });
    }

    // 等待合并标签页回报结果（批量下载用：等上一个合并完成再开下一个，避免多开占内存）
    function waitMergeDone(filename, timeoutMs = 30 * 60 * 1000) {
        return new Promise(resolve => {
            const handler = msg => {
                if (msg?.type === 'MERGE_DONE' && msg.filename === filename) {
                    chrome.runtime.onMessage.removeListener(handler);
                    clearTimeout(timer);
                    resolve(!!msg.ok);
                }
            };
            const timer = setTimeout(() => {
                chrome.runtime.onMessage.removeListener(handler);
                resolve(false); // 超时按失败处理，不阻塞后续条目
            }, timeoutMs);
            chrome.runtime.onMessage.addListener(handler);
        });
    }

    // 等待某文件下载通道全部结束（双文件模式批量用；downloads 直连的完成不广播，故仅流式通道会收到）
    function waitDownloadDone(filename, timeoutMs = 4 * 60 * 60 * 1000) {
        return new Promise(resolve => {
            const handler = msg => {
                if (msg?.type === 'DOWNLOAD_DONE' && msg.filename === filename) {
                    chrome.runtime.onMessage.removeListener(handler);
                    clearTimeout(timer);
                    resolve(!!msg.ok);
                }
            };
            const timer = setTimeout(() => {
                chrome.runtime.onMessage.removeListener(handler);
                resolve(true); // 超时不再等（可能走的是 downloads 直连，无广播）
            }, timeoutMs);
            chrome.runtime.onMessage.addListener(handler);
        });
    }

    async function executeChoice(key, info, label, { quiet = false, waitMerge = false } = {}) {
        saveChoice(key);
        if (key === 'mp4') return downloadMp4(info, label, quiet);
        if (key.startsWith('audio')) return downloadAudioOnly(key, info, label, quiet);

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
        // 字幕/弹幕先行获取：勾选且获取成功才封装进视频，失败/无字幕自动退回不封装
        const subtitle = await fetchSubtitleSrt(info);
        const danmaku = await fetchDanmakuXml(info);

        if (estBytes > 600 * (1 << 20)) {
            const videoName = `${base}[仅视频].mp4`;
            const audioName = `${base}[仅音频].m4a`;
            let cmd = `ffmpeg -i "${videoName}" -i "${audioName}"`;
            if (subtitle) cmd += ` -i "${subtitle.filename}" -c:s mov_text -metadata:s:s:0 language=chi`;
            cmd += ` -c copy "${mergedName}" && del "${videoName}" "${audioName}"`;
            await sendDownload(orderUrls(video), videoName, cmd, quiet);
            await sendDownload(orderUrls(info.audio), audioName, cmd, quiet);
            saveExtrasData(subtitle, danmaku);
            console.log(TAG, 'ffmpeg 合并命令:\n' + cmd);
            if (!quiet) {
                try { navigator.clipboard.writeText(cmd).catch(() => {}); } catch (e) { /* 忽略 */ }
                label.textContent = `已开始下载 ${qLabel} ✓`;
                alert(`「${qLabel}」体积约 ${fmtSize(video.bandwidth, info.timelength)}，超出浏览器内合并上限（约 600MB），
已改为分别下载视频、音频两个文件（进度见弹出的下载进度页，完成后自动转入下载列表；中断会自动分块重试，失败会自动换备用地址）。下载进度页里有 ffmpeg 合并命令，可一键复制${subtitle ? '，合并成功后字幕会封装进视频' : ''}。`);
            } else if (waitMerge) {
                // 批量：等两个文件都下载完（流式通道会广播；downloads 直连无广播，超时兜底不阻塞）
                await Promise.all([waitDownloadDone(videoName), waitDownloadDone(audioName)]);
            }
            return;
        }

        // 默认：浏览器内合并（打开合并标签页，自动下载→合并→保存）
        const job = {
            label: qLabel,
            filename: mergedName,
            video: { urls: orderUrls(video) },
            audio: { urls: orderUrls(info.audio) }
        };
        if (subtitle) job.subtitle = { base64: utf8ToBase64(subtitle.srt) };
        if (quiet) job.quiet = true;
        await sendMergeJob(job);
        saveExtrasData(subtitle, danmaku);
        if (!quiet) label.textContent = `合并下载已开始 ${qLabel} ✓`;
        if (waitMerge) {
            const ok = await waitMergeDone(mergedName);
            if (!ok) throw new Error('合并未完成或失败');
        }
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
    async function downloadMp4(info, label, quiet = false) {
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
        if (!quiet) {
            label.textContent = `已开始下载 MP4 ${qLabel} ✓`;
            saveExtras(info);
        }
    }

    function sendDownload(urls, filename, mergeCmd, quiet) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', urls, filename, mergeCmd, quiet }, resp => {
                if (chrome.runtime.lastError) {
                    console.error(TAG, chrome.runtime.lastError.message);
                    return reject(new Error('无法连接扩展后台，请重新加载扩展'));
                }
                if (resp && resp.ok) resolve(resp);
                else reject(new Error(resp?.error || '浏览器下载启动失败'));
            });
        });
    }

    // 仅音频：直接保存选中的 DASH 音轨，免合并（B站音频流均为 fMP4 容器，统一存 .m4a）
    async function downloadAudioOnly(key, info, label, quiet = false) {
        const aid = key.startsWith('audio:') ? +key.split(':')[1] : null;
        const audio = aid ? (info.audioList || []).find(a => a.id === aid) : info.audio;
        if (!audio) throw new Error('未找到音频流');
        const aLabel = AUDIO_LABEL[audio.id] || String(audio.id || '音频');
        await sendDownload(orderUrls(audio), `${baseName(info, `${aLabel}音频`)}.m4a`);
        if (!quiet) {
            label.textContent = `已开始下载音频 ${aLabel} ✓`;
            saveExtras(info); // 勾选的字幕/弹幕随音频一并保存（与 MP4 单文件模式一致）
        }
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

    // 获取字幕（不落盘，遵循偏好开关）：{ srt, filename } | null；失败不抛出，仅控制台提示
    async function fetchSubtitleSrt(info) {
        const extras = getExtras();
        if (!extras.subtitle) return null;
        try {
            const base = baseName(info); // 不带画质标签，字幕与画质无关
            // player/wbi/v2 需登录 Cookie 才返回字幕列表，subtitle_url 有时效，需实时获取
            const player = await fetchJson(
                `https://api.bilibili.com/x/player/wbi/v2?bvid=${info.bvid}&cid=${info.cid}`
            );
            const subs = player?.subtitle?.subtitles || [];
            if (!subs.length) {
                console.warn(TAG, '该视频无可用字幕（未登录或未生成字幕）');
                return null;
            }
            // 优先中文轨道（ai-zh / zh-Hans / zh-CN），其次第一条
            const zh = subs.find(s => /^zh/i.test(s.lan)) || subs[0];
            let url = zh.subtitle_url || '';
            if (!url) return null;
            if (url.startsWith('//')) url = 'https:' + url;

            // 字幕 CDN 返回的是裸 JSON（{body:[...]}），没有 code/data 包装，不能用 fetchJson
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) throw new Error('字幕接口 HTTP ' + resp.status);
            const raw = await resp.json();
            const sub = raw?.body ? raw : raw?.data;
            if (!sub?.body?.length) throw new Error('字幕内容为空');
            console.log(TAG, `字幕已获取：${zh.lan_doc}，共 ${sub.body.length} 条`);
            return { srt: subtitleToSrt(sub.body), filename: `${base}.srt` };
        } catch (e) {
            console.warn(TAG, '字幕获取失败：', e.message);
            return null;
        }
    }

    // 获取实时弹幕（不落盘，遵循偏好开关）：{ xml, filename } | null
    async function fetchDanmakuXml(info) {
        const extras = getExtras();
        if (!extras.danmaku) return null;
        try {
            const base = baseName(info);
            const resp = await fetch(`https://comment.bilibili.com/${info.cid}.xml`, { credentials: 'include' });
            if (!resp.ok) throw new Error('弹幕接口 HTTP ' + resp.status);
            const xml = await resp.text();
            if (!/<d\s/.test(xml)) {
                console.warn(TAG, '该视频弹幕池为空或弹幕已关闭');
                return null;
            }
            console.log(TAG, `弹幕已获取：共 ${(xml.match(/<d\s/g) || []).length} 条`);
            return { xml, filename: `${base}.xml` };
        } catch (e) {
            console.warn(TAG, '弹幕获取失败：', e.message);
            return null;
        }
    }

    // 字幕/弹幕落盘（文本文件经后台 data URL 下载）；单边失败不影响另一边
    function saveExtrasData(subtitle, danmaku) {
        if (subtitle) {
            saveTextFile(subtitle.srt, subtitle.filename)
                .then(() => console.log(TAG, '字幕已保存：' + subtitle.filename))
                .catch(e => console.warn(TAG, '字幕保存失败：', e.message));
        }
        if (danmaku) {
            saveTextFile(danmaku.xml, danmaku.filename)
                .then(() => console.log(TAG, '弹幕已保存：' + danmaku.filename))
                .catch(e => console.warn(TAG, '弹幕保存失败：', e.message));
        }
    }

    // 附加内容总入口（MP4 单文件模式等不做封装的场景）：现取现存，失败不影响主下载
    function saveExtras(info) {
        fetchSubtitleSrt(info).then(sub => sub && saveExtrasData(sub, null));
        fetchDanmakuXml(info).then(d => d && saveExtrasData(null, d));
    }

    // ---------- 抖音：解析 + 下载 ----------

    // 策略0（最强）：直读播放器全局对象 window.player.config.awemeInfo
    // （经 background 的 scripting API 在 MAIN 世界读取）。
    // 页面打开即可用，无需先播放；带完整码率列表与图集信息。
    // 参考：douyin-dl-user-js 的 MediaHandler 同款机制。
    function getDouyinAweme(nearTop) {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({ type: 'GET_DOUYIN_AWEME', nearTop }, resp => {
                if (chrome.runtime.lastError) return resolve(null);
                resolve(resp?.ok ? resp.data : null);
            });
        });
    }

    // 从 awemeInfo 构建下载信息：码率优选（跳过 dash，按文件体积降序 = 画质最高优先），
    // H265 专线 playApiH265 与各码率 playAddr 作为回退；图集返回 images 二维 url 数组
    function buildInfoFromAweme(aw) {
        if (!aw) return null;
        const urls = [];
        if (aw.video) {
            const brs = (aw.video.bitRateList || []).filter(br => br.format !== 'dash');
            brs.sort((a, b) => (b.dataSize || 0) - (a.dataSize || 0));
            for (const br of brs) {
                if (br.playApi) urls.push(br.playApi);
                for (const src of br.playAddr || []) if (src) urls.push(src);
            }
            if (aw.video.playApi) urls.push(aw.video.playApi);
            if (aw.video.playApiH265) urls.push(aw.video.playApiH265);
        }
        const album = (aw.images || [])
            .map(list => list.map(u => absoluteUrl(u)).filter(Boolean))
            .filter(list => list.length);
        if (!urls.length && !album.length) return null;
        const title = [aw.author, aw.desc].filter(Boolean).join('_') || getDouyinTitle();
        return {
            title,
            urls: [...new Set(urls)].slice(0, 10),
            album: album.length ? album : null
        };
    }

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

    async function getDouyinInfo(nearTop) {
        const isFeed = isDouyinFeed();
        // 策略0：播放器全局对象 awemeInfo / 信息流 feed 项 slideData（最强，见 buildInfoFromAweme）。
        // nearTop：点击按钮所在 feed 项的视口位置，确保下载的是用户点的那一条
        try {
            const fromAw = buildInfoFromAweme(await getDouyinAweme(nearTop));
            if (fromAw) return fromAw;
        } catch (e) {
            console.warn(TAG, 'awemeInfo 读取失败:', e.message);
        }

        // 策略1：后台 webRequest 捕获的本页真实播放直链。
        // 抖音页面是客户端渲染，RENDER_DATA 可能缺失、<video> 的 src 常为 blob:，
        // 脚本里不一定有 playAddr；浏览器实际拉流过的地址对 SPA/未登录全部免疫
        const urls = [];
        const title = getDouyinTitle();
        try {
            const resp = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ type: 'GET_DOUYIN_STREAMS' }, resp => {
                    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                    resolve(resp);
                });
            });
            (resp?.urls || []).forEach(u => { if (!urls.includes(u)) urls.push(u); });
        } catch (e) {
            console.warn(TAG, '播放流捕获不可用:', e.message);
        }

        // 信息流页到此为止：RENDER_DATA/页面脚本里是"预加载的其他作品"，
        // 无法归属到点击的那一项，继续解析会下载到错误视频——宁可不成功不可下错
        if (isFeed && !urls.length) {
            throw new Error('未能获取该作品的下载地址（可能是直播或暂不支持的类型），请滚动到具体视频后重试');
        }

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

        // 策略3：全页面脚本中匹配 "playAddr":[...] 里的 http 地址。
        // JSON 里斜杠常被转义为 \/ 或 \u002f，先还原再匹配，否则会截断/拼出无效地址
        if (!urls.length) {
            document.querySelectorAll('script').forEach(s => {
                const m = (s.textContent || '').match(/"playAddr"\s*:\s*\[([^\]]*)\]/);
                if (!m) return;
                const plain = m[1]
                    .replace(/\\u002[fF]/g, '/')
                    .replace(/\\u0026/gi, '&')
                    .replace(/\\\//g, '/');
                plain.split(',').forEach(part => {
                    let u = part.replace(/"/g, '').trim();
                    if (u.startsWith('//')) u = 'https:' + u;
                    if (u.startsWith('http') && !urls.includes(u)) urls.push(u);
                });
            });
        }

        if (!urls.length) throw new Error('未能获取视频地址，请先播放视频几秒后再试（播放器数据不可用时扩展会捕获实际播放的直链）');
        return { title, urls };
    }

    async function downloadDouyin(info, label) {
        // 图集：逐张下载（每张带多个 CDN 地址回退）
        if (info.album) {
            const n = info.album.length;
            for (let i = 0; i < n; i++) {
                await sendDownload(info.album[i], `${sanitize(info.title)}_${i + 1}of${n}.jpg`);
            }
            label.textContent = `已开始下载图集（${n} 张）✓`;
            return;
        }
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
            info = getPlatform() === 'douyin' ? await getDouyinInfo() : await getPlayInfo();
        } catch (err) {
            console.error(TAG, err);
            panel.innerHTML = `<div class="bili-dl-ext-panel-loading">获取失败：${err.message}</div>`;
            setTimeout(closePanel, 2500);
            return;
        }
        if (!document.getElementById(PANEL_ID)) return; // 面板已被关闭

        // 抖音面板：单文件 MP4 或图集，无画质列表/字幕/弹幕
        if (getPlatform() === 'douyin') {
            const albumHtml = info.album
                ? `<div class="bili-dl-ext-opt active" data-key="douyin-main">
                    <span class="bili-dl-ext-qlabel">图集（${info.album.length} 张图片）</span>
                    <span class="bili-dl-ext-qbadge">逐张下载</span>
                </div>`
                : `<div class="bili-dl-ext-opt active" data-key="douyin-main">
                    <span class="bili-dl-ext-qlabel">视频 MP4（原画）</span>
                    <span class="bili-dl-ext-qbadge">单文件</span>
                </div>`;
            panel.innerHTML = `
                <div class="bili-dl-ext-panel-title">抖音下载</div>
                ${albumHtml}
                <div class="bili-dl-ext-panel-tip">${info.album
                    ? '检测到图集作品，将逐张保存全部图片。'
                    : '抖音视频为单文件 MP4，直接保存到下载目录。若获取失败请刷新页面重试。'}</div>`;
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
        const batch = listBatchItems(info);
        const curPage = info.page ? +info.page : 1;

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
            </div>`;
        // 仅音频：列出全部可用音质，直接保存 .m4a（DASH 无音轨的老视频自动不显示）
        for (const a of info.audioList || []) {
            const size = fmtSize(a.bandwidth, info.timelength);
            const aLabel = AUDIO_LABEL[a.id] || `音轨 ${a.id}`;
            html += `
            <div class="bili-dl-ext-opt${saved === `audio:${a.id}` ? ' active' : ''}" data-key="audio:${a.id}">
                <span class="bili-dl-ext-qlabel">仅音频 · ${aLabel}</span>
                ${size ? `<span class="bili-dl-ext-qsize">${size}</span>` : ''}
                <span class="bili-dl-ext-qbadge">M4A</span>
            </div>`;
        }
        html += `
            <div class="bili-dl-ext-extras">
                <span class="bili-dl-ext-extras-title">同时保存</span>
                <label><input type="checkbox" data-extra="subtitle"${extras.subtitle ? ' checked' : ''}>字幕 .srt</label>
                <label><input type="checkbox" data-extra="danmaku"${extras.danmaku ? ' checked' : ''}>弹幕 .xml</label>
            </div>`;

        // 合集/多P：选集区（勾选后点画质 = 批量下载勾选条目；不勾则只下当前 P）
        if (batch) {
            const label = batch.kind === 'season' ? '合集' : '分P';
            html += `
            <div class="bili-dl-ext-batch">
                <div class="bili-dl-ext-batch-head" data-batch-toggle>
                    <input type="checkbox" data-batch-all>
                    <span class="bili-dl-ext-batch-title" title="${batch.title.replace(/"/g, '&quot;')}">${label}：${batch.title}</span>
                    <span class="bili-dl-ext-batch-count">共 ${batch.items.length} 个</span>
                </div>
                <div class="bili-dl-ext-batch-list">`;
            for (let i = 0; i < batch.items.length; i++) {
                const it = batch.items[i];
                const isCur = batch.kind === 'pages' && it.page === curPage;
                const dur = it.duration ? `${Math.floor(it.duration / 60)}:${String(it.duration % 60).padStart(2, '0')}` : '';
                const name = it.page ? `P${it.page} ${it.title}` : it.title;
                html += `
                    <label class="bili-dl-ext-batch-item${isCur ? ' cur' : ''}" title="${name.replace(/"/g, '&quot;')}">
                        <input type="checkbox" data-batch-idx="${i}">
                        <span class="bili-dl-ext-bi-title">${name}</span>
                        ${isCur ? '<span class="bili-dl-ext-bi-cur">当前</span>' : ''}
                        ${dur ? `<span class="bili-dl-ext-bi-dur">${dur}</span>` : ''}
                    </label>`;
            }
            html += `</div></div>`;
        }

        html += `<div class="bili-dl-ext-panel-tip">DASH 画质音视分离，超过 600MB 自动回退双文件下载；MP4 单文件上限 720P/1080P；「仅音频」直接保存 .m4a 免合并。字幕/弹幕随下载自动保存（字幕需登录）。${batch ? ' 勾选多个选集后点画质 = 批量依次下载。' : ''}</div>`;
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

        // 选集：全选/单选联动
        const allCb = panel.querySelector('[data-batch-all]');
        const itemCbs = [...panel.querySelectorAll('[data-batch-idx]')];
        const updateCount = () => {
            if (!allCb) return;
            const n = itemCbs.filter(c => c.checked).length;
            allCb.checked = n > 0 && n === itemCbs.length;
            allCb.indeterminate = n > 0 && n < itemCbs.length;
            const cnt = panel.querySelector('.bili-dl-ext-batch-count');
            if (cnt) cnt.textContent = n > 0 ? `已选 ${n}/${itemCbs.length}` : `共 ${itemCbs.length} 个`;
        };
        allCb?.addEventListener('change', () => {
            itemCbs.forEach(c => { c.checked = allCb.checked; });
            updateCount();
        });
        itemCbs.forEach(c => c.addEventListener('change', updateCount));

        panel.addEventListener('click', e => {
            // 点选集标题行 = 全选/全不选（复选框自身由 change 处理，避免双重切换）
            if (e.target.matches('input[data-batch-all]')) return;
            if (e.target.closest('[data-batch-toggle]') && !e.target.closest('.bili-dl-ext-batch-list')) {
                allCb.checked = !allCb.checked;
                itemCbs.forEach(c => { c.checked = allCb.checked; });
                updateCount();
                return;
            }
            if (e.target.closest('.bili-dl-ext-batch-item')) return;
            const opt = e.target.closest('.bili-dl-ext-opt');
            if (!opt) return;
            const selected = itemCbs.filter(c => c.checked).map(c => batch.items[+c.dataset.batchIdx]);
            closePanel();
            withStatus(btn, async labelEl => {
                if (selected.length) {
                    await batchDownload(selected, opt.dataset.key, labelEl);
                } else {
                    await executeChoice(opt.dataset.key, info, labelEl);
                }
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
                document.querySelectorAll('[data-bili-dl-btn]').forEach(b => b.remove());
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
        // 兜底轮询：抖音操作栏可能延迟很久才渲染（实测可达 1 分钟以上），
        // 且信息流上下滑会不断出现未注入的 feed 项，定时重试（injectButton 按项幂等）
        setInterval(injectButton, 3000);
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
