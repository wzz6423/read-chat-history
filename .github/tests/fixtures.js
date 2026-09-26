'use strict';

const { projectContract } = require('../scripts/metadata.js');

const validBody = `## Summary
修复读取会话时丢失消息的问题。

## Validation
- Status: passed
- Command: npm test
- Result: 合成样本测试通过。

## Risk and Rollback
- Risk: 影响会话解析顺序。
- Rollback: 撤销此提交。

## Related Issue
None
`;

function pullRequest(overrides = {}) {
  return {
    number: 7,
    node_id: 'PR_example',
    state: 'open',
    title: 'fix(parser): 保持消息顺序',
    body: validBody,
    head: { ref: 'fix/message-order' },
    user: { login: 'contributor', type: 'User' },
    assignees: [],
    labels: [],
    ...overrides,
  };
}

function project() {
  const statuses = [...new Set([projectContract.defaultStatus, projectContract.closedStatus, ...projectContract.labelStatus.map(rule => rule.status)])];
  return {
    id: 'PVT_example',
    title: projectContract.project.title,
    closed: false,
    fields: { nodes: [{ id: 'PVTSSF_status', name: 'Status', options: statuses.map((name, index) => ({ id: `option_${index}`, name })) }] },
  };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

module.exports = { validBody, pullRequest, project, response };
