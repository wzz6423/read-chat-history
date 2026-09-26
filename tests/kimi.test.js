'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collect, messages } = require('../skills/chat-history/scripts/kimi.js');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-kimi-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  fs.utimesSync(file, new Date('2026-01-02'), new Date('2026-01-02'));
}

function modern(root, id, rows, state = {}) {
  const dir = path.join(root, 'sessions', 'wd_example', id);
  write(path.join(dir, 'state.json'), {
    title: '示例会话', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    workDir: '/example/project', ...state,
  });
  const file = path.join(dir, 'agents', 'main', 'wire.jsonl');
  write(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
  return file;
}

const prompt = (text, time = 1767225600000) => ({
  type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time,
});
const appended = (role, text, origin = 'user') => ({
  type: 'context.append_message', time: 1767225601000,
  message: { role, origin: { kind: origin }, content: [{ type: 'text', text }] },
});
const loop = (event) => ({ type: 'context.append_loop_event', time: 1767225602000, event });

test('新版 Kimi 合并回答片段，去重用户提示词，排除系统注入和思考', (t) => {
  const home = fixture(t);
  const root = path.join(home, '.kimi-code');
  modern(root, 'session_main', [
    { type: 'metadata', protocol_version: '1.4', created_at: 1767225600000 },
    prompt('你好'), appended('user', '你好'),
    appended('user', '私有系统提示词', 'injection'),
    loop({ type: 'step.begin', uuid: 's1' }),
    loop({ type: 'content.part', stepUuid: 's1', part: { type: 'think', think: '私有推理' } }),
    loop({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: '你' } }),
    loop({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: '好！' } }),
    loop({ type: 'step.end', uuid: 's1' }),
    { type: 'llm.request', body: { authorization: '不应出现', text: '不应出现' } },
  ]);
  const sessions = collect({ home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].source, 'kimi');
  assert.equal(sessions[0].project, '/example/project');
  assert.equal(sessions[0].start, 1767225600);
  assert.deepEqual(messages(sessions[0]).map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '你好' }, { role: 'assistant', text: '你好！' },
  ]);
});

test('工具调用与结果只有 --tools 时读取，正文不会被当成用户消息', (t) => {
  const home = fixture(t);
  const file = modern(home, 'session_tools', [prompt('运行'), appended('user', '运行'),
    loop({ type: 'step.begin', uuid: 's1' }),
    loop({ type: 'tool.call', name: 'Read', args: { path: 'file.txt' } }),
    loop({ type: 'tool.result', result: { output: '工具结果' } }),
    appended('tool', '额外工具结果'),
    appended('assistant', '完成'),
  ]);
  const session = { path: file, kimiFormat: 'wire' };
  assert.deepEqual(messages(session).map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(messages(session, true).map((m) => m.role), ['user', 'tool', 'tool', 'tool', 'assistant']);
  assert.ok(messages(session, true)[1].text.includes('file.txt'));
});

test('保留未写入上下文的末条提问和中断回答，忽略半行 JSON', (t) => {
  const home = fixture(t);
  const file = modern(home, 'session_partial', [
    prompt('第一个问题'), appended('user', '第一个问题'),
    loop({ type: 'step.begin', uuid: 's1' }),
    loop({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: '部分回答' } }),
    prompt('尚未响应的问题'), '{"type":',
  ]);
  assert.deepEqual(messages({ path: file, kimiFormat: 'wire' }).map((m) => m.text),
    ['第一个问题', '部分回答', '尚未响应的问题']);
});

test('桌面版会话自动发现，标题生成任务与子代理不混入主会话', (t) => {
  const home = fixture(t);
  const root = path.join(home, 'Library', 'Application Support', 'kimi-desktop',
    'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home');
  modern(root, 'conv-example', [appended('user', '桌面问题')], { custom: { sessionKind: 'conversation' } });
  modern(root, 'ctitle-example', [appended('user', '生成标题')]);
  modern(root, 'other-title', [appended('user', '生成标题')], { custom: { sessionKind: 'conversation-title' } });
  write(path.join(root, 'sessions', 'wd_example', 'conv-example', 'agents', 'agent-0', 'wire.jsonl'),
    JSON.stringify(appended('user', '子代理提问')));
  assert.deepEqual(collect({ home }).map((s) => s.id), ['conv-example']);
});

test('旧版 Kimi 通过工作目录哈希恢复项目并读取 context.jsonl', (t) => {
  const home = fixture(t);
  const root = path.join(home, '.kimi');
  const project = '/example/中文项目';
  const hash = createHash('md5').update(project).digest('hex');
  write(path.join(root, 'kimi.json'), { work_dirs: [null, { path: project, kaos: 'local' }] });
  write(path.join(root, 'sessions', hash, 'legacy-session', 'context.jsonl'), [
    JSON.stringify({ role: 'system', content: '隐藏系统指令' }),
    JSON.stringify({ role: 'user', content: '旧版问题' }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '旧版回答' },
      { type: 'think', think: '不输出' }, { type: 'image_url', image_url: '不输出' }] }),
  ].join('\n'));
  const [session] = collect({ home });
  assert.equal(session.project, project);
  assert.equal(session.title, '旧版问题');
  assert.deepEqual(messages(session).map((m) => m.text), ['旧版问题', '旧版回答']);
});

test('兼容旧版直接 JSONL 与远程工作目录元数据', (t) => {
  const home = fixture(t);
  const root = path.join(home, '.kimi');
  const project = '/remote/project';
  const hash = createHash('md5').update(project).digest('hex');
  write(path.join(root, 'kimi.json'), { work_dirs: [{ path: project, kaos: 'ssh_host' }] });
  write(path.join(root, 'sessions', `ssh_host_${hash}`, 'old-session.jsonl'),
    JSON.stringify({ role: 'user', content: '远程提问' }));
  const [session] = collect({ home });
  assert.equal(session.id, 'old-session');
  assert.equal(session.project, project);
});

test('自定义数据根覆盖默认来源，索引不能将正文路径重定向到外部', (t) => {
  const home = fixture(t);
  modern(path.join(home, '.kimi-code'), 'default-session', [appended('user', '默认提问')]);
  const custom = path.join(home, 'custom');
  modern(custom, 'selected-session', [appended('user', '自定义提问')]);
  write(path.join(custom, 'session_index.jsonl'), JSON.stringify({
    sessionId: 'selected-session', workDir: '/indexed/project', sessionDir: path.join(home, '.kimi-code'),
  }));
  const [session] = collect({ home, root: custom });
  assert.equal(collect({ home, root: custom }).length, 1);
  assert.equal(session.project, '/indexed/project');
  assert.ok(session.path.startsWith(custom));
  assert.deepEqual(messages(session).map((m) => m.text), ['自定义提问']);
});

test('缺失状态时从事件恢复项目和标题，允许空数据根', (t) => {
  const home = fixture(t);
  assert.deepEqual(collect({ home }), []);
  const root = path.join(home, '.kimi-code');
  const file = modern(root, 'session_no_state', [
    { type: 'metadata', protocol_version: '1.5', created_at: 1767225600000 },
    { type: 'config.update', cwd: '/fallback/project' }, prompt('恢复标题'),
  ]);
  fs.rmSync(path.resolve(file, '..', '..', '..', 'state.json'));
  const [session] = collect({ home });
  assert.equal(session.project, '/fallback/project');
  assert.equal(session.title, '恢复标题');
  assert.equal(session.start, 1767225600);
});
