'use strict';

const { projectContract, statusFor } = require('./metadata.js');

const PROJECT_QUERY = `query Project($login: String!, $number: Int!) {
  user(login: $login) {
    projectV2(number: $number) {
      id title closed
      fields(first: 100) {
        nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
      }
    }
  }
}`;

const ITEMS_QUERY = `query Items($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        nodes { id content { ... on Issue { id } ... on PullRequest { id } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const ADD_ITEM = `mutation AddItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}`;

const UPDATE_ITEM = `mutation UpdateItem($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!, $fieldName: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item {
      id
      fieldValueByName(name: $fieldName) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    }
  }
}`;

function validateProject(project, config = projectContract) {
  if (!project?.id) throw new Error('未找到配置的 GitHub Project；请检查项目序号与令牌权限。');
  if (project.title !== config.project.title) throw new Error('GitHub Project 名称与配置不一致，已停止同步。');
  if (project.closed) throw new Error('GitHub Project 已关闭，已停止同步。');
  const fields = (project.fields?.nodes || []).filter(field => field?.name === config.statusField);
  if (fields.length !== 1) throw new Error('未找到唯一的单选 Status 字段。');
  const field = fields[0];
  if (!field.id) throw new Error('单选 Status 字段缺少标识符。');
  const required = new Set([config.defaultStatus, config.closedStatus, ...config.labelStatus.map(rule => rule.status)]);
  for (const status of required) {
    if (field.options?.filter(option => option.name === status && option.id).length !== 1) throw new Error(`GitHub Project 缺少唯一的 Status 选项：${status}。`);
  }
  return field;
}

async function readProject(api, config = projectContract) {
  const data = await api.graphql(PROJECT_QUERY, { login: config.project.owner, number: config.project.number });
  const project = data.user?.projectV2;
  const field = validateProject(project, config);
  return { project, field };
}

async function findItem(api, projectId, contentId) {
  let cursor = null;
  const seen = new Set();
  do {
    const data = await api.graphql(ITEMS_QUERY, { projectId, cursor });
    const page = data.node?.items;
    if (!Array.isArray(page?.nodes) || !page.pageInfo) throw new Error('无法读取 GitHub Project 条目。');
    const match = page.nodes.find(item => item?.content?.id === contentId);
    if (match?.id) return match.id;
    if (!page.pageInfo.hasNextPage) return null;
    cursor = page.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error('GitHub Project 分页游标无效。');
    seen.add(cursor);
  } while (cursor);
  return null;
}

async function synchronizeProject(api, item, kind, config = projectContract) {
  if (!item.node_id) throw new Error('Issue 或 PR 缺少 GitHub 节点 ID。');
  const { project, field } = await readProject(api, config);
  const status = statusFor(item, kind, config);
  const option = field.options.find(entry => entry.name === status);
  let itemId = await findItem(api, project.id, item.node_id);
  if (!itemId) {
    let addError;
    try {
      const added = await api.graphql(ADD_ITEM, { projectId: project.id, contentId: item.node_id });
      itemId = added.addProjectV2ItemById?.item?.id;
    } catch (error) {
      addError = error;
    }
    // 同时发生的事件可能已添加同一条目；确认实际存在后才接受添加冲突。
    if (!itemId) itemId = await findItem(api, project.id, item.node_id);
    if (!itemId) throw addError || new Error('无法将 Issue 或 PR 添加到 GitHub Project。');
  }
  const updated = await api.graphql(UPDATE_ITEM, {
    projectId: project.id,
    itemId,
    fieldId: field.id,
    optionId: option.id,
    fieldName: config.statusField,
  });
  const result = updated.updateProjectV2ItemFieldValue?.projectV2Item;
  if (result?.id !== itemId || result.fieldValueByName?.name !== status) {
    throw new Error('GitHub Project 未确认预期的 Status，不能视为同步成功。');
  }
  return { itemId, status };
}

module.exports = { validateProject, readProject, findItem, synchronizeProject };
