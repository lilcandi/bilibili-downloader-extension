# Bilibili 高画质下载助手

Chrome/Edge 扩展（Manifest V3）：在 B 站视频页工具栏（点赞/投币/收藏/转发）旁注入「下载」按钮，支持画质选择、**浏览器内自动合并**（内置 ffmpeg.wasm，无需安装 ffmpeg），大会员可下载 1080P 高码率/4K/HDR 等高画质。

## 功能

- 按钮自动插入到视频工具栏「转发」按钮旁（找不到时自动兜底到标题区域、右下角浮动按钮）
- **画质选择**：点击按钮右侧 ▼（约 30px 宽的独立点击区）打开画质面板，列出当前账号可用的全部画质（含大小估算）
- **点击主体**直接按上次选择的画质下载（默认最高画质，选择记录在本地）
- **浏览器内合并**：选择 DASH 画质后自动打开合并标签页，下载视频流/音频流（实时进度）→ ffmpeg.wasm 无损合并 → 自动保存单文件 MP4，全程无需安装任何软件
- 「MP4 单文件」选项：免合并直接可播，画质上限 720P/1080P
- 超过 1.4GB 的画质自动回退为「视频+音频两个文件」（浏览器内存限制），并给出 ffmpeg 命令
- 下载地址智能排序：常规 CDN 域名优先，P2P 边缘节点（经常失败）垫底；下载中断自动切换备用线路
- 自动识别分 P（`?p=N`），文件名自动取视频标题并清理非法字符
- API 请求在页面环境发起（带登录 Cookie，Origin 为 `www.bilibili.com`），不会被 B 站风控拦截

## 画质说明

| 模式 | 画质范围 | 产物 |
|------|---------|------|
| DASH（`fnval=4048`，≤1.4GB） | 账号可用全部画质：大会员 1080P 高码率 / 4K / HDR / 8K | 合并标签页自动产出**单个 MP4** |
| DASH（>1.4GB） | 同上 | 视频 `.mp4` + 音频 `.m4a` 两个文件 + ffmpeg 命令 |
| MP4（`platform=html5`） | 上限 720P / 1080P | 单文件免合并 |

## 安装

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹
4. 打开任意 B 站视频页，工具栏出现粉色「下载」按钮即安装成功

> 已装旧版本的话，在扩展卡片上点刷新按钮 🔄 后**刷新视频页**即可。

## 使用

- **点按钮主体**：按上次画质直接下载（首次为最高可用画质）
- **点按钮右侧 ▼**：打开画质面板选择，选中后自动记住
- 选择 DASH 画质 → 新标签页显示「下载视频流 → 下载音频流 → 无损合并 → 保存」四步进度，完成后自动保存，期间**请勿关闭该标签页**
- 未登录时 DASH 只会列出 360P/480P（B 站按账号权限下发），登录后即可见 1080P+，大会员可见 4K/HDR

## 技术说明

```
content.js（页面环境）
  1. GET /x/web-interface/view?bvid=…               → 标题、分P cid
  2. GET /x/player/playurl?…&fnval=4048&qn=0        → DASH 流列表（按账号权限）
  3. 体积 ≤1.4GB → MERGE_JOB → 打开合并标签页
     体积 >1.4GB → DOWNLOAD_FILE（双文件 + ffmpeg 命令）

merger.html/js（扩展标签页）
  fetch 流式下载（进度实时显示，多地址依次尝试）
  → ffmpeg.wasm -c copy 无损合并（faststart）
  → chrome.downloads 自动保存

background.js（service worker）
  DOWNLOAD_FILE：下载 + 中断自动切换 backup_url
  MERGE_JOB：storage 写入任务 → 打开 merger.html
```

关键约束（实测验证）：
- `api.bilibili.com` 有 Origin 风控：请求方 Origin 不是 `www.bilibili.com` 时返回 HTML 错误页，所以 API 调用必须放在 content script 页面环境
- `x/player/playurl` + `fnval=4048` 无需 wbi 签名即可获取 DASH 流；`dash.video[]` 只包含当前账号有权限的画质
- B 站现在大量返回 `mcdn` P2P 节点甚至第三方域名边缘节点作为下载地址，直连经常失败 → 下载前按域名排序（bilivideo.com/.cn、akamaized 优先），失败自动逐个尝试备用地址
- 合并用 ffmpeg.wasm `@ffmpeg/core@0.12.6`（单线程 UMD 版），`-c copy` 无损合并 + `faststart`；worker 不能传 `classWorkerURL`（module worker 中 importScripts 不可用）
- 浏览器内合并受 wasm 内存限制（约 2GB），故对 >1.4GB 的任务回退为双文件下载

## 目录结构

```
├── manifest.json        扩展配置（MV3）
├── background.js        后台：下载 failover、合并任务分发
├── content.js           页面内：按钮注入、API 解析、画质面板
├── merger.html/js       合并页：流式下载 + ffmpeg.wasm 合并 + 保存
├── libs/                ffmpeg.wasm（ffmpeg.js、814.ffmpeg.js、core、wasm 约 32MB）
├── icons/               PNG 图标
└── README.md
```

## 已知限制

- 未登录时最高 480P/720P（B 站按 Cookie 权限下发画质）
- 浏览器内合并受内存限制：>1.4GB 自动回退双文件模式
- 合并期间不能关闭合并标签页；耗时与视频大小成正比（无损复制，通常几十秒内）
- 大会员专属、付费、地区限制视频按 B 站接口规则返回错误
- 高频请求可能触发 B 站风控（接口会返回明确报错，稍后重试即可）

## 许可证

MIT License

---

**版本**: 1.2.0
**兼容浏览器**: Chrome/Edge (Manifest V3)
