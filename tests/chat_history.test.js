'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const cli = path.resolve(__dirname, '../skills/chat-history/scripts/chat_history.js');
const JAN = '2026-01-02T03:04:05.000Z';
const FEB = '2026-02-02T03:04:05.000Z';
const codexId = 'c0de0000-1111-2222-3333-444444444444';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  function write(rel, value, date = FEB) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    fs.utimesSync(file, new Date(date), new Date(date));
    return file;
  }
  function jsonl(rel, rows, date) {
    return write(rel, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n', date);
  }
  function run(args, options = {}) {
    return spawnSync(process.execPath, [cli, ...args, '--home', home], {
      encoding: 'utf8', cwd: home, env: { ...process.env, TZ: 'UTC' }, ...options,
    });
  }
  function result(args, options) {
    const output = run([...args, '--json'], options);
    assert.equal(output.status, 0, output.stderr);
    return JSON.parse(output.stdout);
  }
  return { home, write, jsonl, run, result };
}

function claude(f, id = 'cc-1111', project = '/projects/alpha') {
  f.jsonl('.claude/history.jsonl', [
    { sessionId: id, display: 'needle January', project, timestamp: Date.parse(JAN) },
    '{broken',
    { sessionId: id, display: 'needle February', project, timestamp: Date.parse(FEB) },
  ]);
  return f.jsonl(`.claude/projects/project/${id}.jsonl`, [
    { type: 'system', cwd: project },
    { type: 'user', timestamp: JAN, message: { content: 'needle January' } },
    '{unfinished',
    { type: 'user', timestamp: JAN, message: { content: '<system-reminder>hidden</system-reminder>' } },
    { type: 'assistant', isSidechain: true, timestamp: JAN, message: { content: 'child agent' } },
    { type: 'assistant', timestamp: JAN, message: { content: [{ type: 'text', text: 'answer only' }, { type: 'tool_use', name: 'Read', input: { file: 'sample.txt' } }] } },
    { type: 'user', timestamp: FEB, message: { content: 'needle February' } },
  ]);
}

function codex(f, extraRows, project = '/projects/alpha') {
  f.jsonl('.codex/history.jsonl', [{ session_id: codexId, text: 'codex needle', ts: Date.parse(JAN) / 1000 }]);
  f.jsonl('.codex/session_index.jsonl', [{ id: codexId, thread_name: 'Codex sample' }]);
  return f.jsonl(`.codex/sessions/2026/01/02/rollout-2026-01-02T03-04-05-${codexId}.jsonl`, [
    { type: 'session_meta', timestamp: JAN, payload: { id: codexId, cwd: project } },
    ...(extraRows || [
      { type: 'event_msg', timestamp: JAN, payload: { type: 'user_message', message: 'codex needle' } },
      { type: 'event_msg', timestamp: JAN, payload: { type: 'agent_message', message: 'codex answer' } },
      { type: 'response_item', timestamp: JAN, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex answer' }] } },
    ]),
  ]);
}

function grok(f, id = 'grok-1111', date = JAN) {
  const dir = `.grok/sessions/${encodeURIComponent('/projects/alpha')}/${id}`;
  f.write(`${dir}/summary.json`, JSON.stringify({ info: { id, cwd: '/projects/alpha' }, generated_title: 'Grok sample', created_at: date, updated_at: date }));
  function update(kind, text, extra = {}) {
    return { method: 'session/update', timestamp: Date.parse(date), params: { sessionId: id, update: { sessionUpdate: kind, content: { type: 'text', text }, ...extra } } };
  }
  return f.jsonl(`${dir}/updates.jsonl`, [
    update('user_message_chunk', '怎样 ', { _meta: { promptIndex: 0 } }),
    update('user_message_chunk', '查记录', { _meta: { promptIndex: 0 } }),
    update('agent_thought_chunk', 'hidden analysis'),
    update('agent_message_chunk', '先列出'),
    update('agent_message_chunk', '会话。'),
    update('tool_call', '', { title: 'Read', rawInput: { file: 'sample.txt' } }),
    update('agent_message_chunk', '再读取正文。'),
    update('turn_completed', ''),
    '{broken',
  ], date);
}

function workbuddy(f) {
  const file = f.jsonl('.workbuddy/projects/project/wb-1111.jsonl', [
    { type: 'message', id: 'm1', sessionId: 'wb-1111', cwd: '/projects/alpha', role: 'user', timestamp: Date.parse(JAN), content: [{ type: 'input_text', text: 'workbuddy needle' }, { type: 'image_blob_ref', blob_path: '/not-read.png' }] },
    { type: 'reasoning', content: [{ type: 'output_text', text: 'hidden analysis' }] },
    { type: 'function_call', name: 'Read', arguments: { path: 'example.txt' }, timestamp: Date.parse(JAN) },
    { type: 'function_call_result', output: { text: 'hidden result' }, timestamp: Date.parse(JAN) },
    { type: 'message', id: 'm2', sessionId: 'wb-1111', role: 'assistant', timestamp: Date.parse(JAN), content: [{ type: 'output_text', text: 'workbuddy answer' }] },
    { type: 'ai-title', aiTitle: 'WorkBuddy sample' },
  ]);
  f.jsonl('.workbuddy/projects/project/wb-1111/subagents/agent-child.jsonl', [
    { type: 'message', role: 'user', sessionId: 'child', content: 'not a main session' },
  ]);
  return file;
}

function zcode(f) {
  const file = f.write('.zcode/cli/db/db.sqlite', '');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('zc-1111', '/projects/alpha', 'ZCode sample', Date.parse(JAN), Date.parse(JAN));
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  message.run('m1', 'zc-1111', Date.parse(JAN), JSON.stringify({ role: 'user' }), 1);
  message.run('m2', 'zc-1111', Date.parse(JAN), JSON.stringify({ role: 'assistant' }), 2);
  message.run('m3', 'zc-1111', Date.parse(JAN), JSON.stringify({ role: 'user', semantics: { transcriptVisibility: 'hidden' } }), 3);
  message.run('m4', 'zc-1111', Date.parse(JAN), '{bad', 4);
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  part.run('p1', 'm1', 'zc-1111', Date.parse(JAN), JSON.stringify({ type: 'text', text: 'zcode needle' }), 1);
  part.run('p2', 'm2', 'zc-1111', Date.parse(JAN), JSON.stringify({ type: 'reasoning', text: 'hidden analysis' }), 2);
  part.run('p3', 'm2', 'zc-1111', Date.parse(JAN), JSON.stringify({ type: 'tool', tool: 'Read', state: { input: { file: 'sample.txt' } } }), 3);
  part.run('p4', 'm2', 'zc-1111', Date.parse(JAN), JSON.stringify({ type: 'text', text: 'zcode answer' }), 4);
  part.run('p5', 'm3', 'zc-1111', Date.parse(JAN), JSON.stringify({ type: 'text', text: 'hidden reminder' }), 5);
  part.run('p6', 'm4', 'zc-1111', Date.parse(JAN), JSON.stringify({ type: 'text', text: 'invalid message' }), 6);
  db.close();
  return file;
}

function kimi(f) {
  const dir = '.kimi-code/sessions/wd_example/ki-1111';
  f.write(`${dir}/state.json`, JSON.stringify({ title: 'Kimi sample', workDir: '/projects/alpha', createdAt: JAN, updatedAt: JAN }));
  return f.jsonl(`${dir}/agents/main/wire.jsonl`, [
    { type: 'metadata', protocol_version: '1.4', created_at: Date.parse(JAN) },
    { type: 'context.append_message', time: Date.parse(JAN), message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'kimi needle' }] } },
    { type: 'context.append_message', time: Date.parse(JAN), message: { role: 'assistant', content: [{ type: 'text', text: 'kimi answer' }] } },
  ], JAN);
}

function trae(f) {
  const dir = 'Library/Application Support/TRAE SOLO CN/User/workspaceStorage/workspace';
  const file = f.write(`${dir}/state.vscdb`, '');
  f.write(`${dir}/workspace.json`, JSON.stringify({ folder: pathToFileURL(path.join(f.home, 'projects', 'alpha')).href }));
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('memento/icube-ai-agent-storage-sample', JSON.stringify({
    list: [{ sessionId: 'tr-1111', title: 'TRAE sample', createdAt: Date.parse(JAN), updatedAt: Date.parse(JAN), messages: [
      { role: 'user', parsedQuery: ['trae needle ', { type: 'file', name: 'not-message-text' }, '问题'], timestamp: Date.parse(JAN) },
      { role: 'assistant', content: 'trae answer', timestamp: Date.parse(JAN) },
      { role: 'user', content: 'deleted question', status: 'deleted', timestamp: Date.parse(JAN) },
      { role: 'system', content: 'hidden system prompt' },
    ] }], currentSessionId: 'tr-1111',
  }));
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('unrelated-cache', JSON.stringify({ messages: [{ role: 'user', content: 'not a session' }] }));
  db.close();
  return file;
}

test('空隔离目录不会读取系统用户目录，也不会创建数据库', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.result(['list']), { total: 0, sessions: [] });
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('统一列出七种来源，并按来源、项目和时间筛选', (t) => {
  const f = fixture(t);
  claude(f); codex(f); grok(f); workbuddy(f); zcode(f); kimi(f); trae(f);
  const all = f.result(['list']);
  assert.equal(all.total, 7);
  assert.deepEqual(new Set(all.sessions.map((s) => s.source)), new Set(['claude', 'codex', 'grok', 'workbuddy', 'zcode', 'kimi', 'trae']));
  assert.equal(f.result(['list', '--source', 'grok', '--project', 'ALPHA']).total, 1);
  assert.equal(f.result(['list', '--project', 'other']).total, 0);
  assert.equal(f.result(['list', '--since', '2027-01-01']).total, 0);
  assert.equal(f.result(['list', '--until', '2025-01-01']).total, 0);
  for (const source of ['claude', 'codex', 'grok', 'workbuddy', 'zcode', 'kimi', 'trae']) {
    const [session] = f.result(['list', '--source', source]).sessions;
    assert.ok(f.result(['show', session.id, '--source', source]).messages.length >= 2, source);
    assert.equal(f.result(['search', source === 'grok' ? '怎样' : 'needle', '--source', source]).total, 1, source);
    assert.equal(f.result(['last', '--source', source, '--project', 'alpha', '--grace', '0']).session.id, session.id, source);
  }
});

test('Claude 忽略坏行、系统注入与子代理，保留局部读取和工具开关', (t) => {
  const f = fixture(t); claude(f);
  const full = f.result(['show', 'cc-', '--full']);
  assert.equal(full.total, 3);
  assert.deepEqual(full.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(f.result(['show', 'cc-', '--range', '2:2']).messages[0].text, 'answer only');
  assert.equal(f.result(['show', 'cc-', '--tail', '1']).messages[0].text, 'needle February');
  assert.equal(f.result(['show', 'cc-', '--role', 'user']).total, 2);
  assert.match(f.result(['show', 'cc-', '--tools', '--role', 'assistant']).messages[0].text, /调用工具 Read/);
  assert.equal(f.result(['show', 'cc-', '--head', '1', '--max-chars', '6']).messages[0].truncated, true);
});

test('Codex 混合事件与原始响应一对一去重，重复提问与工具顺序保留', (t) => {
  const f = fixture(t);
  const event = (role, text) => ({ type: 'event_msg', timestamp: JAN, payload: { type: role === 'user' ? 'user_message' : 'agent_message', message: text } });
  const response = (role, text, channel) => ({ type: 'response_item', timestamp: JAN, payload: { type: 'message', role, channel, content: [{ type: 'output_text', text }] } });
  codex(f, [
    event('user', '重复提问'), response('user', '重复提问'),
    response('assistant', '只有原始响应'),
    { type: 'response_item', timestamp: JAN, payload: { type: 'function_call', name: 'Read', arguments: '{}' } },
    response('assistant', '重复答案'), event('assistant', '重复答案'),
    event('user', '重复提问'), response('user', '重复提问'),
    response('user', '<widget>真实 XML 问题</widget>'),
    response('user', '<environment_context>hidden</environment_context>'),
    response('assistant', 'hidden thought', 'analysis'),
    { type: 'event_msg', payload: { type: 'agent_message', message: 123 } },
    { type: 'response_item', payload: { type: 'message', content: 123 } },
  ]);
  const messages = f.result(['show', codexId, '--tools']).messages;
  assert.deepEqual(messages.map((m) => m.text), ['重复提问', '只有原始响应', '[调用工具 Read] {}', '重复答案', '重复提问', '<widget>真实 XML 问题</widget>']);
});

test('Grok 按 ACP 分片重组正文，工具与内部思考不会污染默认内容', (t) => {
  const f = fixture(t); grok(f);
  assert.deepEqual(f.result(['show', 'grok-']).messages.map((m) => m.text), ['怎样 查记录', '先列出会话。', '再读取正文。']);
  assert.deepEqual(f.result(['show', 'grok-', '--tools']).messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
});

test('WorkBuddy 原生消息解析不把 reasoning、工具结果和子代理当聊天', (t) => {
  const f = fixture(t); workbuddy(f);
  assert.equal(f.result(['list', '--source', 'workbuddy']).total, 1);
  assert.deepEqual(f.result(['show', 'wb-']).messages.map((m) => m.text), ['workbuddy needle', 'workbuddy answer']);
  assert.deepEqual(f.result(['show', 'wb-', '--tools']).messages.map((m) => m.role), ['user', 'tool', 'assistant']);
});

test('ZCode SQLite 按 message/part 顺序读取且源数据库字节及时间不变', (t) => {
  const f = fixture(t); const file = zcode(f);
  const before = fs.readFileSync(file); const mtime = fs.statSync(file).mtimeMs;
  assert.deepEqual(f.result(['show', 'zc-']).messages.map((m) => m.text), ['zcode needle', 'zcode answer']);
  assert.deepEqual(f.result(['show', 'zc-', '--tools']).messages.map((m) => m.role), ['user', 'tool', 'assistant']);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['db.sqlite']);
});

test('TRAE 只读受支持 Memento，忽略删除项、系统消息和无关缓存', (t) => {
  const f = fixture(t); const file = trae(f);
  const before = fs.readFileSync(file); const mtime = fs.statSync(file).mtimeMs;
  assert.deepEqual(f.result(['show', 'tr-', '--source', 'trae']).messages.map((m) => m.text), ['trae needle 问题', 'trae answer']);
  assert.equal(f.result(['list', '--source', 'trae']).sessions[0].project, path.join(f.home, 'projects', 'alpha'));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['state.vscdb', 'workspace.json']);
});

test('TRAE SOLO 未支持的原生数据库明确提示，不能假装恢复正文', (t) => {
  const f = fixture(t);
  const file = f.write('Library/Application Support/TRAE SOLO CN/ModularData/ai-agent/database.db', 'opaque native data');
  const output = f.run(['list', '--source', 'trae', '--json']);
  assert.equal(output.status, 0);
  assert.equal(JSON.parse(output.stdout).total, 0);
  assert.match(output.stderr, /TRAE SOLO 原生数据库/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'opaque native data');
});

test('损坏 SQLite 明确诊断，不能写回、创建或伪报成功读取', (t) => {
  const f = fixture(t); const file = f.write('.zcode/cli/db/db.sqlite', 'not a database');
  const output = f.run(['list', '--source', 'zcode', '--json']);
  assert.equal(output.status, 0);
  assert.match(output.stderr, /无法读取 zcode 数据库/);
  assert.equal(JSON.parse(output.stdout).total, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a database');
});

test('搜索按单条提问时间筛选，Codex 索引从会话恢复项目', (t) => {
  const f = fixture(t); claude(f); codex(f); workbuddy(f);
  const january = f.result(['search', 'needle', '--since', '2026-01-01', '--until', '2026-01-31', '--project', 'alpha']);
  assert.equal(january.total, 3);
  assert.equal(january.hits.find((h) => h.source === 'claude').excerpts.length, 1);
  assert.equal(january.hits.find((h) => h.source === 'codex').project, '/projects/alpha');
  assert.equal(f.result(['search', 'answer only']).total, 0);
  assert.equal(f.result(['search', 'answer only', '--content']).total, 1);
});

test('--cwd 搜索使用工作目录，缺失提问索引仍可搜索用户消息', (t) => {
  const f = fixture(t); codex(f, undefined, f.home);
  fs.unlinkSync(path.join(f.home, '.codex/history.jsonl'));
  assert.equal(f.result(['search', 'codex needle', '--cwd']).total, 1);
});

test('last 根据正文写入跳过活跃会话，全部活跃或 n 越界时明确失败', (t) => {
  const f = fixture(t); grok(f, 'old', JAN);
  const active = grok(f, 'active', JAN);
  fs.utimesSync(active, new Date(), new Date());
  assert.equal(f.result(['last', '--source', 'grok', '--project', 'alpha']).session.id, 'old');
  assert.equal(f.result(['last', '--source', 'grok', '--project', 'alpha', '--grace', '0']).session.id, 'active');
  assert.match(f.run(['last', '--source', 'grok', '--project', 'alpha', '-n', '2']).stderr, /无法读取倒数第 2 个/);
  fs.rmSync(path.dirname(path.join(f.home, `.grok/sessions/${encodeURIComponent('/projects/alpha')}/old/updates.jsonl`)), { recursive: true });
  const output = f.run(['last', '--source', 'grok', '--project', 'alpha']);
  assert.equal(output.status, 1);
  assert.match(output.stderr, /--grace 0/);
});

test('WorkBuddy 尊重已删除索引，ZCode 跳过有明确 parent_id 的子代理', (t) => {
  const f = fixture(t); workbuddy(f);
  const file = f.write('.workbuddy/workbuddy.db', '');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE sessions (id TEXT, deleted_at INTEGER)');
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('wb-1111', Date.parse(FEB));
  db.close();
  assert.equal(f.result(['list', '--source', 'workbuddy']).total, 0);
  const zc = new DatabaseSync(zcode(f));
  zc.exec('ALTER TABLE session ADD COLUMN parent_id TEXT');
  zc.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run('child', '/projects/alpha', 'child task', Date.parse(JAN), Date.parse(JAN), 'zc-1111');
  zc.close();
  assert.deepEqual(f.result(['list', '--source', 'zcode']).sessions.map((s) => s.id), ['zc-1111']);
});

test('跨来源 id 前缀冲突必须消歧，指定数据根不会混入默认目录', (t) => {
  const f = fixture(t); claude(f, 'same-id'); grok(f, 'same-id');
  assert.match(f.run(['show', 'same-id']).stderr, /匹配到多个会话/);
  assert.equal(f.result(['show', 'grok:same-id']).session.source, 'grok');
  const custom = path.join(f.home, 'custom-data');
  fs.renameSync(path.join(f.home, '.grok'), custom);
  assert.equal(f.result(['list', '--source', 'grok']).total, 0);
  assert.equal(f.result(['list', '--source', 'grok', '--source-root', custom]).total, 1);
});

test('异常索引 id 不影响对象原型，仍可正常读取会话', (t) => {
  const f = fixture(t); claude(f, '__proto__');
  assert.equal(f.result(['list', '--source', 'claude']).sessions[0].id, '__proto__');
  assert.equal(f.result(['show', '__proto__']).total, 3);
});

test('拒绝无效整数、日期、范围和含糊参数', (t) => {
  const f = fixture(t);
  const invalid = [
    ['list', '--limit', '-1'], ['list', '--limit', '1x'], ['list', '--limit', '1.5'], ['list', '--limit', '0'],
    ['list', '--since', '2026-02-30'], ['list', '--since', '2026-01-01 25:00'],
    ['list', '--since', '2026-02-01', '--until', '2026-01-01'],
    ['show', 'a', '--range', '0:2'], ['show', 'a', '--range', '3:2'], ['show', 'a', '--range', '1:x'],
    ['show', 'a', '--tail', '1', '--head', '2'], ['list', '--source', 'unknown'],
    ['list', '--source-root', f.home], ['list', '--source', '--json'],
    ['list', '--cwd', '--project', 'alpha'], ['search', '   '], ['list', '--json=false'],
  ];
  for (const args of invalid) assert.equal(f.run(args).status, 1, args.join(' '));
});
