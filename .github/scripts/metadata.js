'use strict';

const contract = require('../pr-automation.json');
const projectContract = require('../project-automation.json');

function sections(body, level = 2) {
  const result = new Map();
  let current;
  let fence;
  const heading = new RegExp(`^ {0,3}#{${level}}\\s+(.+?)\\s*$`);
  const text = String(body || '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const line of text.split('\n')) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (delimiter) {
      fence = delimiter[1];
      continue;
    }
    const match = line.match(heading);
    if (match) {
      current = match[1];
      if (!result.has(current)) result.set(current, []);
    } else if (current) {
      result.get(current).push(line);
    }
  }
  return result;
}

function typeForTitle(title) {
  const types = contract.types.map(entry => entry.type).join('|');
  const match = String(title || '').match(new RegExp(`^(${types})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S[^\\r\\n]*$`));
  return match && contract.types.find(entry => entry.type === match[1]);
}

function hasValue(value) {
  return Boolean(value?.trim()) && !/^(?:todo|tbd|n\/a|待填写|待补充|\.{3}|…|_no response_)$/i.test(value.trim());
}

function field(lines, key) {
  const pattern = new RegExp(`^\\s*[-*]\\s+${key}:\\s*(.*?)\\s*$`, 'i');
  return (lines || []).map(line => line.match(pattern)?.[1]).filter(hasValue);
}

function validatePullRequest(pr) {
  const errors = [];
  if (!typeForTitle(pr.title) || String(pr.title).length > 120) {
    errors.push('标题须为 type(scope): 描述或 type: 描述，最多 120 字符；类型见 CONTRIBUTING.md。');
  }
  const prefixes = contract.branchPrefixes.join('|');
  if (!new RegExp(`^(?:${prefixes})/[a-z0-9][a-z0-9._/-]*$`).test(pr.head?.ref || '')) {
    errors.push('分支须为 type/slug 或 codex/slug，使用小写字母、数字和连字符。');
  }
  if (pr.user?.login === 'dependabot[bot]' && pr.user?.type === 'Bot' && pr.head?.ref?.startsWith('dependabot/')) return errors;

  const parsed = sections(pr.body);
  for (const name of ['Summary', 'Validation', 'Risk and Rollback', 'Related Issue']) {
    if (!parsed.has(name)) errors.push(`正文缺少 ## ${name}。`);
  }
  if (parsed.has('Summary') && !hasValue(parsed.get('Summary').join('\n'))) errors.push('Summary 须说明问题和变更。');

  if (parsed.has('Validation')) {
    const blocks = [];
    for (const line of parsed.get('Validation')) {
      if (/^\s*[-*]\s+Status:/i.test(line)) blocks.push([]);
      blocks.at(-1)?.push(line);
    }
    if (!blocks.length) errors.push('Validation 须包含 - Status: passed、failed 或 not run。');
    for (const [index, block] of blocks.entries()) {
      const statuses = field(block, 'Status');
      const status = statuses[0]?.toLowerCase();
      if (statuses.length !== 1 || !['passed', 'failed', 'not run'].includes(status)) {
        errors.push(`Validation 第 ${index + 1} 组的 Status 无效。`);
        continue;
      }
      for (const key of status === 'not run' ? ['Reason'] : ['Command', 'Result']) {
        if (field(block, key).length !== 1) errors.push(`Validation 第 ${index + 1} 组须填写一个有效的 ${key}。`);
      }
    }
  }

  if (parsed.has('Risk and Rollback')) {
    for (const key of ['Risk', 'Rollback']) {
      if (field(parsed.get('Risk and Rollback'), key).length !== 1) errors.push(`Risk and Rollback 须填写一个有效的 ${key}。`);
    }
  }
  if (parsed.has('Related Issue')) {
    const related = parsed.get('Related Issue').join('\n').trim();
    const none = /^\s*(?:-\s+)?None\s*$/im.test(related);
    const reference = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*\b|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\b)/i.test(related);
    if (none === reference) errors.push('Related Issue 须填写 None 或 Closes #123 等关闭引用，不能同时填写。');
  }
  return errors;
}

function metadataFor(item, kind) {
  const labels = [];
  const managed = [];
  if (kind === 'pull_request') {
    const type = typeForTitle(item.title);
    if (type) {
      labels.push(type.label);
      managed.push(...contract.types.map(entry => entry.label));
    }
  } else {
    const issueKind = contract.issueKinds.find(entry => String(item.title || '').startsWith(`${entry.prefix} `));
    if (issueKind) {
      labels.push(issueKind.label);
      managed.push(...contract.issueKinds.map(entry => entry.label));
    }
    const parsed = sections(item.body, 3);
    if (parsed.has('所属范围')) {
      const area = contract.issueAreas.find(entry => entry.name === parsed.get('所属范围').join('\n').trim());
      if (area) labels.push(area.label);
      managed.push(...contract.issueAreas.map(entry => entry.label));
    }
  }
  return { labels, managed };
}

function labelChanges(current, desired, managed) {
  return {
    add: desired.filter(label => !current.includes(label)),
    remove: current.filter(label => managed.includes(label) && !desired.includes(label)),
  };
}

function statusFor(item, kind, config = projectContract) {
  if (['closed', 'merged'].includes(String(item.state).toLowerCase())) return config.closedStatus;
  const current = (item.labels || []).map(label => typeof label === 'string' ? label : label.name);
  const metadata = metadataFor(item, kind);
  const changes = labelChanges(current, metadata.labels, metadata.managed);
  // GITHUB_TOKEN 添加标签不会再次触发工作流；直接推导当前元数据也避免读取到旧类型标签。
  const effective = current.filter(label => !changes.remove.includes(label)).concat(changes.add);
  return config.labelStatus.find(rule => effective.includes(rule.label))?.status || config.defaultStatus;
}

function labelCatalog() {
  return [...contract.types, ...contract.issueAreas];
}

module.exports = { contract, projectContract, sections, typeForTitle, validatePullRequest, metadataFor, labelChanges, statusFor, labelCatalog };
