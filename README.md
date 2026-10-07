# b抖下载器

Chrome/Edge 扩展（Manifest V3）：同时支持 B 站与抖音视频下载。B 站在视频页工具栏旁注入「下载」按钮，支持画质选择、**浏览器内自动合并**（内置 ffmpeg.wasm，无需安装 ffmpeg）、字幕和弹幕保存，大会员可下载 1080P 高码率/4K/HDR 等高画质；抖音在右侧操作栏注入下载按钮，直接下载原画 MP4。

## 功能

- 按钮自动插入到视频工具栏「转发」按钮旁（找不到时自动兜底到右下角浮动按钮）
- **画质选择**：点击按钮右侧 ▼（约 30px 宽的独立点击区）打开画质面板，列出当前账号可用的全部画质（含大小估算）
- **点击主体**直接按上次选择的画质下载（默认最高画质，选择记录在本地）
- **合集 / 多P 批量下载**：识别视频所属合集（ugc_season）与多P分P，在画质面板里勾选任意多个分集后点画质即可批量下载；串行执行（等上一个合并完成再下一个，避免内存与带宽打爆），画质板内显示「已选 N/M」与当前集高亮
- **字幕/弹幕保存与封装**（B站）：勾选后随下载自动保存字幕 .srt 与实时弹幕 .xml；合并时自动把字幕封装为 MP4 软字幕轨（mov_text，播放器可开关，几乎零耗时），未获取到字幕则自动回退不封装
- **浏览器内合并**：选择 DASH 画质后自动打开合并标签页，下载视频流/音频流（实时进度）→ ffmpeg.wasm 无损合并 → 自动保存单文件 MP4，全程无需安装任何软件
- 「MP4 单文件」选项：免合并直接可播，画质上限 720P/1080P
- **仅音频下载**（B站）：画质面板列出当前视频全部可用音质（Hi-Res 无损 / 杜比全景声 / 320K / 128K，含大小估算），点击直接保存 `.m4a` 单文件，免合并；同样支持合集/分P 批量勾选，勾选的字幕/弹幕随音频一并保存
- **抖音**：在视频操作栏（点赞/评论/收藏/分享旁）注入下载按钮，直接下载原画质单文件 MP4；**支持图集**（逐张保存全部图片）；**同时覆盖视频详情页与推荐/精选沉浸式信息流**（上下滑切换时每个视频的操作栏都有独立按钮，精确下载点击的那一条，直播卡片自动跳过）；优先直读播放器全局数据（详情页 `window.player.config.awemeInfo` / 信息流 React fiber `slideData`，含完整码率列表，页面打开即可下载，无需先播放），按码率/体积优选最高画质（含 H265），多级回退（webRequest 实际拉流捕获 → RENDER_DATA → video 元素 → 页面脚本匹配）；支持 SPA 路由；兼容抖音多次改版的 DOM 锚点（自动跳过页面中隐藏的旧版播放器副本），操作栏延迟渲染时自动定时重试注入，并始终提供右下角浮动按钮兜底
- 超过 600MB 的画质自动回退为「视频+音频两个文件」（浏览器内存限制），并给出 ffmpeg 命令；弹出下载进度页实时显示两条进度条（速度/百分比/失败原因），页内一键复制 ffmpeg 合并命令（合并成功后自动删除视频/音频原文件），下载完成自动转入浏览器下载列表
- 大文件分块流式下载兜底：Range 分块（8MB 起自适应缩放）+ 逐块重试 + 多线路轮换，连接被 CDN 掐断/慢速卡顿都能续块恢复，全程恒定内存占用
- 下载地址智能分档排序：upos-*/akamaized 常规 CDN 优先，mcdn P2P 边缘节点（经常失败）垫底；下载中断自动切换备用线路
- 自动识别分 P（`?p=N`），文件名自动取视频标题并清理非法字符
- API 请求在页面环境发起（带登录 Cookie，Origin 为 `www.bilibili.com`），不会被 B 站风控拦截

## 画质说明

| 模式 | 画质范围 | 产物 |
|------|---------|------|
| DASH（`fnval=4048`，≤600MB） | 账号可用全部画质：大会员 1080P 高码率 / 4K / HDR / 8K | 合并标签页自动产出**单个 MP4**（勾选字幕时自动封装软字幕轨） |
| DASH（>600MB） | 同上 | 视频 `.mp4` + 音频 `.m4a` 两个文件 + ffmpeg 命令（合并成功后自动删除原文件；有字幕时命令自动带上封装参数） |
| MP4（`platform=html5`） | 上限 720P / 1080P | 单文件免合并 |
| 仅音频（DASH 音轨） | 当前账号可用全部音质：Hi-Res 无损 / 杜比全景声 / 320K / 128K | `.m4a` 单文件免合并 |

## 安装

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹
4. 打开任意 B 站视频页，工具栏出现粉色「下载」按钮即安装成功

> 已装旧版本的话，在扩展卡片上点刷新按钮 🔄 后**刷新视频页**即可。

## 使用

- **点按钮主体**：按上次画质直接下载（首次为最高可用画质；上次选过「仅音频」则直接下音频）
- **点按钮右侧 ▼**：打开画质面板选择（视频画质 / MP4 单文件 / 仅音频），选中后自动记住
- 选择 DASH 画质 → 新标签页显示「下载视频流 → 下载音频流 → 无损合并 → 保存」四步进度，完成后自动保存，期间**请勿关闭该标签页**；「仅音频」不打开合并页，直接进入浏览器下载列表
- 未登录时 DASH 只会列出 360P/480P（B 站按账号权限下发），登录后即可见 1080P+，大会员可见 4K/HDR

## 技术说明

```
content.js（页面环境）
  1. GET /x/web-interface/view?bvid=…               → 标题、分P cid
  2. GET /x/player/playurl?…&fnval=4048&qn=0        → DASH 流列表（按账号权限）
  3. 体积 ≤600MB → MERGE_JOB → 打开合并标签页
     体积 >600MB → DOWNLOAD_FILE（双文件 + ffmpeg 命令）

merger.html/js（扩展标签页）
  fetch 流式下载（进度实时显示，多地址依次尝试）
  → ffmpeg.wasm -c copy 无损合并（faststart）
  → chrome.downloads 自动保存

background.js（service worker）
  DOWNLOAD_FILE：mcdn 等不校验 Referer 的地址先试 downloads 直连；
  upos 常规 CDN 跳过直连（必 403），直接走流式兜底；失败自动换备用线路
  MERGE_JOB：storage 写入任务 → 打开 merger.html

stream-dl.html/js（扩展标签页，大文件兜底通道）
  fetch（DNR 注入 Referer）分块 Range 下载（8MB 起，自适应缩放）
  → 逐块写 OPFS（磁盘级临时文件，内存恒定）
  → file-backed blob URL → chrome.downloads 落盘 → 清理临时文件
```

关键约束（实测验证）：
- `api.bilibili.com` 有 Origin 风控：请求方 Origin 不是 `www.bilibili.com` 时返回 HTML 错误页，所以 API 调用必须放在 content script 页面环境
- `x/player/playurl` + `fnval=4048` 无需 wbi 签名即可获取 DASH 流；`dash.video[]` 只包含当前账号有权限的画质
- B 站现在大量返回 `mcdn` P2P 节点甚至第三方域名边缘节点作为下载地址，直连经常失败 → 下载前按域名分档排序（upos-*/akamaized 常规 CDN 优先，mcdn P2P 垫底），失败自动逐个尝试备用地址
- upos 常规 CDN 强制校验 Referer：`chrome.downloads` 请求带不上 Referer（DNR 注入对 downloads 不生效、downloads.headers 又禁止 Referer），直连必 403 → 大文件走 stream-dl 的 fetch 流式通道（DNR 对 fetch 生效）
- 合并用 ffmpeg.wasm `@ffmpeg/core@0.12.6`（单线程 UMD 版），`-c copy` 无损合并 + `faststart`；worker 不能传 `classWorkerURL`（module worker 中 importScripts 不可用）
- 浏览器内合并受 wasm 内存限制（约 2GB），故对 >600MB 的任务回退为双文件下载

## 目录结构

```
├── manifest.json        扩展配置（MV3）
├── background.js        后台：下载 failover、合并任务分发
├── content.js           页面内：按钮注入、API 解析、画质面板
├── merger.html/js       合并页：流式下载 + ffmpeg.wasm 合并 + 保存（≤600MB）
├── stream-dl.html/js    流式页：大文件分块下载兜底通道，带可见进度条（>600MB 双文件模式）
├── rules.json           DNR 规则：给 CDN 请求注入 Referer
├── libs/                ffmpeg.wasm（ffmpeg.js、814.ffmpeg.js、core、wasm 约 32MB）
├── icons/               PNG 图标
└── README.md
```

## 已知限制

- 未登录时最高 480P/720P（B 站按 Cookie 权限下发画质）
- 浏览器内合并受内存限制：>600MB 自动回退双文件模式
- 合并期间不能关闭合并标签页；耗时与视频大小成正比（无损复制，通常几十秒内）
- 大会员专属、付费、地区限制视频按 B 站接口规则返回错误
- 高频请求可能触发 B 站风控（接口会返回明确报错，稍后重试即可）

## 许可证

MIT License

---

**版本**: 1.7.0
**兼容浏览器**: Chrome/Edge (Manifest V3)
