'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sections, typeForTitle, validatePullRequest, metadataFor, labelChanges, statusFor } = require('../scripts/metadata.js');
const { validBody, pullRequest } = require('./fixtures.js');

test('接受中英文 Conventional Commit 标题与 breaking change 标记', () => {
  for (const title of ['fix: 修复中文路径', 'feat(parser)!: support an export format', 'docs: explain local-only reads']) {
    assert.deepEqual(validatePullRequest(pullRequest({ title })), []);
  }
  assert.equal(typeForTitle('unknown: unsupported'), null);
  assert.equal(typeForTitle('fix: title\n::warning::extra line'), null);
});

test('分支命名受校验但 codex 前缀可用', () => {
  assert.deepEqual(validatePullRequest(pullRequest({ head: { ref: 'codex/add-parser' } })), []);
  assert.match(validatePullRequest(pullRequest({ head: { ref: 'random-branch' } })).join(' '), /分支/);
});

test('未填写的 PR 模板不能通过校验', () => {
  const body = fs.readFileSync(path.join(__dirname, '../PULL_REQUEST_TEMPLATE.md'), 'utf8');
  const errors = validatePullRequest(pullRequest({ body })).join(' ');
  assert.match(errors, /Summary/);
  assert.match(errors, /Status/);
  assert.match(errors, /Risk/);
});

test('注释与代码围栏里的伪造字段不算验证证据', () => {
  const hidden = `<!-- ${validBody} -->\n\`\`\`markdown\n${validBody}\n\`\`\``;
  assert.equal(sections(hidden).size, 0);
  const body = validBody.replace('- Result: 合成样本测试通过。', '<!-- - Result: 隐藏结果 -->\n~~~\n- Result: 代码样本\n~~~');
  assert.match(validatePullRequest(pullRequest({ body })).join(' '), /Result/);
});

test('每组验证独立校验，第二组不能借用第一组结果', () => {
  const body = validBody.replace('## Risk and Rollback', '- Status: passed\n- Command: npm run check\n\n## Risk and Rollback');
  assert.match(validatePullRequest(pullRequest({ body })).join(' '), /第 2 组.*Result/);
});

test('未运行验证需要原因，失败的验证允许如实记录', () => {
  const notRun = validBody.replace(/- Status: passed[\s\S]*?(?=\n## Risk)/, '- Status: not run\n- Reason: 此设备没有对应客户端。\n');
  assert.deepEqual(validatePullRequest(pullRequest({ body: notRun })), []);
  assert.match(validatePullRequest(pullRequest({ body: notRun.replace('此设备没有对应客户端。', 'TODO') })).join(' '), /Reason/);
  assert.deepEqual(validatePullRequest(pullRequest({ body: validBody.replace('- Status: passed', '- Status: failed') })), []);
});

test('关联引用必须明确，模板中的示例不会造成关联', () => {
  assert.deepEqual(validatePullRequest(pullRequest({ body: validBody + '\n<!-- Closes #123 -->' })), []);
  assert.deepEqual(validatePullRequest(pullRequest({ body: validBody.replace('None', 'Fixes https://github.com/example/repository/issues/123') })), []);
  assert.match(validatePullRequest(pullRequest({ body: validBody.replace('None', 'None\nCloses #123') })).join(' '), /不能同时/);
  assert.match(validatePullRequest(pullRequest({ body: validBody.replace('None', '#123') })).join(' '), /Related Issue/);
});

test('只有真实 Dependabot 身份与其分支组合获得正文豁免', () => {
  const bot = pullRequest({ title: 'chore(deps): bump actions', body: '', head: { ref: 'dependabot/github_actions/group' }, user: { login: 'dependabot[bot]', type: 'Bot' } });
  assert.deepEqual(validatePullRequest(bot), []);
  assert.notDeepEqual(validatePullRequest({ ...bot, user: { login: 'dependabot[bot]', type: 'User' } }), []);
  assert.notDeepEqual(validatePullRequest({ ...bot, head: { ref: 'feat/sneaky' } }), []);
});

test('AI 署名为可选信息，不强制虚构协作者', () => {
  assert.deepEqual(validatePullRequest(pullRequest({ body: validBody + '\n## AI Attribution\n- Agent: Codex，辅助编写测试。\n' })), []);
});

test('类型改变仅移除旧的自动化标签，保留人工标签', () => {
  const metadata = metadataFor(pullRequest({ title: 'docs: explain exports' }), 'pull_request');
  assert.deepEqual(labelChanges(['bug', 'review-needed'], metadata.labels, metadata.managed), { add: ['documentation'], remove: ['bug'] });
  const invalid = metadataFor(pullRequest({ title: 'unfinished title' }), 'pull_request');
  assert.deepEqual(labelChanges(['bug', 'review-needed'], invalid.labels, invalid.managed), { add: [], remove: [] });
});

test('Issue 表单范围更新时移除旧范围并保留其它标签', () => {
  const metadata = metadataFor({ title: '[Feature] 更多导出格式', body: '### 所属范围\n\n文档\n\n### 要解决的问题\n补充说明。' }, 'issue');
  assert.deepEqual(labelChanges(['bug', 'area:feature', 'help wanted'], metadata.labels, metadata.managed), { add: ['enhancement', 'area:docs'], remove: ['bug', 'area:feature'] });
  assert.deepEqual(metadataFor({ title: '维护者记录', body: '说明' }, 'issue'), { labels: [], managed: [] });
});

test('Project 使用当前标题而不等待旧类型标签更新', () => {
  assert.equal(statusFor(pullRequest({ title: 'docs: usage', labels: [{ name: 'enhancement' }] }), 'pull_request'), 'Documentation');
  assert.equal(statusFor(pullRequest({ title: 'fix: regression', labels: [{ name: 'documentation' }] }), 'pull_request'), 'Bug Fix');
});

test('Project 使用当前 Issue 表单范围，人工范围标签仍可覆盖 PR 类型', () => {
  assert.equal(statusFor({ state: 'open', title: '[Bug] 文档错误', body: '### 所属范围\n文档', labels: [{ name: 'area:bug-fix' }] }, 'issue'), 'Documentation');
  assert.equal(statusFor(pullRequest({ labels: [{ name: 'area:ci-build' }] }), 'pull_request'), 'CI & Build');
});

test('关闭归 Done，重开恢复当前类型，未知类型归 Inbox', () => {
  assert.equal(statusFor(pullRequest({ state: 'closed' }), 'pull_request'), 'Done');
  assert.equal(statusFor(pullRequest({ state: 'open' }), 'pull_request'), 'Bug Fix');
  assert.equal(statusFor({ state: 'open', title: '待分类', labels: [] }, 'issue'), 'Inbox');
});
