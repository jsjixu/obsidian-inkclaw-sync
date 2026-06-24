# InkClaw Sync

Sync the notes you forwarded to **InkClaw** straight into your Obsidian vault.

InkClaw ("墨爪") is a WeChat-based note service: you forward a video / article / link to InkClaw, and it downloads, transcribes, and polishes it into a clean note. This plugin pulls those finished notes (with their cover images and media) into your vault automatically, so your knowledge base stays in sync with what you forward. Works on both **desktop and mobile**.

## Network use & privacy disclosure

This plugin talks to a remote server. Please read this before installing.

- **Server it connects to:** `https://inkclaw-cb.elefeed.com` (configurable in settings).
- **Authentication:** it sends a personal **sync token** (HTTP `Authorization: Bearer <token>`) that you obtain from your own InkClaw account. You need an InkClaw account for this plugin to do anything.
- **What is transmitted:**
  - **Outbound:** your sync token (for authentication) and a numeric cursor (the id of the last note you already pulled).
  - **Inbound:** the notes **you** created by forwarding content to InkClaw — their Markdown text and media files (cover images, etc.).
- **What is NOT transmitted:** the plugin only **writes** notes into your vault. It never reads, scans, or uploads any of your existing vault content. No analytics or telemetry of any kind is collected.
- **Where data is stored:** notes and media are written to a folder in your vault that you choose (default `InkClaw/`). Your token and the sync cursor are stored locally in the plugin's `data.json`.

The plugin is open source (MIT). You can read exactly what it sends in [`src/sync.mjs`](src/sync.mjs) and [`main.ts`](main.ts).

## Requirements

- An **InkClaw account** and a **sync token** (in WeChat, send the keyword `obsidian` to the InkClaw assistant to receive yours).
- Obsidian `1.4.0` or newer.

## Installation

### From the Community Plugins store (recommended, once approved)
Settings → Community plugins → Browse → search **"InkClaw Sync"** → Install → Enable.

### Via BRAT (available now, desktop & mobile)
1. Install the **BRAT** plugin from the Community store.
2. BRAT → *Add beta plugin* → enter `jsjixu/obsidian-inkclaw-sync`.
3. Enable **InkClaw Sync** in Community plugins.

### Manual
Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/jsjixu/obsidian-inkclaw-sync/releases/latest) into `<vault>/.obsidian/plugins/inkclaw-sync/`, then enable it.

## Setup

Open **Settings → InkClaw Sync** and fill in:

| Setting | Default | Meaning |
| --- | --- | --- |
| API Base | `https://inkclaw-cb.elefeed.com` | InkClaw backend address |
| Token | *(empty)* | Your personal sync token |
| Target folder | `InkClaw` | Where notes are written |
| Attachments folder | `attachments` | Subfolder for cover images / media |
| Auto-sync | **off** (manual) | Off: pull only when you click. On: pull on startup and every 60 s. |

**By default, syncing is manual.** After setting your token, pull notes whenever you want with the ribbon **🔄** icon, the **"Sync now"** command, or the **Sync** button in settings. Use **"Test connection"** to confirm your token works. If you'd rather it pull automatically every 60 seconds, turn on **Auto-sync** in settings — best for a single device.

## How syncing works

- The plugin pulls incrementally: it remembers a **cursor** (the highest note id already fetched) and only requests newer notes. A single missing note never blocks the rest of the batch.
- The cursor lives in each device's own plugin data, so **every device syncs independently** — you do **not** need iCloud or Obsidian Sync. Install it on each device and each one fills its own vault.
- **If you DO share one vault across devices** (iCloud / Obsidian Sync), the default manual mode already handles it: only the device you click on pulls, and the shared cursor means the other device skips notes already fetched, so no background double-writing or conflict copies. Only turn on Auto-sync if you run it on a single device.
- If a cover image cannot be downloaded (e.g., an expired source URL), the plugin omits that image's embed rather than leaving a broken link — your notes stay clean.

## Mobile notes

- Mobile apps suspend in the background, so on phones/tablets syncing happens **when you open Obsidian** (and while it stays in the foreground), not continuously.
- The first sync downloads cover images, which can use mobile data.

## Development

```bash
npm install
npm test          # node --test (no extra deps)
npm run build     # tsc typecheck + esbuild → main.js
```

Releases are produced automatically by GitHub Actions when a tag matching the manifest version is pushed.

## License

[MIT](LICENSE)

---

### 中文简介

把你转发给 **墨爪 InkClaw** 的内容(自动转录+精校后的笔记)自动同步进 Obsidian,连同封面等媒体。**电脑、手机都能用**。需要墨爪账号 + 同步 token(微信里给墨爪发 `obsidian` 获取)。插件**只往 vault 写笔记,绝不读取/上传你的其它内容**,无任何埋点。每台设备独立同步,不依赖 iCloud;若你用 iCloud/Obsidian Sync 共享同一 vault,则**只在一台设备开启**以免双写冲突。
