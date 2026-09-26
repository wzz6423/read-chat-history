'use strict';

const fs = require('node:fs');
const path = require('node:path');
const kimi = require('./kimi');
const trae = require('./trae');

function json(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function readJson(file) {
  try { return json(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function records(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map(json)
      .filter((row) => row && typeof row === 'object' && !Array.isArray(row));
  } catch { return []; }
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function epoch(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? (value > 1e11 ? value / 1000 : value) : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed / 1000;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && ['text', 'input_text', 'output_text'].includes(part.type))
    .map((part) => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function title(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

function toolText(name, input) {
  const body = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  return `[调用工具 ${typeof name === 'string' ? name : '?'}] ${body.slice(0, 200)}`;
}

function withDatabase(file, source, read) {
  if (!stat(file)?.isFile()) return [];
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    return read(db);
  } catch (error) {
    const reason = error.code === 'ERR_UNKNOWN_BUILTIN_MODULE' ? '需要 Node.js 22.13 或更新版本' : String(error.code || '格式不受支持');
    console.error(`无法读取 ${source} 数据库（${reason}），请检查版本、权限和数据库是否完整。`);
    return [];
  } finally {
    db?.close();
  }
}

function grokCollect({ home, root }) {
  const sessions = path.join(root || path.join(home, '.grok'), 'sessions');
  const out = [];
  for (const group of entries(sessions)) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(sessions, group.name);
    for (const entry of entries(groupDir)) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(groupDir, entry.name);
      const meta = readJson(path.join(dir, 'summary.json')) || {};
      const file = path.join(dir, 'updates.jsonl');
      const info = stat(file);
      if (!info?.isFile()) continue;
      let project = typeof meta.info?.cwd === 'string' ? meta.info.cwd : '';
      if (!project) {
        try { project = fs.readFileSync(path.join(groupDir, '.cwd'), 'utf8').trim(); } catch {
          try { project = decodeURIComponent(group.name); } catch { project = group.name; }
        }
      }
      out.push({
        source: 'grok', id: typeof meta.info?.id === 'string' ? meta.info.id : entry.name,
        path: file, project, title: title(meta.generated_title || meta.session_summary),
        start: epoch(meta.created_at) || info.mtimeMs / 1000,
        end: Math.max(epoch(meta.last_active_at) || 0, epoch(meta.updated_at) || 0, info.mtimeMs / 1000),
        size: info.size, prompts: 0,
      });
    }
  }
  return out;
}

function grokMessages(session, withTools) {
  const messages = [];
  let pending;
  function flush() {
    if (pending?.text.trim()) messages.push({ role: pending.role, ts: pending.ts, text: pending.text.trim() });
    pending = null;
  }
  for (const row of records(session.path)) {
    if (row.method !== 'session/update') continue;
    const update = row.params?.update;
    if (!update || typeof update !== 'object') continue;
    const kind = update.sessionUpdate;
    const role = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'assistant' : null;
    if (role) {
      const text = update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : '';
      if (!text) continue;
      const prompt = update._meta?.promptIndex;
      if (pending && (pending.role !== role || (prompt !== undefined && prompt !== pending.prompt))) flush();
      if (!pending) pending = { role, ts: epoch(row.timestamp), text: '', prompt };
      pending.text += text;
    } else if (kind === 'tool_call') {
      flush();
      if (withTools) messages.push({ role: 'tool', ts: epoch(row.timestamp), text: toolText(update.title || update.kind, update.rawInput) });
    } else if (kind === 'turn_completed') {
      flush();
    }
  }
  flush();
  return messages;
}

function workbuddyCollect({ home, root }) {
  const base = root || path.join(home, '.workbuddy');
  const db = path.join(base, 'workbuddy.db');
  const index = new Map(withDatabase(db, 'workbuddy', (connection) => connection.prepare('SELECT * FROM sessions').all())
    .map((row) => [row.id, row]));
  const out = [];
  const projects = path.join(base, 'projects');
  for (const group of entries(projects)) {
    if (!group.isDirectory()) continue;
    const dir = path.join(projects, group.name);
    for (const entry of entries(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry.name);
      const info = stat(file);
      if (!info?.isFile()) continue;
      const rows = records(file);
      const first = rows.find((row) => row.type === 'message' && ['user', 'assistant'].includes(row.role));
      if (!first) continue;
      const id = typeof first.sessionId === 'string' ? first.sessionId : entry.name.slice(0, -6);
      const meta = index.get(id) || {};
      if (meta.deleted_at) continue;
      const last = rows.findLast((row) => epoch(row.timestamp));
      const prompt = rows.find((row) => row.type === 'message' && row.role === 'user');
      const aiTitle = rows.findLast((row) => row.type === 'ai-title');
      out.push({
        source: 'workbuddy', id, path: file,
        project: typeof meta.cwd === 'string' ? meta.cwd : typeof first.cwd === 'string' ? first.cwd : '',
        title: title(meta.custom_title || meta.title || aiTitle?.aiTitle || textContent(prompt?.content)),
        start: epoch(meta.created_at) || epoch(first.timestamp) || info.mtimeMs / 1000,
        end: Math.max(epoch(meta.last_activity_at) || 0, epoch(meta.updated_at) || 0, epoch(last?.timestamp) || 0, info.mtimeMs / 1000),
        size: info.size, prompts: rows.filter((row) => row.type === 'message' && row.role === 'user').length,
      });
    }
  }
  return out;
}

function workbuddyMessages(session, withTools) {
  return records(session.path).flatMap((row) => {
    const ts = epoch(row.timestamp);
    if (row.type === 'message' && ['user', 'assistant'].includes(row.role)) {
      const text = textContent(row.content).trim();
      return text ? [{ role: row.role, ts, text }] : [];
    }
    if (withTools && row.type === 'function_call') {
      return [{ role: 'tool', ts, text: toolText(row.name, row.arguments) }];
    }
    return [];
  });
}

function zcodeCollect({ home, root }) {
  const file = path.join(root || path.join(home, '.zcode'), 'cli', 'db', 'db.sqlite');
  return withDatabase(file, 'zcode', (db) => db.prepare('SELECT * FROM session').all().flatMap((row) => {
    if (typeof row.id !== 'string' || row.parent_id) return [];
    return [{
      source: 'zcode', id: row.id, path: file,
      project: typeof row.directory === 'string' ? row.directory : '', title: title(row.title),
      start: epoch(row.time_created) || 0, end: epoch(row.time_updated || row.time_created) || 0,
      size: 0, prompts: 0,
    }];
  }));
}

function zcodeMessages(session, withTools) {
  return withDatabase(session.path, 'zcode', (db) => {
    const rows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY sequence, time_created, id').all(session.id);
    const parts = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY sequence, time_created, id').all(session.id);
    const grouped = new Map();
    for (const row of parts) {
      if (!grouped.has(row.message_id)) grouped.set(row.message_id, []);
      grouped.get(row.message_id).push(json(row.data));
    }
    return rows.flatMap((row) => {
      const data = json(row.data);
      if (!data || !['user', 'assistant'].includes(data.role) || data.synthetic || data.semantics?.transcriptVisibility === 'hidden') return [];
      const ts = epoch(row.time_created);
      const out = [];
      let text = '';
      const flush = () => {
        if (text.trim()) out.push({ role: data.role, ts, text: text.trim() });
        text = '';
      };
      for (const part of grouped.get(row.id) || []) {
        if (!part || part.synthetic) continue;
        if (part.type === 'text' && typeof part.text === 'string') text += (text ? '\n' : '') + part.text;
        else if (part.type === 'tool' && withTools) {
          flush();
          out.push({ role: 'tool', ts, text: toolText(part.tool, part.state?.input) });
        }
      }
      flush();
      return out;
    });
  });
}

const adapters = {
  grok: { collect: grokCollect, messages: grokMessages },
  workbuddy: { collect: workbuddyCollect, messages: workbuddyMessages },
  zcode: { collect: zcodeCollect, messages: zcodeMessages },
  kimi,
  trae,
};

function collect(source, config) {
  return Object.entries(adapters).flatMap(([name, adapter]) => source === 'all' || source === name ? adapter.collect(config) : []);
}

function messages(session, withTools) {
  return adapters[session.source]?.messages(session, withTools) || [];
}

module.exports = { collect, messages };
