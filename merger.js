// B站下载助手 - 合并页面
// 流式下载视频/音频流（多地址依次尝试）→ ffmpeg.wasm 无损合并 → 自动保存

(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const steps = ['video', 'audio', 'merge', 'save'];

    function setStep(name, state, text, ratio) {
        const el = $('st-' + name);
        el.className = 'step ' + (state || '');
        if (text != null) $('st-' + name + '-text').textContent = text;
        const bar = $('st-' + name + '-bar');
        const fill = bar.querySelector('i');
        if (ratio == null) {
            bar.classList.add('indet');
        } else {
            bar.classList.remove('indet');
            fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
        }
    }

    function resetSteps() {
        for (const s of steps) {
            $('st-' + s).className = 'step';
            $('st-' + s + '-text').textContent = '等待中';
            const bar = $('st-' + s + '-bar');
            bar.classList.remove('indet');
            bar.querySelector('i').style.width = '0';
        }
    }

    function message(type, text) {
        const el = $('message');
        el.className = type || '';
        el.textContent = text || '';
    }

    function fmtMB(bytes) {
        return bytes >= 1 << 30 ? (bytes / (1 << 30)).toFixed(2) + ' GB' : (bytes / (1 << 20)).toFixed(1) + ' MB';
    }

    $('closeBtn').addEventListener('click', () => window.close());

    // ---------- 流式下载：依次尝试 urls，实时回调进度 ----------

    const STALL_TIMEOUT = 30000; // 连续 30 秒无数据视为连接停滞，切换下一地址

    async function fetchStream(urls, onProgress) {
        const errors = [];
        for (const url of urls) {
            let stalled = false;
            try {
                const ctrl = new AbortController();
                let lastActive = Date.now();
                const watchdog = setInterval(() => {
                    if (Date.now() - lastActive > STALL_TIMEOUT) {
                        stalled = true;
                        ctrl.abort();
                    }
                }, 3000);
                try {
                    const resp = await fetch(url, { signal: ctrl.signal });
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    const total = +resp.headers.get('Content-Length') || 0;
                    const reader = resp.body.getReader();
                    const chunks = [];
                    let received = 0;
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        lastActive = Date.now();
                        chunks.push(value);
                        received += value.length;
                        onProgress(received, total);
                    }
                    const out = new Uint8Array(received);
                    let offset = 0;
                    for (const c of chunks) { out.set(c, offset); offset += c.length; }
                    return out;
                } finally {
                    clearInterval(watchdog);
                    if (stalled) throw new Error(`${STALL_TIMEOUT / 1000} 秒无数据，连接停滞`);
                }
            } catch (e) {
                errors.push(`${new URL(url).host}: ${e.message}`);
                console.warn('[合并] 地址失败，尝试下一个:', url.slice(0, 90), e.message);
            }
        }
        throw new Error('所有下载地址均失败：\n' + errors.join('\n'));
    }

    // ---------- ffmpeg.wasm ----------

    let ffmpeg = null;
    async function loadFFmpeg() {
        if (ffmpeg) return ffmpeg;
        // UMD 包暴露的全局名是 FFmpegWASM（WASM 全大写）
        ffmpeg = new FFmpegWASM.FFmpeg();
        ffmpeg.on('log', ({ message }) => console.log('[ffmpeg]', message));
        // 注意：不要传 classWorkerURL（会创建 module worker，而 UMD worker 内部用
        // importScripts 加载 core，module worker 中不可用）。
        // 默认路径会从 libs/ffmpeg.js 的地址自动解析出同目录的 814.ffmpeg.js（经典 worker）。
        await ffmpeg.load({
            coreURL: chrome.runtime.getURL('libs/ffmpeg-core.js'),
            wasmURL: chrome.runtime.getURL('libs/ffmpeg-core.wasm')
        });
        return ffmpeg;
    }

    // ---------- 主流程 ----------

    async function run(job) {
        resetSteps();
        message('');
        $('filename').textContent = job.filename;

        // 1. 视频流
        setStep('video', 'doing', '连接中…', null);
        let videoData = await fetchStream(job.video.urls, (got, total) => {
            setStep('video', 'doing',
                `${fmtMB(got)}${total ? ' / ' + fmtMB(total) : ''}`,
                total ? got / total : null);
        });
        setStep('video', 'done', `已下载 ${fmtMB(videoData.length)}`, 1);

        // 2. 音频流
        setStep('audio', 'doing', '连接中…', null);
        let audioData = await fetchStream(job.audio.urls, (got, total) => {
            setStep('audio', 'doing',
                `${fmtMB(got)}${total ? ' / ' + fmtMB(total) : ''}`,
                total ? got / total : null);
        });
        setStep('audio', 'done', `已下载 ${fmtMB(audioData.length)}`, 1);

        // 3. 合并
        setStep('merge', 'doing', '加载合并引擎…', null);
        let ff;
        try {
            ff = await loadFFmpeg();
        } catch (e) {
            throw new Error('合并引擎加载失败：' + e.message);
        }
        await ff.writeFile('in_video.mp4', videoData);
        await ff.writeFile('in_audio.m4a', audioData);
        // 数据已写入 ffmpeg 的 MEMFS，释放 JS 侧引用，降低合并期间峰值内存
        videoData = audioData = null;
        ff.on('progress', ({ progress }) => {
            if (progress >= 0 && progress <= 1) {
                setStep('merge', 'doing', `合并中 ${Math.round(progress * 100)}%`, progress);
            }
        });
        setStep('merge', 'doing', '合并中…', null);
        const code = await ff.exec([
            '-i', 'in_video.mp4',
            '-i', 'in_audio.m4a',
            '-c', 'copy',
            '-movflags', 'faststart',
            'out.mp4'
        ]);
        if (code !== 0) {
            throw new Error('合并失败（ffmpeg 退出码 ' + code + '），已保留两个原始文件可手动处理');
        }
        const merged = await ff.readFile('out.mp4');
        await ff.deleteFile('in_video.mp4');
        await ff.deleteFile('in_audio.m4a');
        await ff.deleteFile('out.mp4');
        setStep('merge', 'done', `完成 ${fmtMB(merged.length)}`, 1);

        // 4. 保存
        setStep('save', 'doing', '保存中…', null);
        const blobUrl = URL.createObjectURL(new Blob([merged.buffer], { type: 'video/mp4' }));
        await new Promise((resolve, reject) => {
            chrome.downloads.download({ url: blobUrl, filename: job.filename, saveAs: false }, id => {
                URL.revokeObjectURL(blobUrl); // 下载已被浏览器接管，释放 blob 内存
                if (chrome.runtime.lastError || id === undefined) {
                    reject(new Error(chrome.runtime.lastError?.message || '保存失败'));
                } else {
                    resolve(id);
                }
            });
        });
        setStep('save', 'done', '已保存到下载目录', 1);
        $('closeBtn').style.display = 'inline-block';
    }

    async function main() {
        const { mergeJob: job } = await chrome.storage.local.get('mergeJob');
        if (!job) {
            message('error', '没有待处理的合并任务。请回到视频页点击下载按钮重新发起。');
            $('closeBtn').style.display = 'inline-block';
            return;
        }
        await chrome.storage.local.remove('mergeJob');
        console.log('[合并] 任务:', job);
        try {
            await run(job);
        } catch (e) {
            console.error('[合并] 失败:', e);
            message('error', '出错：' + e.message);
            // 标记当前进行中的步骤为失败
            for (const s of steps) {
                if ($('st-' + s).classList.contains('doing')) setStep(s, 'fail', '失败');
            }
            $('closeBtn').style.display = 'inline-block';
        }
    }

    main();
})();
