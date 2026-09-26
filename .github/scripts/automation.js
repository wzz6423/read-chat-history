#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { createClient } = require('./github-api.js');
const { contract, projectContract, validatePullRequest, metadataFor, labelChanges, labelCatalog } = require('./metadata.js');
const { readProject, synchronizeProject } = require('./project.js');

async function ensureLabel(api, repoPath, definition) {
  const labelPath = `${repoPath}/labels/${encodeURIComponent(definition.label)}`;
  try {
    await api.request('GET', labelPath);
    return;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  try {
    await api.request('POST', `${repoPath}/labels`, {
      name: definition.label,
      color: definition.color,
      description: definition.description,
    });
  } catch (error) {
    if (error.status !== 422) throw error;
    // 并发创建同名标签时，重新读取以区分冲突与真正的配置错误。
    await api.request('GET', labelPath);
  }
}

async function synchronizeMetadata(api, repoPath, item, kind) {
  const metadata = metadataFor(item, kind);
  const current = (item.labels || []).map(label => typeof label === 'string' ? label : label.name);
  const changes = labelChanges(current, metadata.labels, metadata.managed);
  for (const label of metadata.labels) {
    const definition = labelCatalog().find(entry => entry.label === label);
    if (!definition) throw new Error('自动化配置引用了未定义的标签。');
    await ensureLabel(api, repoPath, definition);
  }
  for (const label of changes.remove) {
    try {
      await api.request('DELETE', `${repoPath}/issues/${item.number}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (changes.add.length) {
    const applied = await api.request('POST', `${repoPath}/issues/${item.number}/labels`, { labels: changes.add });
    if (!changes.add.every(label => applied.some(entry => entry.name === label))) throw new Error('GitHub 未确认预期的标签。');
  }
  if (kind === 'pull_request' && !(item.assignees || []).some(user => user.login.toLowerCase() === contract.assignee.toLowerCase())) {
    const assigned = await api.request('POST', `${repoPath}/issues/${item.number}/assignees`, { assignees: [contract.assignee] });
    if (!assigned.assignees?.some(user => user.login.toLowerCase() === contract.assignee.toLowerCase())) throw new Error('GitHub 未能分配配置的 PR 负责人。');
  }
  return changes;
}

function repositoryPath(event, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || event.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('事件仓库与 GITHUB_REPOSITORY 不一致。');
  }
  return `/repos/${repository}`;
}

function eventTarget(event, repository) {
  const repoPath = repositoryPath(event, repository);
  const kind = event.pull_request ? 'pull_request' : event.issue ? 'issue' : event.inputs?.item_type;
  if (!['issue', 'pull_request'].includes(kind)) throw new Error('事件未包含有效的条目类型。');
  const number = event[kind]?.number ?? Number(event.inputs?.number);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('事件未包含有效的 Issue 或 PR 编号。');
  return { kind, number, repoPath };
}

async function run(mode, env = process.env, fetchImpl = fetch) {
  if (!['validate', 'metadata', 'project'].includes(mode)) throw new Error('用法：node .github/scripts/automation.js validate|metadata|project');
  if (!env.GITHUB_EVENT_PATH) throw new Error('缺少 GITHUB_EVENT_PATH。');
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (mode === 'validate') {
    if (!event.pull_request) throw new Error('PR 校验仅接受 pull_request 事件。');
    const errors = validatePullRequest(event.pull_request);
    if (errors.length) throw new Error(errors.join('\n'));
    return 'PR 标题、分支和正文校验通过。';
  }
  if (mode === 'project' && !env.PROJECT_AUTOMATION_TOKEN) {
    throw new Error('PROJECT_AUTOMATION_TOKEN 未配置，Project 未同步；请按 CONTRIBUTING.md 配置具有 Projects 写入权限的令牌。');
  }
  if (mode === 'project' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && !String(event.inputs?.number || '').trim()) {
    repositoryPath(event, env.GITHUB_REPOSITORY);
    await readProject(createClient(env.PROJECT_AUTOMATION_TOKEN, fetchImpl));
    return `${projectContract.project.title}（Project #${projectContract.project.number}）配置验证通过：已确认项目名称和全部 Status 选项，未同步条目。`;
  }
  const target = eventTarget(event, env.GITHUB_REPOSITORY);
  const api = createClient(env.GITHUB_TOKEN, fetchImpl);
  const endpoint = target.kind === 'pull_request' ? 'pulls' : 'issues';
  // 事件可能排队后才执行；读取最新状态，避免过期 closed/reopened 事件覆盖新状态。
  const item = await api.request('GET', `${target.repoPath}/${endpoint}/${target.number}`);
  if (item.number !== target.number || !item.node_id) throw new Error('GitHub 返回了不匹配的 Issue 或 PR。');
  if (mode === 'metadata') {
    const changes = await synchronizeMetadata(api, target.repoPath, item, target.kind);
    const assignee = target.kind === 'pull_request' ? `；负责人包含 @${contract.assignee}` : '';
    return `#${target.number} 元数据已同步：新增 ${changes.add.length} 个标签，移除 ${changes.remove.length} 个旧标签${assignee}。`;
  }
  const projectApi = createClient(env.PROJECT_AUTOMATION_TOKEN, fetchImpl);
  const result = await synchronizeProject(projectApi, item, target.kind);
  return `#${target.number} 已同步至 ${projectContract.project.title}（Project #${projectContract.project.number}），Status：${result.status}。`;
}

if (require.main === module) {
  run(process.argv[2]).then(message => {
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }).catch(error => {
    const message = String(error.message).replace(/[\r\n]+/g, ' ');
    console.error(`自动化失败：${message}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `自动化失败。请查看失败步骤日志；未确认的操作不视为已完成。\n`);
    process.exitCode = 1;
  });
}

module.exports = { ensureLabel, synchronizeMetadata, eventTarget, run };
