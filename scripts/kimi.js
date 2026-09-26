'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
    throw new Error(`无法读取 Kimi 会话文件 ${file}: ${error.message}`);
  }
}

function json(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function records(file) {
  return read(file).split(/\r?\n/).map(json).filter((row) => row && typeof row === 'object');
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw new Error(`无法读取 Kimi 会话目录 ${dir}: ${error.message}`);
  }
}

function stat(file) {
  try { return fs.statSync(file); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function epoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e11 ? value / 1000 : value;
  if (typeof value !== 'string' || !value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result / 1000 : null;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && ['text', 'input_text', 'output_text'].includes(part.type))
    .map((part) => typeof part.text === 'string' ? part.text : '').join('\n');
}

function fromMessage(message, ts, withTools) {
  if (!message || !['user', 'assistant', 'tool'].includes(message.role)) return null;
  if (message.role === 'tool' && !withTools) return null;
  if (message.role === 'user' && message.origin?.kind && message.origin.kind !== 'user') return null;
  const text = textContent(message.content).trim();
  return text ? { role: message.role, ts, text } : null;
}

function wireMessages(rows, withTools) {
  const out = [];
  let assistant = null;
  let prompt = null;
  const flushPrompt = () => {
    if (prompt) out.push(prompt);
    prompt = null;
  };
  for (const row of rows) {
    const ts = epoch(row.time ?? row.timestamp);
    if (row.type === 'turn.prompt') {
      flushPrompt();
      assistant = null;
      if (!row.origin?.kind || row.origin.kind === 'user') {
        const text = textContent(row.input).trim();
        if (text) prompt = { role: 'user', ts, text };
      }
    } else if (row.type === 'context.append_message') {
      const message = fromMessage(row.message, ts, withTools);
      if (!message) continue;
      // 同一输入同时记录 turn.prompt 和 append_message，只显示一次。
      if (message.role === 'user') prompt = null;
      else flushPrompt();
      out.push(message);
      assistant = null;
    } else if (row.type === 'context.append_loop_event' && row.event) {
      const event = row.event;
      flushPrompt();
      if (event.type === 'step.begin' || event.type === 'step.end') {
        assistant = null;
      } else if (event.type === 'content.part' && event.part?.type === 'text') {
        const text = textContent([event.part]);
        if (!text) continue;
        if (!assistant || assistant.step !== event.stepUuid) {
          assistant = { role: 'assistant', ts, text: '', step: event.stepUuid };
          out.push(assistant);
        }
        assistant.text += text;
      } else if (event.type === 'tool.call' && withTools) {
        out.push({ role: 'tool', ts, text: `[调用工具 ${event.name || '?'}] ${JSON.stringify(event.args ?? {})}` });
        assistant = null;
      } else if (event.type === 'tool.result' && withTools) {
        const result = event.result;
        const text = typeof result?.output === 'string' ? result.output : textContent(result?.content);
        if (text) out.push({ role: 'tool', ts, text });
        assistant = null;
      }
    }
  }
  flushPrompt();
  return out.map(({ role, ts, text }) => ({ role, ts, text: text.trim() })).filter((message) => message.text);
}

function messages(session, withTools = false) {
  const rows = records(session.path);
  if (session.kimiFormat === 'wire') return wireMessages(rows, withTools);
  return rows.map((row) => fromMessage(row, epoch(row.timestamp ?? row.time), withTools)).filter(Boolean);
}

function roots(home, root) {
  if (root) {
    return [root, path.join(root, 'daimon', 'runtime', 'kimi-code', 'home'),
      path.join(root, 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home')];
  }
  const desktop = [path.join(home, 'Library', 'Application Support', 'kimi-desktop'),
    path.join(home, 'AppData', 'Roaming', 'kimi-desktop'), path.join(home, '.config', 'kimi-desktop')];
  return [path.join(home, '.kimi-code'), path.join(home, '.kimi'),
    ...desktop.map((dir) => path.join(dir, 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home'))];
}

function collect({ home, root }) {
  const out = new Map();
  for (const dataRoot of [...new Set(roots(home, root))]) {
    const projects = new Map();
    const legacy = json(read(path.join(dataRoot, 'kimi.json')));
    for (const wd of Array.isArray(legacy?.work_dirs) ? legacy.work_dirs : []) {
      if (!wd || typeof wd.path !== 'string') continue;
      const hash = createHash('md5').update(wd.path).digest('hex');
      const key = wd.kaos && wd.kaos !== 'local' ? `${wd.kaos}_${hash}` : hash;
      projects.set(key, wd.path);
    }
    const index = new Map();
    for (const row of records(path.join(dataRoot, 'session_index.jsonl'))) {
      if (typeof row.sessionId === 'string') index.set(row.sessionId, row);
    }
    const sessions = path.join(dataRoot, 'sessions');
    for (const bucket of entries(sessions)) {
      if (!bucket.isDirectory()) continue;
      const bucketPath = path.join(sessions, bucket.name);
      for (const entry of entries(bucketPath)) {
        const legacyFile = entry.isFile() && entry.name.endsWith('.jsonl');
        if (!entry.isDirectory() && !legacyFile) continue;
        const id = legacyFile ? entry.name.slice(0, -6) : entry.name;
        if (out.has(id) || id.startsWith('ctitle-')) continue;
        const dir = path.join(bucketPath, entry.name);
        const state = legacyFile ? {} : json(read(path.join(dir, 'state.json')))
          || json(read(path.join(dir, 'session-meta', 'state.json'))) || {};
        if (state.custom?.sessionKind === 'conversation-title') continue;
        const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
        const wireStat = legacyFile ? null : stat(wire);
        const file = legacyFile ? dir : wireStat?.isFile() ? wire : path.join(dir, 'context.jsonl');
        const info = stat(file);
        if (!info?.isFile()) continue;
        const kimiFormat = wireStat?.isFile() ? 'wire' : 'context';
        const meta = legacyFile ? {} : json(read(path.join(dir, 'metadata.json'))) || {};
        const indexed = index.get(id) || {};
        let project = indexed.workDir || state.workDir || state.cwd || state.custom?.workspacePath
          || projects.get(bucket.name) || '';
        let title = state.title || meta.title || state.lastPrompt || '';
        let start = epoch(state.createdAt ?? meta.created_at);
        if (!project || !title || !start) {
          const rows = records(file);
          const config = rows.find((row) => row.type === 'config.update' && typeof row.cwd === 'string');
          if (!project) project = config?.cwd || '';
          if (!title) title = (kimiFormat === 'wire' ? wireMessages(rows, false)
            : rows.map((row) => fromMessage(row, null, false)).filter(Boolean))
            .find((message) => message.role === 'user')?.text || '';
          if (!start) start = rows.map((row) => epoch(row.created_at ?? row.time ?? row.timestamp)).find(Boolean);
        }
        const end = Math.max(epoch(state.updatedAt ?? meta.updated_at) || 0, info.mtimeMs / 1000);
        out.set(id, { source: 'kimi', id, path: file,
          project: typeof project === 'string' ? project : '',
          title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
          start: start || end, end, size: info.size, prompts: 0, kimiFormat });
      }
    }
  }
  return [...out.values()];
}

module.exports = { collect, messages };
