'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProject, findItem, synchronizeProject } = require('../scripts/project.js');
const { pullRequest, project } = require('./fixtures.js');

function items(nodes, hasNextPage = false, endCursor = null) {
  return { node: { items: { nodes, pageInfo: { hasNextPage, endCursor } } } };
}

function projectApi({ existing = false, failAdd = false, omitAddId = false, confirmStatus = true } = {}) {
  const board = project();
  const calls = [];
  let itemExists = existing;
  return {
    calls,
    async graphql(query, variables) {
      calls.push({ query, variables });
      if (query.startsWith('query Project')) return { user: { projectV2: board } };
      if (query.startsWith('query Items')) return items(itemExists ? [{ id: 'PVTI_example', content: { id: 'PR_example' } }] : []);
      if (query.startsWith('mutation AddItem')) {
        itemExists = true;
        if (failAdd) throw new Error('并发添加冲突');
        return { addProjectV2ItemById: { item: omitAddId ? {} : { id: 'PVTI_example' } } };
      }
      if (query.startsWith('mutation UpdateItem')) {
        const status = board.fields.nodes[0].options.find(option => option.id === variables.optionId).name;
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId, fieldValueByName: { name: confirmStatus ? status : 'Inbox' } } } };
      }
      throw new Error('未预期的 GraphQL 请求');
    },
  };
}

test('Project 身份、开放状态与完整 Status 选项在写入前校验', () => {
  assert.equal(validateProject(project()).name, 'Status');
  assert.throws(() => validateProject(null), /未找到/);
  assert.throws(() => validateProject({ ...project(), title: 'another project' }), /名称/);
  assert.throws(() => validateProject({ ...project(), closed: true }), /已关闭/);
  const missing = project();
  missing.fields.nodes[0].options = missing.fields.nodes[0].options.filter(option => option.name !== 'Done');
  assert.throws(() => validateProject(missing), /Done/);
  const duplicate = project();
  duplicate.fields.nodes[0].options.push({ id: 'another-done', name: 'Done' });
  assert.throws(() => validateProject(duplicate), /唯一/);
});

test('Project 条目查询支持多页，不误认其它内容', async () => {
  const cursors = [];
  const api = { graphql: async (_query, variables) => {
    cursors.push(variables.cursor);
    return variables.cursor ? items([{ id: 'match', content: { id: 'target' } }]) : items([{ id: 'other', content: { id: 'else' } }, { id: 'draft', content: null }], true, 'next');
  } };
  assert.equal(await findItem(api, 'project', 'target'), 'match');
  assert.deepEqual(cursors, [null, 'next']);
});

test('无权限或异常分页不能当作条目不存在', async () => {
  await assert.rejects(findItem({ graphql: async () => ({ node: null }) }, 'project', 'target'), /无法读取/);
  await assert.rejects(findItem({ graphql: async () => items([], true, 'same') }, 'project', 'target'), /游标/);
});

test('已有条目只更新状态，不重复添加', async () => {
  const api = projectApi({ existing: true });
  assert.deepEqual(await synchronizeProject(api, pullRequest({ state: 'closed' }), 'pull_request'), { itemId: 'PVTI_example', status: 'Done' });
  assert.equal(api.calls.filter(call => call.query.startsWith('mutation AddItem')).length, 0);
});

test('新条目添加后更新并确认实际状态', async () => {
  const api = projectApi();
  assert.equal((await synchronizeProject(api, pullRequest(), 'pull_request')).status, 'Bug Fix');
  assert.equal(api.calls.filter(call => call.query.startsWith('mutation AddItem')).length, 1);
});

test('仅在重新查询到实际条目时接受并发添加冲突', async () => {
  const api = projectApi({ failAdd: true });
  assert.equal((await synchronizeProject(api, pullRequest(), 'pull_request')).itemId, 'PVTI_example');
  assert.equal(api.calls.filter(call => call.query.startsWith('query Items')).length, 2);

  const failed = {
    graphql: async query => {
      if (query.startsWith('query Project')) return { user: { projectV2: project() } };
      if (query.startsWith('query Items')) return items([]);
      throw new Error('令牌没有 Projects 写权限');
    },
  };
  await assert.rejects(synchronizeProject(failed, pullRequest(), 'pull_request'), /写权限/);
});

test('缺少添加结果时重新读取，状态回读不符必须失败', async () => {
  assert.equal((await synchronizeProject(projectApi({ omitAddId: true }), pullRequest(), 'pull_request')).itemId, 'PVTI_example');
  await assert.rejects(synchronizeProject(projectApi({ confirmStatus: false }), pullRequest(), 'pull_request'), /不能视为同步成功/);
});

test('Project 不匹配时不发生任何 mutation', async () => {
  const calls = [];
  const api = { graphql: async query => {
    calls.push(query);
    return { user: { projectV2: { ...project(), title: 'wrong board' } } };
  } };
  await assert.rejects(synchronizeProject(api, pullRequest(), 'pull_request'), /名称/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('query '));
});
