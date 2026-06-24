/**
 * 墨爪 InkClaw —— Obsidian 同步插件(community plugin)。
 *
 * 职责:加载时 + 每 60s 轮询后端 `GET /api/v1/notes?since=<cursor>`,把新笔记(连同
 * 媒体附件)写进用户指定的 vault 目录,并按 note id 推进游标(存 plugin data)。
 *
 * 架构:**纯同步逻辑全在 src/sync.mjs(零依赖、可 node --test)**;本文件只负责把
 * Obsidian 真实 API(requestUrl / vault adapter / loadData / saveData)绑成注入函数。
 * 见 src/sync.mjs 顶注 + README。
 */
import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl,
} from "obsidian";
// 纯逻辑核心(零依赖 ES module)。类型走 src/core.d.ts。
import { syncOnce } from "./src/sync.mjs";
import type { NotesResponse } from "./src/core";

interface InkClawSettings {
  apiBase: string;
  token: string;
  targetFolder: string;
  attachmentsFolder: string;
  autoSync: boolean;
}

const DEFAULT_SETTINGS: InkClawSettings = {
  apiBase: "https://inkclaw-cb.elefeed.com",
  token: "",
  targetFolder: "InkClaw",
  attachmentsFolder: "attachments",
  autoSync: true,
};

const POLL_INTERVAL_MS = 60 * 1000;
const CURSOR_KEY = "cursor";

export default class InkClawSyncPlugin extends Plugin {
  settings: InkClawSettings = DEFAULT_SETTINGS;
  private syncing = false;
  private statusBarEl: HTMLElement | null = null;
  private lastSyncTs = 0;
  private lastCursor = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new InkClawSettingTab(this.app, this));

    // 状态栏:同步中 / 上次同步时间 + 游标 / 未绑定。
    this.statusBarEl = this.addStatusBarItem();
    this.lastCursor = await this.readCursor();
    this.updateStatus();

    // 左侧 ribbon 快捷入口:点一下立即同步(等价命令「立即同步」与设置页「同步」按钮)。
    this.addRibbonIcon("refresh-cw", "InkClaw 同步", () => {
      void this.runSync(true);
    });

    // 手动触发一次同步的命令(便于调试,不必等 60s)。
    this.addCommand({
      id: "inkclaw-sync-now",
      name: "InkClaw: 立即同步",
      callback: () => {
        void this.runSync(true);
      },
    });

    // 全量重拉:重置游标为 0 后同步一次,服务端所有笔记会被重新拉取并覆盖写入本地。
    this.addCommand({
      id: "inkclaw-resync-all",
      name: "InkClaw: 全量重拉(重置游标)",
      callback: () => {
        void this.resyncAll();
      },
    });

    // 加载后跑一次(放到 layout ready 之后,确保 vault 可写)。仅自动同步开启时;
    // 手动模式下完全靠用户点 ribbon / 命令拉取(多设备共享 vault 时避免后台双写冲突)。
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoSync) {
        void this.runSync(false);
      }
    });

    // 每 60s 轮询;registerInterval 让 Obsidian 在卸载时自动清掉。回调内查 autoSync,
    // 改设置即时生效、无需重载;关掉则只剩手动同步(ribbon/命令/设置页按钮始终可用)。
    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.autoSync) {
          void this.runSync(false);
        }
      }, POLL_INTERVAL_MS)
    );
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  }

  async saveSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    data.settings = this.settings;
    await this.saveData(data);
  }

  private async readCursor(): Promise<number> {
    const data = (await this.loadData()) || {};
    const c = Number(data[CURSOR_KEY]);
    return Number.isFinite(c) ? c : 0;
  }

  private async writeCursor(n: number): Promise<void> {
    const data = (await this.loadData()) || {};
    data[CURSOR_KEY] = n;
    await this.saveData(data);
  }

  /** 刷新状态栏文字:同步中 / 未绑定 / 上次同步时间 + 游标。 */
  private updateStatus(): void {
    if (!this.statusBarEl) {
      return;
    }
    if (this.syncing) {
      this.statusBarEl.setText("InkClaw: 同步中…");
      return;
    }
    if (!this.settings.token) {
      this.statusBarEl.setText("InkClaw: 未绑定");
      return;
    }
    if (this.lastSyncTs > 0) {
      const d = new Date(this.lastSyncTs);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      this.statusBarEl.setText("InkClaw · " + hh + ":" + mm + " · 游标 " + this.lastCursor);
    } else {
      this.statusBarEl.setText("InkClaw · 就绪(游标 " + this.lastCursor + ")");
    }
  }

  /**
   * 打 GET /api/v1/me 自检:校验 token、取笔记数。不抛——把网络/鉴权错误折成可读 message。
   * 供设置页「测试连接」按钮与手动同步前的 precheck 复用(syncOnce 内部会吞掉 fetch 错误
   * 并按"没有新笔记"返回,故手动路径靠这里把鉴权/网络问题直接反馈给用户)。
   */
  async testConnection(): Promise<{ ok: boolean; noteCount: number; message: string }> {
    const base = (this.settings.apiBase || "").replace(/\/+$/, "");
    if (!base || !this.settings.token) {
      return { ok: false, noteCount: 0, message: "请先填 apiBase 和 token" };
    }
    try {
      const resp = await requestUrl({
        url: base + "/api/v1/me",
        method: "GET",
        headers: {
          Authorization: "Bearer " + this.settings.token,
          Accept: "application/json",
        },
        throw: false,
      });
      if (resp.status === 401) {
        return { ok: false, noteCount: 0, message: "Token 无效,请重新绑定" };
      }
      if (resp.status >= 400) {
        return { ok: false, noteCount: 0, message: "服务端返回 " + resp.status };
      }
      const j = (resp.json || {}) as { ok?: boolean; note_count?: number };
      if (!j.ok) {
        return { ok: false, noteCount: 0, message: "响应异常,确认 apiBase 指向 InkClaw 后端" };
      }
      const n = Number(j.note_count) || 0;
      return { ok: true, noteCount: n, message: "已绑定 ✓ · 共 " + n + " 篇笔记" };
    } catch (e) {
      console.error("[InkClaw] 连接测试失败", e);
      return { ok: false, noteCount: 0, message: "网络不可达,检查 apiBase 与网络连接" };
    }
  }

  /** 用 Obsidian 的 requestUrl 拉取(绕过 CORS),返回 track B 契约的响应体。 */
  private async fetchJson(since: number): Promise<NotesResponse> {
    const base = (this.settings.apiBase || "").replace(/\/+$/, "");
    if (!base) {
      throw new Error("apiBase 未配置");
    }
    const url = base + "/api/v1/notes?since=" + encodeURIComponent(String(since));
    const resp = await requestUrl({
      url,
      method: "GET",
      headers: {
        Authorization: "Bearer " + (this.settings.token || ""),
        Accept: "application/json",
      },
      throw: true,
    });
    return resp.json as NotesResponse;
  }

  /** 确保 vault 内某目录存在(逐级建)。 */
  private async ensureFolder(folder: string): Promise<void> {
    const path = normalizePath(folder);
    if (!path || path === "/" || path === ".") {
      return;
    }
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) {
      // createFolder 会顺带建中间层;若已被并发建出会抛,吞掉即可。
      try {
        await this.app.vault.createFolder(path);
      } catch (e) {
        if (!(await adapter.exists(path))) {
          throw e;
        }
      }
    }
  }

  /** 下载一个媒体到 targetFolder/attachmentsFolder/localName(已存在则跳过)。 */
  private async downloadMedia(localName: string, url: string): Promise<void> {
    const dir = normalizePath(this.settings.targetFolder + "/" + this.settings.attachmentsFolder);
    await this.ensureFolder(dir);
    const dest = normalizePath(dir + "/" + localName);
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(dest)) {
      return; // 已下载,跳过
    }
    const resp = await requestUrl({ url, method: "GET", throw: true });
    await adapter.writeBinary(dest, resp.arrayBuffer);
  }

  /** 某媒体是否已落在 targetFolder/attachmentsFolder/localName(供 syncOnce 自愈剔除缺图内嵌)。 */
  private async mediaExists(localName: string): Promise<boolean> {
    const dir = normalizePath(this.settings.targetFolder + "/" + this.settings.attachmentsFolder);
    const dest = normalizePath(dir + "/" + localName);
    return this.app.vault.adapter.exists(dest);
  }

  /** 写一篇笔记到 targetFolder/filename(覆盖)。 */
  private async writeNote(filename: string, markdown: string): Promise<void> {
    await this.ensureFolder(this.settings.targetFolder);
    const dest = normalizePath(this.settings.targetFolder + "/" + filename);
    await this.app.vault.adapter.write(dest, markdown);
  }

  /** 跑一次同步;reentrancy 保护,manual=true 时给用户弹提示。 */
  async runSync(manual: boolean): Promise<void> {
    if (this.syncing) {
      if (manual) {
        new Notice("InkClaw 正在同步中…");
      }
      return;
    }
    if (!this.settings.token || !this.settings.apiBase) {
      if (manual) {
        new Notice("InkClaw: 请先在设置里填 apiBase 和 token");
      }
      return;
    }
    this.syncing = true;
    this.updateStatus();
    try {
      // 手动同步:先打 /api/v1/me 自检,把鉴权/网络问题用可读文案直接反馈
      //(syncOnce 内部会吞掉 fetch 错误并按"没有新笔记"返回,故手动路径靠这里兜)。
      if (manual) {
        const probe = await this.testConnection();
        if (!probe.ok) {
          new Notice("InkClaw: " + probe.message);
          return;
        }
      }
      const before = await this.readCursor();
      const after = await syncOnce({
        fetchJson: (since: number) => this.fetchJson(since),
        downloadMedia: (n: string, u: string) => this.downloadMedia(n, u),
        mediaExists: (n: string) => this.mediaExists(n),
        writeNote: (f: string, m: string) => this.writeNote(f, m),
        readCursor: () => this.readCursor(),
        writeCursor: (n: number) => this.writeCursor(n),
        log: (level: string, msg: string, err?: unknown) => {
          const line = "[InkClaw] " + msg;
          if (level === "error") {
            console.error(line, err || "");
          } else if (level === "warn") {
            console.warn(line, err || "");
          } else {
            console.log(line);
          }
        },
        attachmentsFolder: this.settings.attachmentsFolder,
      });
      this.lastCursor = after;
      this.lastSyncTs = Date.now();
      if (manual) {
        const n = after - before;
        new Notice(n > 0 ? "InkClaw: 同步了 " + n + " 篇新笔记" : "InkClaw: 没有新笔记");
      }
    } catch (e) {
      console.error("[InkClaw] 同步异常", e);
      if (manual) {
        const msg = e instanceof Error && e.message ? e.message : "同步出错,详见控制台";
        new Notice("InkClaw: " + msg);
      }
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  /** 全量重拉:重置游标为 0 再同步一次(服务端所有笔记重新写入)。reentrancy 保护。 */
  async resyncAll(): Promise<void> {
    if (this.syncing) {
      new Notice("InkClaw 正在同步中…");
      return;
    }
    await this.writeCursor(0);
    new Notice("InkClaw: 已重置游标,开始全量重拉…");
    await this.runSync(true);
  }
}

class InkClawSettingTab extends PluginSettingTab {
  plugin: InkClawSyncPlugin;

  constructor(app: App, plugin: InkClawSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "墨爪 InkClaw 同步" });

    new Setting(containerEl)
      .setName("API Base")
      .setDesc("后端地址,如 https://inkclaw-cb.elefeed.com")
      .addText((text) =>
        text
          .setPlaceholder("https://inkclaw-cb.elefeed.com")
          .setValue(this.plugin.settings.apiBase)
          .onChange(async (value) => {
            this.plugin.settings.apiBase = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Token")
      .setDesc("你的 Bearer token(请求头 Authorization: Bearer <token>)")
      .addText((text) => {
        text
          .setPlaceholder("粘贴你的 token")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
        // 当作密码遮挡显示。
        text.inputEl.type = "password";
      });

    // 连接自检:点一下打 /api/v1/me,把"已绑定 ✓ · 共 N 篇" / "Token 无效" / "网络不可达"
    // 就地显示在描述区(粘贴 token 后不必等 60s 轮询就能确认是否填对)。
    const connSetting = new Setting(containerEl)
      .setName("连接状态")
      .setDesc("点「测试连接」校验 token 是否有效、能拉到几篇笔记");
    const connStatusEl = connSetting.descEl.createDiv({ text: "" });
    connStatusEl.style.marginTop = "4px";
    connSetting.addButton((btn) =>
      btn.setButtonText("测试连接").onClick(async () => {
        connStatusEl.setText("测试中…");
        connStatusEl.style.color = "var(--text-muted)";
        const r = await this.plugin.testConnection();
        connStatusEl.setText(r.message);
        connStatusEl.style.color = r.ok ? "var(--text-success)" : "var(--text-error)";
      })
    );

    new Setting(containerEl)
      .setName("目标目录")
      .setDesc("笔记写入的 vault 目录(相对 vault 根)")
      .addText((text) =>
        text
          .setPlaceholder("InkClaw")
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = value.trim() || DEFAULT_SETTINGS.targetFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("附件子目录")
      .setDesc("媒体附件(封面等)写入的子目录名,位于目标目录下")
      .addText((text) =>
        text
          .setPlaceholder("attachments")
          .setValue(this.plugin.settings.attachmentsFolder)
          .onChange(async (value) => {
            this.plugin.settings.attachmentsFolder =
              value.trim() || DEFAULT_SETTINGS.attachmentsFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("自动同步")
      .setDesc(
        "开:每 60 秒自动拉一次(并在启动时拉)。关:只在你点下面「同步」、左侧图标或命令时才拉 —— " +
          "多台设备共用同一个 vault(iCloud / Obsidian Sync)时建议关掉,避免后台同时拉取双写、产生冲突副本。"
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("立即同步")
      .setDesc("马上拉一次最新笔记")
      .addButton((btn) =>
        btn
          .setButtonText("同步")
          .setCta()
          .onClick(() => {
            void this.plugin.runSync(true);
          })
      );

    new Setting(containerEl)
      .setName("全量重拉")
      .setDesc("重置游标,把服务端所有笔记重新拉取并覆盖写入(换 vault / 笔记误删时用)")
      .addButton((btn) =>
        btn
          .setButtonText("全量重拉")
          .setWarning()
          .onClick(() => {
            void this.plugin.resyncAll();
          })
      );
  }
}
