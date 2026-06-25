/**
 * 墨爪 Inklaw —— Obsidian 同步插件(community plugin)。
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
  onboarded: boolean;
}

const DEFAULT_SETTINGS: InkClawSettings = {
  apiBase: "https://inkclaw-cb.elefeed.com",
  token: "",
  targetFolder: "Inklaw",
  attachmentsFolder: "attachments",
  // 默认手动同步:用户自己点才拉。多设备共享 vault 时天然不会后台双写冲突;
  // 单设备想省心的用户可在设置里打开「自动同步」。
  autoSync: false,
  onboarded: false,
};

const POLL_INTERVAL_MS = 60 * 1000;

/** plugin data.json 的结构(loadData/saveData 往返)。给 loadData 的 any 一个收窄类型,避免不安全访问。 */
interface InkClawData {
  settings?: Partial<InkClawSettings>;
  cursor?: number;
}

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
    this.addRibbonIcon("refresh-cw", "Inklaw 同步", () => {
      void this.runSync(true);
    });

    // 手动触发一次同步的命令(便于调试,不必等 60s)。
    this.addCommand({
      id: "sync-now",
      name: "立即同步",
      callback: () => {
        void this.runSync(true);
      },
    });

    // 全量重拉:重置游标为 0 后同步一次,服务端所有笔记会被重新拉取并覆盖写入本地。
    this.addCommand({
      id: "resync-all",
      name: "全量重拉(重置游标)",
      callback: () => {
        void this.resyncAll();
      },
    });

    // 加载后:首次安装给一次性引导(讲清默认手动、怎么拉、怎么改自动);仅自动同步开启时
    // 才启动拉取,手动模式完全靠用户点 ribbon / 命令(多设备共享 vault 时避免后台双写冲突)。
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.onboarded) {
        void this.showOnboarding();
      }
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

  /** 首次安装的一次性引导:讲清默认手动同步、怎么拉、怎么改自动。展示后落标记不再弹。 */
  private async showOnboarding(): Promise<void> {
    new Notice(
      "Inklaw Sync 已启用 · 默认「手动同步」:点左侧 🔄 图标或命令「立即同步」拉取笔记。" +
        "想每 60 秒自动拉?到 设置 → Inklaw Sync 打开「自动同步」。",
      15000
    );
    this.settings.onboarded = true;
    await this.saveSettings();
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) as InkClawData | null) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  }

  async saveSettings(): Promise<void> {
    const data = ((await this.loadData()) as InkClawData | null) || {};
    data.settings = this.settings;
    await this.saveData(data);
  }

  private async readCursor(): Promise<number> {
    const data = ((await this.loadData()) as InkClawData | null) || {};
    const c = Number(data.cursor);
    return Number.isFinite(c) ? c : 0;
  }

  private async writeCursor(n: number): Promise<void> {
    const data = ((await this.loadData()) as InkClawData | null) || {};
    data.cursor = n;
    await this.saveData(data);
  }

  /** 刷新状态栏文字:同步中 / 未绑定 / 上次同步时间 + 游标。 */
  private updateStatus(): void {
    if (!this.statusBarEl) {
      return;
    }
    if (this.syncing) {
      this.statusBarEl.setText("Inklaw: 同步中…");
      return;
    }
    if (!this.settings.token) {
      this.statusBarEl.setText("Inklaw: 未绑定");
      return;
    }
    if (this.lastSyncTs > 0) {
      const d = new Date(this.lastSyncTs);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      this.statusBarEl.setText("Inklaw · " + hh + ":" + mm + " · 游标 " + this.lastCursor);
    } else {
      this.statusBarEl.setText("Inklaw · 就绪(游标 " + this.lastCursor + ")");
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
        return { ok: false, noteCount: 0, message: "响应异常,确认 apiBase 指向 Inklaw 后端" };
      }
      const n = Number(j.note_count) || 0;
      return { ok: true, noteCount: n, message: "已绑定 ✓ · 共 " + n + " 篇笔记" };
    } catch (e) {
      console.error("[Inklaw] 连接测试失败", e);
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
        new Notice("Inklaw 正在同步中…");
      }
      return;
    }
    if (!this.settings.token || !this.settings.apiBase) {
      if (manual) {
        new Notice("Inklaw: 请先在设置里填 apiBase 和 token");
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
          new Notice("Inklaw: " + probe.message);
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
          const line = "[Inklaw] " + msg;
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
        new Notice(n > 0 ? "Inklaw: 同步了 " + n + " 篇新笔记" : "Inklaw: 没有新笔记");
      }
    } catch (e) {
      console.error("[Inklaw] 同步异常", e);
      if (manual) {
        const msg = e instanceof Error && e.message ? e.message : "同步出错,详见控制台";
        new Notice("Inklaw: " + msg);
      }
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  /** 全量重拉:重置游标为 0 再同步一次(服务端所有笔记重新写入)。reentrancy 保护。 */
  async resyncAll(): Promise<void> {
    if (this.syncing) {
      new Notice("Inklaw 正在同步中…");
      return;
    }
    await this.writeCursor(0);
    new Notice("Inklaw: 已重置游标,开始全量重拉…");
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
    new Setting(containerEl).setName("墨爪 Inklaw 同步").setHeading();

    // 顶部引导:默认手动,讲清怎么拉 + 怎么改自动。
    containerEl.createEl("p", {
      cls: "inkclaw-intro",
      text:
        "默认「手动同步」:填好 token 后,点下方「同步」按钮、左侧 🔄 图标或命令「立即同步」即可拉取笔记。" +
        "想让它每 60 秒自动拉,把下面的「自动同步」打开即可。",
    });

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
    const connStatusEl = connSetting.descEl.createDiv({ cls: "inkclaw-conn-status" });
    connSetting.addButton((btn) =>
      btn.setButtonText("测试连接").onClick(async () => {
        connStatusEl.setText("测试中…");
        connStatusEl.removeClass("is-success", "is-error");
        connStatusEl.addClass("is-muted");
        const r = await this.plugin.testConnection();
        const manualHint = r.ok && !this.plugin.settings.autoSync ? " —— 手动模式,记得点「同步」拉取" : "";
        connStatusEl.setText(r.message + manualHint);
        connStatusEl.removeClass("is-muted");
        connStatusEl.toggleClass("is-success", r.ok);
        connStatusEl.toggleClass("is-error", !r.ok);
      })
    );

    new Setting(containerEl)
      .setName("目标目录")
      .setDesc("笔记写入的 vault 目录(相对 vault 根)")
      .addText((text) =>
        text
          .setPlaceholder("Inklaw")
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
        "默认关(手动):只在你点「同步」/左侧图标/命令时才拉。多台设备共用同一个 vault" +
          "(iCloud / Obsidian Sync)时保持关闭,避免后台同时拉取双写、产生冲突副本。\n" +
          "打开:每 60 秒自动拉一次(并在启动时拉),适合单设备、想完全省心。"
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
          new Notice(value ? "Inklaw:已开启自动同步(每 60 秒)" : "Inklaw:已切回手动同步,点「同步」才拉");
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
        // 注:不用 setDestructive()——它比 manifest 声明的 minAppVersion 1.4.0 新,会触发
        // obsidianmd/no-unsupported-api 错误。setWarning() 自 1.4.0 起就有(仅被标记 deprecated,
        // 是非阻断的 Recommendation),保留低 minAppVersion 以兼容旧版 / 手机端。
        btn
          .setButtonText("全量重拉")
          .setWarning()
          .onClick(() => {
            void this.plugin.resyncAll();
          })
      );
  }
}
