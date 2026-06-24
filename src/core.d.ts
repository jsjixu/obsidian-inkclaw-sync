/**
 * 给 src/sync.mjs(纯 JS 零依赖核心)的类型声明,让 tsc 在 main.ts 里 import 它时满意。
 * 这些类型也是 track B 后端同步契约 /api/v1/notes 的 TS 镜像。
 */

/** 单个媒体附件(封面/图片)。local_name 是 Obsidian 嵌入用的文件名,url 是下载源。 */
export interface SyncMedia {
  local_name: string;
  url: string;
}

/** 后端返回的单篇笔记。 */
export interface SyncNote {
  id: number;
  filename: string;
  title: string;
  source: string;
  created_ts: number;
  markdown: string;
  media: SyncMedia[];
}

/** GET /api/v1/notes?since= 的响应体。 */
export interface NotesResponse {
  notes: SyncNote[];
  cursor: number;
}

export type LogLevel = "info" | "warn" | "error";

/** syncOnce 的注入依赖。所有副作用都从这里进。 */
export interface SyncDeps {
  fetchJson: (since: number) => Promise<NotesResponse>;
  downloadMedia: (localName: string, url: string) => Promise<void>;
  writeNote: (filename: string, markdown: string) => Promise<void>;
  readCursor: () => Promise<number> | number;
  writeCursor: (cursor: number) => Promise<void>;
  log?: (level: LogLevel, msg: string, err?: unknown) => void;
  attachmentsFolder?: string;
  /** 判断某个媒体文件是否已落到附件目录里;返回假 → 其 ![[]] 内嵌会被剔除。可选(未注入则不自愈)。 */
  mediaExists?: (localName: string) => Promise<boolean> | boolean;
}

/**
 * 把 markdown 里的 `![[local_name]]` 改写成指向附件子目录的相对路径(只动 mediaList 里的项)。
 */
export function rewriteEmbeds(
  markdown: string,
  mediaList: Array<{ local_name: string; url?: string }>,
  attachmentsFolder: string
): string;

/**
 * 从 markdown 里剔除指定 local_name 的内嵌 `![[name]]`(缺图封面 → 防 Obsidian 幽灵节点)。
 */
export function stripEmbeds(
  markdown: string,
  names: Set<string> | { has: (s: string) => boolean },
  attachmentsFolder: string
): string;

/**
 * 执行一次同步,返回(已持久化的)新游标。单条失败不影响整批,fetch 失败不崩。
 */
export function syncOnce(deps: SyncDeps): Promise<number>;
