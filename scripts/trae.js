'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const STORAGE_KEY = /^memento\/icube-ai-(?:agent|ng-chat)-storage(?:-|$)/;

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function readJson(file) {
  try { return parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function epoch(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value / 1000 : null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed / 1000;
}

function withDatabase(file, fn) {
  if (!exists(file)) return [];
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    return fn(db);
  } catch (error) {
    console.error(`无法读取 TRAE 会话缓存（${error.code || '格式不受支持'}），请确认这是支持的 state.vscdb。`);
    return [];
  } finally {
    db?.close();
  }
}

function roots({ home, root }) {
  if (root) return [root];
  const names = ['Trae', 'Trae CN', 'TRAE SOLO', 'TRAE SOLO CN'];
  const parents = [path.join(home, 'Library', 'Application Support'), path.join(home, 'AppData', 'Roaming'), path.join(home, '.config')];
  const found = new Set();
  for (const parent of parents) {
    for (const name of names) {
      try { found.add(fs.realpathSync(path.join(parent, name))); } catch { /* 缺失来源不创建目录。 */ }
    }
  }
  return [...found];
}

function databaseFiles(root) {
  const user = path.basename(root) === 'User' ? root : path.join(root, 'User');
  const files = [path.join(user, 'globalStorage', 'state.vscdb')];
  const workspaces = path.join(user, 'workspaceStorage');
  for (const entry of entries(workspaces)) {
    if (entry.isDirectory()) files.push(path.join(workspaces, entry.name, 'state.vscdb'));
  }
  return files;
}

function projectFor(file) {
  const workspace = readJson(path.join(path.dirname(file), 'workspace.json'));
  const folder = workspace?.folder || workspace?.workspace;
  if (typeof folder !== 'string') return '';
  if (!folder.startsWith('file:')) return folder;
  try { return fileURLToPath(folder); } catch { return folder; }
}

function content(message) {
  if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();
  if (!Array.isArray(message.parsedQuery)) return '';
  return message.parsedQuery.filter((part) => typeof part === 'string').join('').trim();
}

function legacyMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!message || !['user', 'assistant'].includes(message.role) || message.status === 'deleted') return [];
    const text = content(message);
    return text ? [{ role: message.role, ts: epoch(message.timestamp), text }] : [];
  });
}

function legacyCollect(file) {
  return withDatabase(file, (db) => {
    const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'memento/icube-ai-agent-storage%' OR key LIKE 'memento/icube-ai-ng-chat-storage%'").all();
    return rows.flatMap((row) => {
      if (!STORAGE_KEY.test(row.key)) return [];
      const value = parse(row.value);
      if (!Array.isArray(value?.list)) return [];
      return value.list.flatMap((session) => {
        if (!session || typeof session.sessionId !== 'string' || !Array.isArray(session.messages)) return [];
        const messages = legacyMessages(session.messages);
        const times = messages.map((message) => message.ts).filter((time) => time !== null);
        return [{
          source: 'trae', id: session.sessionId, path: file, project: projectFor(file),
          title: typeof session.title === 'string' ? session.title.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
          start: epoch(session.createdAt) || (times.length ? Math.min(...times) : 0),
          end: Math.max(epoch(session.updatedAt) || 0, ...times),
          size: Buffer.byteLength(JSON.stringify(session.messages)),
          prompts: messages.filter((message) => message.role === 'user').length,
          traeFormat: 'memento', traeKey: row.key,
        }];
      });
    });
  });
}

function collect(config) {
  const sessions = new Map();
  for (const root of roots(config)) {
    for (const file of databaseFiles(root)) {
      for (const session of legacyCollect(file)) {
        const previous = sessions.get(session.id);
        if (!previous || session.end > previous.end || (session.end === previous.end && session.size > previous.size)) sessions.set(session.id, session);
      }
    }
    const native = path.join(root, 'ModularData', 'ai-agent', 'database.db');
    if (exists(native)) {
      console.error('检测到 TRAE SOLO 原生数据库；此 CLI 不解码该存储。支持 computer-use 的技能宿主可按 references/trae-ui.md 只读已有界面会话。');
    }
  }
  return [...sessions.values()];
}

function messages(session) {
  return withDatabase(session.path, (db) => {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(session.traeKey);
    const list = parse(row?.value)?.list;
    const match = Array.isArray(list) ? list.find((item) => item?.sessionId === session.id) : null;
    return legacyMessages(match?.messages);
  });
}

module.exports = { collect, messages };
