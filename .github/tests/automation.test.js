'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('../scripts/github-api.js');
const { eventTarget, ensureLabel, synchronizeMetadata, run } = require('../scripts/automation.js');
const { contract } = require('../scripts/metadata.js');
const { pullRequest, project, response } = require('./fixtures.js');

function eventEnvironment(t, event, extra = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-automation-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'event.json');
  fs.writeFileSync(file, JSON.stringify({ repository: { full_name: 'wzz6423/read-chat-history' }, ...event }));
  return { GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: 'wzz6423/read-chat-history', ...extra };
}

test('GitHub 请求使用结构化 JSON、固定来源与禁止重定向', async () => {
  const calls = [];
  const api = createClient('test-only-token', async (url, options) => {
    calls.push({ url, options });
    return response({ data: { accepted: true } });
  });
  const value = '$(echo unsafe)\n`quoted`';
  assert.deepEqual(await api.graphql('query Example($value: String!) { viewer { login } }', { value }), { accepted: true });
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only-token');
  assert.equal(JSON.parse(calls[0].options.body).variables.value, value);
  await assert.rejects(api.request('GET', '//attacker.invalid'), /路径无效/);
  await assert.rejects(api.request('GET', 'https://attacker.invalid'), /路径无效/);
  assert.equal(calls.length, 1);
});

test('HTTP 与 GraphQL 权限失败不能变成成功结果', async () => {
  const forbidden = createClient('synthetic', async () => response({ message: 'Forbidden' }, 403));
  await assert.rejects(forbidden.request('GET', '/repos/example/repo'), { status: 403 });
  const graphError = createClient('synthetic', async () => response({ data: { partial: true }, errors: [{ message: 'Insufficient project permissions' }] }));
  await assert.rejects(graphError.graphql('query Example { viewer { login } }', {}), /Insufficient/);
  const deleted = createClient('synthetic', async () => response(null, 204));
  assert.equal(await deleted.request('DELETE', '/repos/example/repo/issues/1/labels/bug'), null);
});

test('事件编号和仓库边界校验阻止任意路径', () => {
  const repository = 'wzz6423/read-chat-history';
  assert.equal(eventTarget({ repository: { full_name: repository }, pull_request: pullRequest() }, repository).number, 7);
  assert.throws(() => eventTarget({ repository: { full_name: 'other/repo' }, pull_request: pullRequest() }, repository), /不一致/);
  assert.throws(() => eventTarget({ repository: { full_name: repository }, issue: { number: '7/../../labels' } }, repository), /编号/);
  assert.throws(() => eventTarget({ repository: { full_name: repository }, inputs: { item_type: 'issue', number: '7;echo unsafe' } }, repository), /编号/);
  assert.equal(eventTarget({ repository: { full_name: repository }, inputs: { item_type: 'issue', number: '12' } }, repository).number, 12);
});

test('PR 校验不需要或使用任何令牌、网络', async t => {
  const env = eventEnvironment(t, { pull_request: pullRequest() });
  assert.match(await run('validate', env, () => assert.fail('校验不应访问网络')), /校验通过/);
});

test('Project 缺少专用令牌明确失败，不进行网络操作', async t => {
  const env = eventEnvironment(t, { issue: { number: 7 } });
  await assert.rejects(run('project', env, () => assert.fail('缺少令牌不应访问网络')), /PROJECT_AUTOMATION_TOKEN 未配置，Project 未同步/);
});

test('空编号手动运行仅校验 Project 配置，不创建或更新条目', async t => {
  const env = eventEnvironment(t, { inputs: { item_type: 'issue', number: '' } }, {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    PROJECT_AUTOMATION_TOKEN: 'synthetic-project-token',
  });
  const calls = [];
  const result = await run('project', env, async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(url, 'https://api.github.com/graphql');
    assert.ok(body.query.startsWith('query Project'));
    return response({ data: { user: { projectV2: project() } } });
  });
  assert.equal(calls.length, 1);
  assert.match(result, /配置验证通过/);
  assert.match(result, /未同步条目/);
});

test('旧事件先读取最新条目，避免过期标题写入错误标签', async t => {
  const env = eventEnvironment(t, { pull_request: pullRequest({ state: 'closed', title: 'fix: stale title' }) }, { GITHUB_TOKEN: 'synthetic' });
  const calls = [];
  await run('metadata', env, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/pulls/7')) return response(pullRequest({ title: 'docs: current title', assignees: [{ login: 'wzz6423' }] }));
    if (url.endsWith('/labels/documentation')) return response({ name: 'documentation' });
    if (url.endsWith('/issues/7/labels') && options.method === 'POST') return response([{ name: 'documentation' }]);
    assert.fail(`未预期的请求：${url}`);
  });
  const post = calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { labels: ['documentation'] });
});

test('有编号的手动运行同步现有条目，仓库与 Project 使用各自令牌', async t => {
  const env = eventEnvironment(t, { inputs: { item_type: 'issue', number: '8' } }, {
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_TOKEN: 'synthetic-repository-token', PROJECT_AUTOMATION_TOKEN: 'synthetic-project-token',
  });
  let updates = 0;
  const result = await run('project', env, async (url, options) => {
    if (url.endsWith('/issues/8')) {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-repository-token');
      return response({ number: 8, node_id: 'I_example', title: '[Bug] 已解决', state: 'closed', labels: [] });
    }
    assert.equal(options.headers.Authorization, 'Bearer synthetic-project-token');
    const { query } = JSON.parse(options.body);
    if (query.startsWith('query Project')) return response({ data: { user: { projectV2: project() } } });
    if (query.startsWith('query Items')) return response({ data: { node: { items: { nodes: [{ id: 'PVTI_issue', content: { id: 'I_example' } }], pageInfo: { hasNextPage: false } } } } });
    assert.ok(query.startsWith('mutation UpdateItem'));
    updates++;
    return response({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_issue', fieldValueByName: { name: 'Done' } } } } });
  });
  assert.equal(updates, 1);
  assert.match(result, /Status：Done/);
});

test('同名标签创建冲突只有重新读取成功才可忽略', async () => {
  let reads = 0;
  const api = { request: async method => {
    if (method === 'GET' && ++reads > 1) return { name: 'bug' };
    const error = new Error('synthetic');
    error.status = method === 'GET' ? 404 : 422;
    throw error;
  } };
  await ensureLabel(api, '/repos/example/repo', contract.types.find(type => type.label === 'bug'));
  assert.equal(reads, 2);
});

test('PR 自动补负责人而不删除其他负责人或人工标签', async () => {
  const calls = [];
  const item = pullRequest({ title: 'docs: usage', labels: [{ name: 'bug' }, { name: 'help wanted' }], assignees: [{ login: 'other-maintainer' }] });
  const api = { request: async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === 'GET') return { name: 'documentation' };
    if (method === 'DELETE') return [];
    if (endpoint.endsWith('/assignees')) return { assignees: [{ login: 'other-maintainer' }, { login: 'wzz6423' }] };
    return [{ name: 'help wanted' }, { name: 'documentation' }];
  } };
  assert.deepEqual(await synchronizeMetadata(api, '/repos/example/repo', item, 'pull_request'), { add: ['documentation'], remove: ['bug'] });
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.endpoint), ['/repos/example/repo/issues/7/labels/bug']);
  assert.deepEqual(calls.find(call => call.endpoint.endsWith('/assignees')).body, { assignees: ['wzz6423'] });
});

test('GitHub 未实际分配负责人时报告失败', async () => {
  const api = { request: async (method, endpoint) => endpoint.endsWith('/assignees') ? { assignees: [] } : method === 'GET' ? { name: 'bug' } : [{ name: 'bug' }] };
  await assert.rejects(synchronizeMetadata(api, '/repos/example/repo', pullRequest(), 'pull_request'), /未能分配/);
});

test('特权工作流固定默认分支，所有 Actions 固定完整 SHA', () => {
  const workflowRoot = path.join(__dirname, '../workflows');
  for (const name of fs.readdirSync(workflowRoot)) {
    const workflow = fs.readFileSync(path.join(workflowRoot, name), 'utf8');
    for (const match of workflow.matchAll(/^\s*- uses:\s*(\S+)/gm)) assert.match(match[1], /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    if (workflow.includes('pull_request_target:') || workflow.includes('issues:\n')) {
      assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
      assert.doesNotMatch(workflow, /pull_request\.head\.(sha|ref|repo)/);
    }
    assert.doesNotMatch(workflow, /\$\{\{[^}\n]*(?:\.title|\.body)[^}\n]*\}\}/);
    assert.match(workflow, /persist-credentials: false/);
  }
  const quality = fs.readFileSync(path.join(workflowRoot, 'pr-quality.yml'), 'utf8');
  assert.doesNotMatch(quality, /secrets\.|:\s*write\b|pull_request_target:/);
});
