# Privacy Policy / 隐私政策

Last updated: 2026-09-03

"Bilibili 高画质下载助手" (Bilibili High-Quality Download Assistant) is a browser extension that helps users download videos they have permission to watch on bilibili.com, for personal offline viewing.

## What data we collect

**None.** This extension:

- Does NOT collect, store, transmit, or share any personal data
- Does NOT contain analytics, tracking, advertising, or third-party SDKs
- Does NOT have any server of its own; all processing happens locally in your browser

## Data access explained

The extension accesses the following data strictly to perform its stated function:

| Access | Purpose |
|---|---|
| Bilibili page content (video title, quality list) | To display download options on the video page |
| Your Bilibili login cookies | Requests are sent from your own browser session to bilibili.com APIs so you can download at the quality your account is entitled to. Cookies are never read, stored, or sent anywhere else |
| Downloaded video files | Saved directly to your browser's download folder on your device |
| Local storage | Remembers your last selected video quality and subtitle/danmaku preferences. Stays on your device |

## Permissions explained

- `downloads` — Save the downloaded video, subtitle, and danmaku files to your device
- `storage` — Pass merge tasks between the extension pages
- `declarativeNetRequest` — Set the `Referer` header on requests to Bilibili's CDN, which is required by bilibili.com to allow video downloads; no other requests are modified
- Host permissions (`*.bilibili.com`, `*.bilivideo.com`, `*.bilivideo.cn`, `*.akamaized.net`) — Access Bilibili's video API and CDN domains only

## Third-party services

The extension only communicates with bilibili.com's own API and CDN. No other third party is involved.

## Contact

For questions about this policy, open an issue at:
https://github.com/lilcandi/bilibili-downloader-extension/issues
