/**
 * 墨爪 InkClaw —— Obsidian 同步插件的纯逻辑核心(零依赖 ES module)。
 *
 * 设计要点:本文件**不 import 'obsidian'**,所有副作用(HTTP / 文件写入 / 媒体下载 /
 * 游标读写 / 日志)都经参数注入。这样:
 *   - main.ts 把这些函数绑到 Obsidian 真实 API(requestUrl / vault adapter / saveData);
 *   - test/ 用 mock 注入,跑 `node --test` 无需任何 npm install。
 *
 * 消费的后端同步契约(由 track B 锁定):
 *   GET <apiBase>/api/v1/notes?since=<cursor>   (Header: Authorization: Bearer <token>)
 *   → { "notes": [ { id, filename, title, source, created_ts, markdown,
 *                    media: [ { local_name, url } ] } ],
 *       "cursor": <number> }
 * 游标 = 已处理过的最大 note id;下次只拉 id > since 的新笔记。
 */

/**
 * 把 markdown 里的 Obsidian 嵌入引用 `![[local_name]]` 映射到附件子目录下的相对路径。
 *
 * Obsidian 其实能按"文件名"在整个 vault 里解析 `![[name]]`,所以只要把附件文件写进
 * attachments 目录通常就够了。但为稳健起见(同名文件冲突 / 用户关了"按短名解析"),
 * 这里仍提供一个改写钩子:对每个已知 media 的 local_name,改写成 `![[<attachmentsFolder>/<local_name>]]`。
 *
 * 行为:
 *   - 只改写传入 mediaList 里出现过的 local_name(不碰用户自己写的其它 wikilink);
 *   - 幂等:若引用已经带了 attachmentsFolder 前缀,不再重复加;
 *   - attachmentsFolder 为空/未提供 → 原样返回(无前缀可加);
 *   - 同时兼容 `![[name]]` 与 `![[name|alias]]`(保留 alias)。
 *
 * @param {string} markdown 原始正文
 * @param {Array<{local_name: string, url?: string}>} mediaList 该笔记的媒体清单
 * @param {string} attachmentsFolder 附件子目录名(如 "attachments"),vault 内相对路径
 * @returns {string} 改写后的 markdown
 */
export function rewriteEmbeds(markdown, mediaList, attachmentsFolder) {
  const md = markdown == null ? '' : String(markdown);
  const folder = (attachmentsFolder == null ? '' : String(attachmentsFolder)).replace(/\/+$/, '');
  if (!folder || !Array.isArray(mediaList) || mediaList.length === 0) {
    return md;
  }
  // 收集本笔记关心的 local_name 集合(去空、去重)
  const names = new Set();
  for (const m of mediaList) {
    if (m && m.local_name) {
      names.add(String(m.local_name));
    }
  }
  if (names.size === 0) {
    return md;
  }
  const prefix = folder + '/';
  // 匹配 ![[ ... ]],内部可能含 |alias。捕获目标(target)与可选 alias。
  return md.replace(/!\[\[([^\]\|]+)(\|[^\]]*)?\]\]/g, (whole, target, alias) => {
    const t = String(target).trim();
    // 已带前缀 → 看去掉前缀后的纯文件名是否在集合里;在则视为已改写,保持原样。
    if (t.startsWith(prefix)) {
      const bare = t.slice(prefix.length);
      return names.has(bare) ? whole : whole;
    }
    if (!names.has(t)) {
      return whole; // 不是我们管的媒体,原样保留
    }
    return '![[' + prefix + t + (alias || '') + ']]';
  });
}

/**
 * 从 markdown 里**剔除**指定 local_name 的 Obsidian 内嵌引用 `![[name]]`。
 *
 * 用途:某张封面/图片最终在附件目录里不存在(下载失败 / URL 已过期 / 压根没 url)时,
 * 若仍保留 `![[name]]`,Obsidian 会把它画成指向不存在文件的「幽灵节点」(unresolved link),
 * 点一下还会误建空笔记。故这里在写盘前把这些注定解析不了的内嵌整段抹掉,正文其余不动。
 *
 * 行为:
 *   - 只剔除 names 集合里的 local_name(兼容裸名 `![[name]]` 与带 attachmentsFolder 前缀
 *     `![[folder/name]]`,后者用于已被 rewriteEmbeds 改写过的幂等重跑);
 *   - 独占一行的内嵌 → 连同该行(含换行)一并删除,不留空行;行内内嵌 → 只删 token;
 *   - 同时兼容 `![[name|alias]]`;names 为空 → 原样返回。纯字符串处理,无副作用。
 *
 * @param {string} markdown 原始正文
 * @param {Set<string>|{has:(s:string)=>boolean}} names 要剔除的 local_name 集合
 * @param {string} attachmentsFolder 附件子目录名(用于识别带前缀的已改写引用)
 * @returns {string} 剔除后的 markdown
 */
export function stripEmbeds(markdown, names, attachmentsFolder) {
  const md = markdown == null ? '' : String(markdown);
  if (!names || typeof names.has !== 'function' || md === '') {
    return md;
  }
  const folder = (attachmentsFolder == null ? '' : String(attachmentsFolder)).replace(/\/+$/, '');
  // 给定 ![[target]] 的 target,判断它(去掉可能的附件前缀后)是否在剔除集合里。
  const isDoomed = (target) => {
    let t = String(target).trim();
    if (folder && t.startsWith(folder + '/')) {
      t = t.slice(folder.length + 1);
    }
    return names.has(t);
  };
  // 1) 先删「独占一行」的注定内嵌(连同行尾换行,避免留空行)。
  let out = md.replace(/^[ \t]*!\[\[([^\]\|]+)(?:\|[^\]]*)?\]\][ \t]*(?:\r?\n|$)/gm,
    (whole, target) => (isDoomed(target) ? '' : whole));
  // 2) 再删任何残留的「行内」注定内嵌 token(保守兜底,正文里同行混排时)。
  out = out.replace(/!\[\[([^\]\|]+)(?:\|[^\]]*)?\]\]/g,
    (whole, target) => (isDoomed(target) ? '' : whole));
  return out;
}

/**
 * 取本笔记需要下载的媒体清单(local_name + url 都非空的项)。
 * @param {Object} note
 * @returns {Array<{local_name: string, url: string}>}
 */
function mediaToDownload(note) {
  const out = [];
  const list = note && Array.isArray(note.media) ? note.media : [];
  for (const m of list) {
    if (m && m.local_name && m.url) {
      out.push({ local_name: String(m.local_name), url: String(m.url) });
    }
  }
  return out;
}

/**
 * 执行一次同步:拉新笔记 → 逐条(下载媒体 + 改写引用 + 写文件)→ 推进并持久化游标。
 *
 * 容错原则:**单条笔记失败不影响整批**;游标只推进到"成功写入"的笔记里的最大 id,
 * 失败的笔记下次还会被重新拉到(因为它的 id 没被游标越过)。任何 fetch / 持久化异常
 * 都被捕获并经 log 报告,绝不让插件崩溃(返回当前游标)。
 *
 * 注入的副作用(全部可 await):
 *   - fetchJson(since) -> { notes, cursor }      拉取(track B 契约)
 *   - downloadMedia(localName, url) -> any        下载一个媒体到附件目录(自行判重/跳过)
 *   - writeNote(filename, markdown) -> any        写一篇笔记到 targetFolder/filename
 *   - readCursor() -> number                      读上次游标(0 表示从头)
 *   - writeCursor(n) -> any                        持久化新游标
 *   - log(level, msg, err?)                        日志("info"|"warn"|"error")
 * 配置:
 *   - attachmentsFolder: string                   附件子目录名(传给 rewriteEmbeds)
 *
 * @returns {Promise<number>} 同步后的(已持久化)游标值
 */
export async function syncOnce(deps) {
  const {
    fetchJson,
    downloadMedia,
    writeNote,
    readCursor,
    writeCursor,
    log,
    attachmentsFolder = 'attachments',
    mediaExists,
  } = deps || {};

  const report = typeof log === 'function' ? log : function () {};

  // 1) 读游标(失败回退 0,不崩)
  let since = 0;
  try {
    const c = await readCursor();
    since = Number.isFinite(c) ? Number(c) : 0;
  } catch (err) {
    report('warn', 'readCursor 失败,回退到 0', err);
    since = 0;
  }

  // 2) 拉取(失败 → 保持原游标返回,绝不崩)
  let payload;
  try {
    payload = await fetchJson(since);
  } catch (err) {
    report('error', 'fetchJson 失败,跳过本轮', err);
    return since;
  }
  if (!payload || !Array.isArray(payload.notes)) {
    report('warn', 'fetchJson 返回无 notes 数组,跳过本轮');
    return since;
  }

  const notes = payload.notes;
  if (notes.length === 0) {
    report('info', '没有新笔记');
    return since;
  }

  // 3) 逐条处理。游标推进到"成功写入"的最大 id。
  let maxOk = since;
  let wrote = 0;
  for (const note of notes) {
    const id = note && note.id != null ? Number(note.id) : NaN;
    const filename = note && note.filename ? String(note.filename) : '';
    if (!filename) {
      report('warn', 'note 缺 filename,跳过(id=' + String(note && note.id) + ')');
      continue;
    }
    try {
      // 3a) 下载媒体(逐个;单个失败不阻断本笔记其它媒体,但记 warn)
      const media = mediaToDownload(note);
      for (const m of media) {
        try {
          await downloadMedia(m.local_name, m.url);
        } catch (err) {
          report('warn', '媒体下载失败 ' + m.local_name + '(' + filename + '),继续', err);
        }
      }
      const mediaList = note && Array.isArray(note.media) ? note.media : [];
      // 3b) 自愈:下载后仍在附件目录里不存在的封面/图片(URL 过期/无 url/下载失败),
      //     剔除其 ![[]] 内嵌,免得 Obsidian 出指向不存在文件的幽灵节点。mediaExists 未注入
      //     则跳过本步(行为同旧版),不破坏离线单测。检查失败按「不存在」保守剔除。
      let body = note.markdown == null ? '' : String(note.markdown);
      if (typeof mediaExists === 'function') {
        const doomed = new Set();
        for (const m of mediaList) {
          if (!m || !m.local_name) {
            continue;
          }
          let present = false;
          try {
            present = !!(await mediaExists(String(m.local_name)));
          } catch (err) {
            report('warn', 'exists 检查失败 ' + m.local_name + '(' + filename + '),保守剔除引用', err);
            present = false;
          }
          if (!present) {
            doomed.add(String(m.local_name));
          }
        }
        if (doomed.size > 0) {
          report('warn', filename + ' 剔除 ' + doomed.size + ' 个缺图内嵌(封面下载不到)');
          body = stripEmbeds(body, doomed, attachmentsFolder);
        }
      }
      // 3c) 改写存活引用 → 写笔记
      body = rewriteEmbeds(body, mediaList, attachmentsFolder);
      await writeNote(filename, body);
      wrote += 1;
      if (Number.isFinite(id) && id > maxOk) {
        maxOk = id;
      }
    } catch (err) {
      report('error', '写笔记失败 ' + filename + ',跳过该条(游标不越过)', err);
    }
  }

  report('info', '本轮写入 ' + wrote + '/' + notes.length + ' 篇,游标 ' + since + ' → ' + maxOk);

  // 4) 持久化游标(只在前进时写;失败记 error 但不崩)
  if (maxOk > since) {
    try {
      await writeCursor(maxOk);
    } catch (err) {
      report('error', 'writeCursor 失败(下轮会重拉)', err);
      return since;
    }
  }
  return maxOk;
}
