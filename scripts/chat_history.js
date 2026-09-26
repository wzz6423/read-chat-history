#!/usr/bin/env node
/**
 * chat-history — 只读访问本地 AI 工具的历史会话。
 *
 * 零依赖（仅 Node.js 内置模块），跨平台（macOS / Linux / Windows）。
 *
 * 子命令:
 *   list    列出会话（可按来源/项目/时间过滤）
 *   show    读取某个会话的消息（支持 --head/--tail/--range/--role 局部读取）
 *   search  按关键词搜索历史会话（默认搜提问索引，--content 全文搜索）
 *   last    显示某项目最近一次（自动跳过疑似当前会话）的会话内容
 *
 * 示例:
 *   node chat_history.js list --cwd --limit 10
 *   node chat_history.js list --since 2026-06-01 --until "2026-06-10 18:00" --source codex
 *   node chat_history.js show 0ff7c0f9 --tail 10
 *   node chat_history.js show 019eb45d --range 3:8 --full
 *   node chat_history.js search "读写分离" --content
 *   node chat_history.js last --project new-api
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const providers = require('./providers');

const SOURCES = ['all', 'claude', 'codex', 'grok', 'workbuddy', 'kimi', 'zcode', 'trae'];
let HOME;
let CC_PROJECTS;
let CC_HISTORY;
let CODEX_SESSIONS;
let CODEX_INDEX;
let CODEX_HISTORY;
let providerConfig;

function configurePaths(o) {
  HOME = path.resolve(o.home || os.homedir());
  const root = o['source-root'] ? path.resolve(o['source-root']) : undefined;
  const claude = o.source === 'claude' && root ? root : path.join(HOME, '.claude');
  const codex = o.source === 'codex' && root ? root : path.join(HOME, '.codex');
  CC_PROJECTS = path.join(claude, 'projects');
  CC_HISTORY = path.join(claude, 'history.jsonl');
  CODEX_SESSIONS = path.join(codex, 'sessions');
  CODEX_INDEX = path.join(codex, 'session_index.jsonl');
  CODEX_HISTORY = path.join(codex, 'history.jsonl');
  providerConfig = { home: HOME, root };
}

const CODEX_FN = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F-]{8,})\.jsonl$/;

// Claude Code 会话里非真实对话的注入内容，读取时跳过
const SKIP_PREFIX = [
  '<command-name>', '<local-command', '<command-message', '<command-args',
  'Caveat:', '<system-reminder', '<task-notification', '<bash-input',
  '<bash-stdout', '<bash-stderr',
];

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function jparse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

function readLines(file) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return data.split('\n');
}

function readFirstLine(file) {
  // 只读首行（codex 首行 session_meta 可能很大，限 2MB）
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  try {
    const chunk = Buffer.alloc(65536);
    let acc = Buffer.alloc(0);
    let pos = 0;
    while (acc.length < 2 * 1024 * 1024) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      acc = Buffer.concat([acc, chunk.subarray(0, n)]);
      const i = acc.indexOf(0x0a);
      if (i >= 0) return acc.subarray(0, i).toString('utf8');
    }
    return acc.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseWhen(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) die(`无法解析时间: "${s}"（支持 YYYY-MM-DD [HH:MM[:SS]]）`);
  const [year, month, day, hour, minute, second] = m.slice(1).map((n) => +(n || 0));
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  d.setHours(hour, minute, second, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day ||
      d.getHours() !== hour || d.getMinutes() !== minute || d.getSeconds() !== second) {
    die(`无效日期或时间: "${s}"`);
  }
  return d.getTime() / 1000;
}

function fmtTs(epoch) {
  if (!epoch) return '?';
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isoToEpoch(s) {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t / 1000;
}

function shortPath(p) {
  if (p && (p === HOME || p.startsWith(HOME + path.sep))) return '~' + p.slice(HOME.length);
  return p || '';
}

function projectMatches(project, query) {
  if (!query) return true;
  if (string(project).toLowerCase().includes(query.toLowerCase())) return true;
  if (!path.isAbsolute(string(project)) || !path.isAbsolute(query)) return false;
  try {
    return fs.realpathSync(project).toLowerCase().includes(fs.realpathSync(query).toLowerCase());
  } catch { return false; }
}

// ---------------- 收集会话 ----------------

function ccCollect() {
  // Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl + history.jsonl 索引
  const idx = Object.create(null);
  for (const line of readLines(CC_HISTORY)) {
    const d = jparse(line);
    if (!d || !d.sessionId) continue;
    let e = idx[d.sessionId];
    if (!e) {
      e = idx[d.sessionId] = {
        prompt: string(d.display),
        project: string(d.project),
        start: (d.timestamp || 0) / 1000,
        prompts: 0,
      };
    }
    e.prompts++;
  }
  const out = [];
  let slugs;
  try { slugs = fs.readdirSync(CC_PROJECTS); } catch { return out; }
  for (const slug of slugs) {
    const pdir = path.join(CC_PROJECTS, slug);
    let st0;
    try { st0 = fs.statSync(pdir); } catch { continue; }
    if (!st0.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(pdir); } catch { continue; }
    for (const fn of files) {
      if (!fn.endsWith('.jsonl')) continue;
      const fp = path.join(pdir, fn);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      const sid = fn.slice(0, -6);
      const e = idx[sid] || {};
      const first = jparse(readFirstLine(fp));
      out.push({
        source: 'claude', id: sid, path: fp,
        project: e.project || string(first?.cwd) || slug,
        title: (e.prompt || '').replace(/\n/g, ' ').trim().slice(0, 80),
        start: e.start || st.mtimeMs / 1000,
        end: st.mtimeMs / 1000, size: st.size,
        prompts: e.prompts || 0,
      });
    }
  }
  return out;
}

function codexTitles() {
  const t = Object.create(null);
  for (const line of readLines(CODEX_INDEX)) {
    const d = jparse(line);
    if (d && d.id) t[d.id] = string(d.thread_name);
  }
  return t;
}

function walkFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function codexCollect() {
  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl
  const out = [];
  const titles = codexTitles();
  for (const fp of walkFiles(CODEX_SESSIONS)) {
    const m = CODEX_FN.exec(path.basename(fp));
    if (!m) continue;
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    const [, y, mo, dd, hh, mi, ss, sid] = m;
    const d = new Date(+y, +mo - 1, +dd, +hh, +mi, +ss);
    const meta = jparse(readFirstLine(fp));
    const start = isoToEpoch(meta?.timestamp) || isoToEpoch(meta?.payload?.timestamp) ||
      (Number.isNaN(d.getTime()) ? st.mtimeMs / 1000 : d.getTime() / 1000);
    out.push({
      source: 'codex', id: sid, path: fp,
      project: meta?.type === 'session_meta' ? string(meta.payload?.cwd) : '',
      title: (titles[sid] || '').replace(/\n/g, ' ').trim().slice(0, 80),
      start, end: st.mtimeMs / 1000, size: st.size, prompts: 0,
    });
  }
  return out;
}

function collect(source) {
  let out = [];
  if (source === 'all' || source === 'claude') out = out.concat(ccCollect());
  if (source === 'all' || source === 'codex') out = out.concat(codexCollect());
  return out.concat(providers.collect(source, providerConfig));
}

function filterSessions(sessions, since, until, project) {
  const out = sessions.filter((s) => {
    if (since !== null && s.end < since) return false;
    if (until !== null && s.start > until) return false;
    if (!projectMatches(s.project, project)) return false;
    return true;
  });
  out.sort((a, b) => b.end - a.end);
  return out;
}

function resolve(sidPrefix, source) {
  const separator = sidPrefix.indexOf(':');
  if (separator >= 0) {
    const qualifiedSource = sidPrefix.slice(0, separator);
    if (!SOURCES.includes(qualifiedSource) || qualifiedSource === 'all') die(`未知会话来源: ${qualifiedSource}`);
    if (source !== 'all' && source !== qualifiedSource) die('会话来源与 --source 不一致。');
    source = qualifiedSource;
    sidPrefix = sidPrefix.slice(separator + 1);
  }
  if (!sidPrefix) die('会话 id 前缀不能为空。');
  const matches = collect(source).filter((s) => s.id.startsWith(sidPrefix));
  if (matches.length === 0) die(`找不到 id 以 "${sidPrefix}" 开头的会话（来源: ${source}）`);
  if (matches.length > 1) {
    const ids = matches.slice(0, 10).map((m) => `${m.source}:${m.id.slice(0, 12)}`).join(', ');
    die(`id 前缀 "${sidPrefix}" 匹配到多个会话: ${ids}，请加长前缀或用 --source 限定`);
  }
  return matches[0];
}

// ---------------- 提取消息 ----------------

function ccMessages(file, withTools) {
  const msgs = [];
  for (const line of readLines(file)) {
    const d = jparse(line);
    if (!d || (d.type !== 'user' && d.type !== 'assistant')) continue;
    if (d.isSidechain) continue; // 子代理对话，跳过
    const m = d.message || {};
    const role = m.role || d.type;
    if (!['user', 'assistant'].includes(role)) continue;
    const ts = isoToEpoch(d.timestamp);
    const c = m.content;
    const parts = [];
    if (typeof c === 'string') {
      parts.push(c);
    } else if (Array.isArray(c)) {
      for (const item of c) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text') {
          parts.push(string(item.text));
        } else if (item.type === 'tool_use' && withTools) {
          let arg = '';
          try { arg = JSON.stringify(item.input || {}); } catch { /* ignore */ }
          parts.push(`[调用工具 ${item.name}] ${arg.slice(0, 200)}`);
        }
      }
    }
    const text = parts.filter(Boolean).join('\n').trim();
    if (!text || SKIP_PREFIX.some((p) => text.startsWith(p))) continue;
    msgs.push({ role, ts, text });
  }
  return msgs;
}

function codexMessages(file, withTools) {
  const msgs = [];
  const fallback = [];
  const injectedPrefixes = ['<environment_context>', '<permissions instructions>', '<turn_aborted>', '<system-reminder>', '# AGENTS.md instructions'];
  for (const [ordinal, line] of readLines(file).entries()) {
    const d = jparse(line);
    if (!d) continue;
    const ts = isoToEpoch(d.timestamp);
    const t = d.type;
    const p = d.payload || {};
    const pt = p.type;
    if (t === 'event_msg' && pt === 'user_message') {
      msgs.push({ role: 'user', ts, text: string(p.message).trim(), ordinal });
    } else if (t === 'event_msg' && pt === 'agent_message') {
      msgs.push({ role: 'assistant', ts, text: string(p.message).trim(), ordinal });
    } else if (t === 'response_item' && pt === 'function_call' && withTools) {
      msgs.push({ role: 'tool', ts, text: `[调用工具 ${p.name}] ${string(p.arguments).slice(0, 200)}`, ordinal });
    } else if (t === 'response_item' && pt === 'message') {
      // 旧版/兜底路径：从 response_item 提取，过滤注入的环境上下文
      const texts = (Array.isArray(p.content) ? p.content : [])
        .filter((c) => c && (c.type === 'input_text' || c.type === 'output_text'))
        .map((c) => string(c.text));
      const text = texts.filter(Boolean).join('\n').trim();
      if (text && ['user', 'assistant'].includes(p.role) && p.channel !== 'analysis' &&
          !injectedPrefixes.some((prefix) => text.startsWith(prefix))) {
        fallback.push({ role: p.role, ts, text, ordinal });
      }
    }
  }
  const eventCopies = new Map();
  for (const message of msgs) {
    if (message.role === 'tool') continue;
    const key = `${message.role}\0${message.text}`;
    if (!eventCopies.has(key)) eventCopies.set(key, []);
    eventCopies.get(key).push(message);
  }
  for (const message of fallback) {
    const copy = eventCopies.get(`${message.role}\0${message.text}`)?.shift();
    if (copy) copy.ordinal = Math.min(copy.ordinal, message.ordinal);
    else msgs.push(message);
  }
  return msgs.filter((message) => message.text).sort((a, b) => a.ordinal - b.ordinal)
    .map(({ ordinal, ...message }) => message);
}

function sessionMessages(s, withTools) {
  if (s.source === 'claude') return ccMessages(s.path, withTools);
  if (s.source === 'codex') return codexMessages(s.path, withTools);
  return providers.messages(s, withTools);
}

// ---------------- 输出 ----------------

function publicSession(s) {
  const { source, id, path: file, project, title, start, end, size, prompts } = s;
  return { source, id, path: file, project, title, start, end, size, prompts };
}

function printSessionHeader(s, total, lo, hi) {
  console.log(`会话: [${s.source}] ${s.id}`);
  console.log(`项目: ${shortPath(s.project)}`);
  console.log(`时间: ${fmtTs(s.start)} → ${fmtTs(s.end)}   文件: ${shortPath(s.path)}`);
  if (s.title) console.log(`标题: ${s.title}`);
  console.log(`共 ${total} 条消息，显示第 ${lo}–${hi} 条`);
  console.log('-'.repeat(60));
}

function printMessages(msgs, startNo, maxChars) {
  let no = startNo;
  for (const m of msgs) {
    let text = m.text;
    let suffix = '';
    if (maxChars && text.length > maxChars) {
      suffix = `\n  …(已截断，全文 ${text.length} 字符，用 --full 或调大 --max-chars 查看)`;
      text = text.slice(0, maxChars);
    }
    const body = text.split('\n').map((ln) => '  ' + ln).join('\n');
    console.log(`\n#${no} [${m.role}] ${fmtTs(m.ts)}`);
    console.log(body + suffix);
    no++;
  }
}

function showSession(s, opts) {
  let msgs = sessionMessages(s, opts.tools);
  if (opts.role) msgs = msgs.filter((m) => m.role === opts.role);
  const total = msgs.length;
  let lo = 1;
  let hi = total;
  let sel;
  if (opts.range) {
    const mm = /^(\d+):(\d+)$/.exec(opts.range);
    if (!mm) die(`--range 格式应为 A:B（1 起始，闭区间），收到: "${opts.range}"`);
    lo = +mm[1];
    hi = Math.min(+mm[2], total);
    sel = msgs.slice(lo - 1, hi);
  } else if (opts.head) {
    hi = Math.min(opts.head, total);
    sel = msgs.slice(0, opts.head);
  } else if (opts.tail) {
    lo = Math.max(1, total - opts.tail + 1);
    sel = msgs.slice(lo - 1);
  } else {
    sel = msgs;
  }
  if (opts.json) {
    console.log(JSON.stringify({
      session: publicSession(s), total, from: sel.length ? lo : 0, to: sel.length ? hi : 0,
      messages: sel.map((message) => !opts.full && message.text.length > opts.maxChars
        ? { ...message, text: message.text.slice(0, opts.maxChars), truncated: true, originalChars: message.text.length }
        : message),
    }, null, 2));
    return;
  }
  printSessionHeader(s, total, sel.length ? lo : 0, sel.length ? hi : 0);
  if (!sel.length) {
    console.log('(没有可显示的消息)');
    return;
  }
  printMessages(sel, lo, opts.full ? null : opts.maxChars);
}

// ---------------- 子命令 ----------------

function cmdList(o) {
  const since = parseWhen(o.since);
  const until = parseWhen(o.until);
  const project = o.cwd ? process.cwd() : o.project;
  const all = filterSessions(collect(o.source), since, until, project);
  const rows = all.slice(0, o.limit);
  if (o.json) {
    console.log(JSON.stringify({ total: all.length, sessions: rows.map(publicSession) }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('没有匹配的会话。');
    return;
  }
  for (const s of rows) {
    let line2 = `   ${fmtTs(s.start)} → ${fmtTs(s.end)}   ${Math.floor(s.size / 1024)}KB`;
    if (s.prompts) line2 += `   提问 ${s.prompts} 次`;
    console.log(`[${s.source}] ${s.id}`);
    console.log(line2);
    console.log(`   项目: ${shortPath(s.project)}`);
    if (s.title) console.log(`   标题: ${s.title}`);
    console.log('');
  }
  console.log(`共 ${all.length} 个会话，已显示 ${rows.length} 个。用 \`show <id前缀>\` 查看内容。`);
}

function cmdShow(o) {
  const s = resolve(o.session, o.source);
  showSession(s, o);
}

function cmdSearch(o) {
  const kw = o.keyword.toLowerCase();
  const since = parseWhen(o.since);
  const until = parseWhen(o.until);
  const project = o.cwd ? process.cwd() : o.project;
  const sessions = filterSessions(collect(o.source), since, until, project);
  const metadata = new Map(sessions.map((s) => [`${s.source}:${s.id}`, s]));
  const hits = new Map(); // "source:sid" -> {source, sid, ts, project, excerpts}

  const add = (source, sid, ts, proj, text) => {
    if (since !== null && ts < since) return;
    if (until !== null && ts > until) return;
    if (!projectMatches(proj, project)) return;
    if (!text.toLowerCase().includes(kw)) return;
    const key = `${source}:${sid}`;
    let h = hits.get(key);
    if (!h) {
      h = { source, sid, ts: ts || 0, project: proj || '', excerpts: [] };
      hits.set(key, h);
    }
    h.ts = Math.max(h.ts, ts || 0);
    if (proj && !h.project) h.project = proj;
    if (h.excerpts.length < 2) {
      const pos = text.toLowerCase().indexOf(kw);
      const a = Math.max(0, pos - 40);
      h.excerpts.push(text.slice(a, pos + kw.length + 60).replace(/\n/g, ' '));
    }
  };

  if (o.content) {
    for (const s of sessions) {
      for (const m of sessionMessages(s, false)) {
        add(s.source, s.id, m.ts || s.end, s.project, m.text);
      }
    }
  } else {
    const indexed = new Set();
    if (o.source === 'all' || o.source === 'claude') {
      for (const line of readLines(CC_HISTORY)) {
        const d = jparse(line);
        if (!d || typeof d.sessionId !== 'string') continue;
        const key = `claude:${d.sessionId}`;
        indexed.add(key);
        const s = metadata.get(key);
        add('claude', d.sessionId, (d.timestamp || 0) / 1000, s?.project || string(d.project), string(d.display));
      }
    }
    if (o.source === 'all' || o.source === 'codex') {
      for (const line of readLines(CODEX_HISTORY)) {
        const d = jparse(line);
        if (!d || typeof d.session_id !== 'string') continue;
        const key = `codex:${d.session_id}`;
        indexed.add(key);
        add('codex', d.session_id, typeof d.ts === 'number' ? d.ts : 0, metadata.get(key)?.project || '', string(d.text));
      }
    }
    // 新来源没有通用提问索引；缺失索引的旧会话也从用户消息恢复搜索。
    for (const s of sessions) {
      if (indexed.has(`${s.source}:${s.id}`)) continue;
      for (const m of sessionMessages(s, false)) {
        if (m.role === 'user') add(s.source, s.id, m.ts || s.end, s.project, m.text);
      }
    }
  }

  const rows = [...hits.values()].sort((a, b) => b.ts - a.ts).slice(0, o.limit);
  if (o.json) {
    console.log(JSON.stringify({ total: hits.size, hits: rows }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(`没有找到包含 "${o.keyword}" 的会话。` +
      (o.content ? '' : '（默认只搜用户提问，加 --content 可全文搜索）'));
    return;
  }
  for (const h of rows) {
    console.log(`[${h.source}] ${h.sid}   ${fmtTs(h.ts)}   ${shortPath(h.project)}`);
    for (const ex of h.excerpts) console.log(`   …${ex}…`);
    console.log('');
  }
  console.log(`共命中 ${hits.size} 个会话，已显示 ${rows.length} 个。用 \`show <id前缀>\` 查看内容。`);
}

function cmdLast(o) {
  const project = o.project || process.cwd();
  const rows = filterSessions(collect(o.source), null, null, project);
  if (!rows.length) die(`项目 "${project}" 下没有找到任何会话。`);
  const now = Date.now() / 1000;
  // 跳过疑似仍在进行中的当前会话（最近 grace 秒内有写入）
  const candidates = rows.filter((s) => o.grace === 0 || now - s.end > o.grace);
  if (!candidates.length) die('匹配会话都在 --grace 时间内有活动；用 --grace 0 明确包含这些会话。');
  if (o.n > candidates.length) die(`仅有 ${candidates.length} 个符合条件的会话，无法读取倒数第 ${o.n} 个。`);
  showSession(candidates[o.n - 1], o);
}

// ---------------- 参数解析 ----------------

const USAGE = `用法: node chat_history.js <子命令> [选项]

子命令:
  list    列出会话
          --source all|claude|codex|grok|workbuddy|kimi|zcode|trae
          --project <子串>  --cwd
          --since <时间>  --until <时间>  --limit <N=20>
  show    读取某个会话（支持局部读取）
          <id前缀或source:id>  --head N | --tail N | --range A:B  --role user|assistant|tool
          --max-chars <N=800>  --full  --tools  --source ...
  search  按关键词搜索会话
          <关键词>  --content（全文搜索，较慢）  --project <子串>  --cwd
          --since/--until  --limit <N=20>  --source ...
  last    显示项目最近一次（非当前）会话
          --project <子串，默认当前目录>  -n <倒数第n个=1>  --tail <N=20>
          --role  --max-chars  --full  --tools  --grace <秒=120>  --source ...

通用选项:
  --home <目录>         从指定用户目录读取，默认系统用户目录
  --source-root <目录>  使用工具数据根目录，必须指定单一 --source
  --json                输出结构化 JSON，show/last 可配合 --full

时间格式: YYYY-MM-DD 或 "YYYY-MM-DD HH:MM[:SS]"（本地时区）
运行环境: Node.js >= 22.13；只读取本地文件与 SQLite，不请求网络。`;

const SPECS = {
  list: {
    vals: ['source', 'project', 'since', 'until', 'limit'],
    bools: ['cwd'],
    ints: ['limit'],
    pos: [],
    defaults: { source: 'all', limit: 20 },
    fn: cmdList,
  },
  show: {
    vals: ['source', 'head', 'tail', 'range', 'role', 'max-chars'],
    bools: ['full', 'tools'],
    ints: ['head', 'tail', 'max-chars'],
    pos: ['session'],
    defaults: { source: 'all', 'max-chars': 800 },
    fn: cmdShow,
  },
  search: {
    vals: ['source', 'project', 'since', 'until', 'limit'],
    bools: ['content', 'cwd'],
    ints: ['limit'],
    pos: ['keyword'],
    defaults: { source: 'all', limit: 20 },
    fn: cmdSearch,
  },
  last: {
    vals: ['source', 'project', 'n', 'tail', 'role', 'max-chars', 'grace'],
    bools: ['full', 'tools'],
    ints: ['n', 'tail', 'max-chars', 'grace'],
    pos: [],
    defaults: { source: 'all', n: 1, tail: 20, 'max-chars': 800, grace: 120 },
    fn: cmdLast,
  },
};

function parseArgv(argv, spec, cmd) {
  const o = { ...spec.defaults };
  const positionals = [];
  const valueOptions = [...spec.vals, 'home', 'source-root'];
  const booleanOptions = [...spec.bools, 'json'];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (a.startsWith('-') && a !== '-') {
      let name = a.replace(/^--?/, '');
      let val = null;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        val = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (booleanOptions.includes(name)) {
        if (val !== null) die(`选项 --${name} 不接受值。`);
        o[name] = true;
      } else if (valueOptions.includes(name)) {
        if (val === null) {
          val = argv[++i];
          if (val === undefined || val.startsWith('--')) die(`选项 --${name} 缺少值`);
        }
        if (!val) die(`选项 --${name} 的值不能为空。`);
        o[name] = val;
      } else {
        die(`未知选项: ${a}（子命令 ${cmd}）\n\n${USAGE}`);
      }
    } else {
      positionals.push(a);
    }
  }
  for (let j = 0; j < spec.pos.length; j++) {
    if (positionals[j] === undefined) die(`缺少参数 <${spec.pos[j]}>（子命令 ${cmd}）\n\n${USAGE}`);
    o[spec.pos[j]] = positionals[j];
  }
  if (positionals.length > spec.pos.length) {
    die(`多余的参数: ${positionals.slice(spec.pos.length).join(' ')}`);
  }
  for (const k of spec.ints) {
    if (o[k] !== undefined && o[k] !== null) {
      const v = Number(o[k]);
      if (!/^\d+$/.test(String(o[k])) || !Number.isSafeInteger(v) || v < (k === 'grace' ? 0 : 1)) {
        die(`选项 --${k} 需要${k === 'grace' ? '非负' : '正'}整数，收到: "${o[k]}"`);
      }
      o[k] = v;
    }
  }
  if (o.source && !SOURCES.includes(o.source)) {
    die(`--source 只能是 ${SOURCES.join('|')}，收到: "${o.source}"`);
  }
  if (o.role && !['user', 'assistant', 'tool'].includes(o.role)) {
    die(`--role 只能是 user|assistant|tool，收到: "${o.role}"`);
  }
  if (o['source-root'] && o.source === 'all') die('--source-root 必须配合单一 --source。');
  if (o.cwd && o.project) die('--cwd 与 --project 不能同时使用。');
  if (['head', 'tail', 'range'].filter((name) => o[name] !== undefined).length > 1) die('--head、--tail、--range 只能使用一个。');
  if (o.range) {
    const match = /^(\d+):(\d+)$/.exec(o.range);
    if (!match || +match[1] < 1 || +match[2] < +match[1] || !Number.isSafeInteger(+match[2])) {
      die('--range 格式应为 A:B，且 1 <= A <= B。');
    }
  }
  const since = parseWhen(o.since);
  const until = parseWhen(o.until);
  if (since !== null && until !== null && since > until) die('--since 不能晚于 --until。');
  if (o.keyword !== undefined && !o.keyword.trim()) die('搜索关键词不能为空。');
  o.maxChars = o['max-chars'];
  return o;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  const spec = SPECS[cmd];
  if (!spec) die(`未知子命令: ${cmd}\n\n${USAGE}`);
  const o = parseArgv(argv.slice(1), spec, cmd);
  configurePaths(o);
  spec.fn(o);
}

main();
