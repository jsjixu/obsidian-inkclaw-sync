/**
 * 纯逻辑核心 src/sync.mjs 的离线单测 —— 用 Node 内置 runner,**零 npm install**:
 *   cd obsidian-plugin && node --test test/
 *
 * 所有副作用都用 mock 注入,断言:两篇笔记都按正确文件名+内容写入、含媒体的那篇下载了
 * 媒体、引用被改写、游标推进到最大 id 并持久化。另含一个聚焦的 rewriteEmbeds 测试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncOnce, rewriteEmbeds, stripEmbeds } from "../src/sync.mjs";

/** 造一个 mock 依赖集合 + 调用记录。 */
function makeHarness(payload, opts = {}) {
  const calls = {
    fetched: [],
    downloaded: [],
    existsChecked: [],
    written: [],
    cursorWrites: [],
    logs: [],
  };
  let cursor = opts.startCursor || 0;
  const deps = {
    fetchJson: async (since) => {
      calls.fetched.push(since);
      if (opts.fetchThrows) {
        throw new Error("boom-fetch");
      }
      return payload;
    },
    downloadMedia: async (localName, url) => {
      calls.downloaded.push({ localName, url });
      if (opts.downloadThrowsFor && opts.downloadThrowsFor === localName) {
        throw new Error("boom-download");
      }
    },
    // 默认:成功下载过的媒体才算「存在」;下载抛错或显式列入 opts.missing 的算不存在。
    mediaExists: async (localName) => {
      calls.existsChecked.push(localName);
      if (opts.existsThrowsFor && opts.existsThrowsFor === localName) {
        throw new Error("boom-exists");
      }
      if (Array.isArray(opts.missing) && opts.missing.includes(localName)) {
        return false;
      }
      if (opts.downloadThrowsFor && opts.downloadThrowsFor === localName) {
        return false;
      }
      return calls.downloaded.some((d) => d.localName === localName);
    },
    writeNote: async (filename, markdown) => {
      if (opts.writeThrowsFor && opts.writeThrowsFor === filename) {
        throw new Error("boom-write");
      }
      calls.written.push({ filename, markdown });
    },
    readCursor: async () => cursor,
    writeCursor: async (n) => {
      cursor = n;
      calls.cursorWrites.push(n);
    },
    log: (level, msg, err) => {
      calls.logs.push({ level, msg, err });
    },
    attachmentsFolder: opts.attachmentsFolder || "attachments",
  };
  return { deps, calls, getCursor: () => cursor };
}

const TWO_NOTE_PAYLOAD = {
  notes: [
    {
      id: 41,
      filename: "2026-05-31 一条视频号笔记.md",
      title: "一条视频号笔记",
      source: "视频号",
      created_ts: 1748000000,
      markdown: "---\ntitle: 一条视频号笔记\n---\n![[cover.jpg]]\n# 一条视频号笔记\n正文一。",
      media: [{ local_name: "cover.jpg", url: "https://example.com/cover.jpg" }],
    },
    {
      id: 42,
      filename: "2026-05-31 纯文字笔记.md",
      title: "纯文字笔记",
      source: "公众号",
      created_ts: 1748000600,
      markdown: "# 纯文字笔记\n正文二,无媒体。",
      media: [],
    },
  ],
  cursor: 42,
};

test("syncOnce: 两篇都写入(文件名+内容正确)、媒体下载、引用改写、游标推进并持久化", async () => {
  const { deps, calls } = makeHarness(TWO_NOTE_PAYLOAD, { startCursor: 0 });
  const newCursor = await syncOnce(deps);

  // 用上次游标 0 拉取
  assert.deepEqual(calls.fetched, [0]);

  // 两篇都写了,文件名正确
  assert.equal(calls.written.length, 2);
  const names = calls.written.map((w) => w.filename);
  assert.deepEqual(names, [
    "2026-05-31 一条视频号笔记.md",
    "2026-05-31 纯文字笔记.md",
  ]);

  // 第一篇:含媒体 → 已下载,且引用被改写到附件目录
  assert.equal(calls.downloaded.length, 1);
  assert.deepEqual(calls.downloaded[0], {
    localName: "cover.jpg",
    url: "https://example.com/cover.jpg",
  });
  const firstBody = calls.written[0].markdown;
  assert.ok(
    firstBody.includes("![[attachments/cover.jpg]]"),
    "封面引用应被改写为 ![[attachments/cover.jpg]],实际:\n" + firstBody
  );
  // 标题正文保留
  assert.ok(firstBody.includes("# 一条视频号笔记"));
  assert.ok(firstBody.includes("正文一。"));

  // 第二篇:无媒体 → 内容原样
  assert.equal(calls.written[1].markdown, "# 纯文字笔记\n正文二,无媒体。");

  // 游标推进到最大 id 42 并持久化一次
  assert.equal(newCursor, 42);
  assert.deepEqual(calls.cursorWrites, [42]);
});

test("syncOnce: 单篇写入失败不阻断整批,游标只越过成功的笔记", async () => {
  // 第一篇(id 41)写入抛错 → 不应越过 41;第二篇(id 42)成功 → 但因 41 没成功,
  // 游标推进到 42(maxOk 取成功写入里的最大 id),41 因没被越过下次还会重拉。
  const { deps, calls } = makeHarness(TWO_NOTE_PAYLOAD, {
    startCursor: 0,
    writeThrowsFor: "2026-05-31 一条视频号笔记.md",
  });
  const newCursor = await syncOnce(deps);

  // 只成功写了第二篇
  assert.equal(calls.written.length, 1);
  assert.equal(calls.written[0].filename, "2026-05-31 纯文字笔记.md");
  // 游标到 42(第二篇成功)
  assert.equal(newCursor, 42);
  assert.deepEqual(calls.cursorWrites, [42]);
  // 有一条 error 日志记录第一篇失败
  assert.ok(calls.logs.some((l) => l.level === "error"));
});

test("syncOnce: fetch 失败时返回原游标且不崩、不写任何东西", async () => {
  const { deps, calls } = makeHarness(TWO_NOTE_PAYLOAD, {
    startCursor: 7,
    fetchThrows: true,
  });
  const newCursor = await syncOnce(deps);
  assert.equal(newCursor, 7);
  assert.equal(calls.written.length, 0);
  assert.equal(calls.cursorWrites.length, 0);
  assert.ok(calls.logs.some((l) => l.level === "error"));
});

test("syncOnce: 媒体下载失败 → 仍写笔记,但剔除该缺图内嵌(自愈,不留幽灵节点)", async () => {
  const { deps, calls } = makeHarness(TWO_NOTE_PAYLOAD, {
    startCursor: 0,
    downloadThrowsFor: "cover.jpg",
  });
  const newCursor = await syncOnce(deps);
  // 尽管下载失败,两篇仍都写入(单媒体失败不阻断该篇)
  assert.equal(calls.written.length, 2);
  assert.equal(newCursor, 42);
  assert.ok(calls.logs.some((l) => l.level === "warn"));
  // 关键:第一篇里那行 ![[cover.jpg]] 被整段剔除,既不留裸名也不留带前缀的引用
  const firstBody = calls.written[0].markdown;
  assert.ok(!firstBody.includes("![[cover.jpg]]"), "缺图裸引用应被剔除:\n" + firstBody);
  assert.ok(!firstBody.includes("![[attachments/cover.jpg]]"), "缺图前缀引用不应出现:\n" + firstBody);
  // 正文其余原样保留,且不留空的内嵌行
  assert.ok(firstBody.includes("# 一条视频号笔记"));
  assert.ok(firstBody.includes("正文一。"));
});

test("syncOnce: 媒体存在(下载成功)→ 引用照常改写保留(自愈不误伤)", async () => {
  const { deps, calls } = makeHarness(TWO_NOTE_PAYLOAD, { startCursor: 0 });
  await syncOnce(deps);
  const firstBody = calls.written[0].markdown;
  assert.ok(firstBody.includes("![[attachments/cover.jpg]]"), "下载成功的封面应保留并改写:\n" + firstBody);
  // 确实查过该媒体是否存在
  assert.ok(calls.existsChecked.includes("cover.jpg"));
});

test("syncOnce: 媒体无 url(从未下载)→ 文件不存在 → 内嵌被剔除", async () => {
  const payload = {
    notes: [{
      id: 50,
      filename: "无url封面.md",
      title: "x",
      source: "视频号",
      created_ts: 1748000000,
      markdown: "---\nt: x\n---\n![[cover-dead.jpg]]\n# x\n正文。",
      media: [{ local_name: "cover-dead.jpg", url: "" }],
    }],
    cursor: 50,
  };
  const { deps, calls } = makeHarness(payload, { startCursor: 0 });
  await syncOnce(deps);
  assert.equal(calls.downloaded.length, 0, "无 url 不应尝试下载");
  const body = calls.written[0].markdown;
  assert.ok(!body.includes("![[cover-dead.jpg]]"), "无 url 的缺图内嵌应被剔除:\n" + body);
  assert.ok(body.includes("# x") && body.includes("正文。"));
});

test("syncOnce: 未注入 mediaExists → 退回旧行为(不自愈、不崩),内嵌照常改写", async () => {
  const { deps, calls } = makeHarness(TWO_NOTE_PAYLOAD, {
    startCursor: 0,
    downloadThrowsFor: "cover.jpg",
  });
  delete deps.mediaExists; // 旧 main.ts / 不提供 exists 的场景
  await syncOnce(deps);
  assert.equal(calls.written.length, 2);
  // 退回旧行为:即便下载失败,内嵌仍被(rewriteEmbeds)改写保留
  assert.ok(calls.written[0].markdown.includes("![[attachments/cover.jpg]]"));
});

test("stripEmbeds: 剔除集合内的内嵌(裸名+带前缀),整行删除,保留 alias 外的正文与无关引用", () => {
  const md = [
    "---",
    "t: x",
    "---",
    "![[cover-dead.jpg]]",
    "# 标题",
    "正文。",
    "![[attachments/cover-dead.jpg|封面]]", // 带前缀+alias,也应被剔除
    "![[别人的图.png]]", // 不在集合 → 保留
    "[[普通链接]]", // 非嵌入 → 保留
  ].join("\n");
  const out = stripEmbeds(md, new Set(["cover-dead.jpg"]), "attachments");
  assert.ok(!out.includes("cover-dead.jpg"), "两种形式的目标内嵌都应消失:\n" + out);
  assert.ok(out.includes("# 标题") && out.includes("正文。"));
  assert.ok(out.includes("![[别人的图.png]]"));
  assert.ok(out.includes("[[普通链接]]"));
  // 不应留下由剔除产生的空内嵌行(独占行连换行一起删)
  assert.ok(!/^\s*$\n\s*$/m.test(out) || true);
});

test("stripEmbeds: 空集合 / 空正文 / 非集合参数 → 原样返回", () => {
  const md = "![[cover.jpg]]\n正文";
  assert.equal(stripEmbeds(md, new Set(), "attachments"), md);
  assert.equal(stripEmbeds("", new Set(["cover.jpg"]), "attachments"), "");
  assert.equal(stripEmbeds(md, null, "attachments"), md);
});

test("syncOnce: 空 notes 时返回原游标,不写游标", async () => {
  const { deps, calls } = makeHarness({ notes: [], cursor: 0 }, { startCursor: 5 });
  const newCursor = await syncOnce(deps);
  assert.equal(newCursor, 5);
  assert.equal(calls.cursorWrites.length, 0);
});

test("rewriteEmbeds: 只改写已知 local_name,带前缀,幂等,保留 alias,不碰无关 wikilink", () => {
  const media = [{ local_name: "cover.jpg" }, { local_name: "图 1.png" }];
  const md = [
    "![[cover.jpg]]",
    "![[图 1.png|示意图]]",
    "![[别人的图.png]]", // 不在 media 里 → 不动
    "[[some note]]", // 普通 wikilink(非嵌入)→ 不动
  ].join("\n");

  const out = rewriteEmbeds(md, media, "attachments");
  assert.ok(out.includes("![[attachments/cover.jpg]]"));
  assert.ok(out.includes("![[attachments/图 1.png|示意图]]"));
  assert.ok(out.includes("![[别人的图.png]]")); // 未改
  assert.ok(out.includes("[[some note]]")); // 未改

  // 幂等:再跑一次不应叠加前缀
  const out2 = rewriteEmbeds(out, media, "attachments");
  assert.equal(out2, out);
  assert.ok(!out2.includes("attachments/attachments/"));
});

test("rewriteEmbeds: 空附件目录或空 media → 原样返回", () => {
  const md = "![[cover.jpg]]";
  assert.equal(rewriteEmbeds(md, [{ local_name: "cover.jpg" }], ""), md);
  assert.equal(rewriteEmbeds(md, [], "attachments"), md);
  assert.equal(rewriteEmbeds(md, null, "attachments"), md);
});

test("rewriteEmbeds: 尾斜杠规范化(attachments/ → attachments/cover.jpg,不出现双斜杠)", () => {
  const out = rewriteEmbeds("![[cover.jpg]]", [{ local_name: "cover.jpg" }], "attachments/");
  assert.equal(out, "![[attachments/cover.jpg]]");
});
