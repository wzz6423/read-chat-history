#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { contract, projectContract, labelCatalog, sections } = require('./metadata.js');

const root = path.resolve(__dirname, '../..');

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (['.git', 'node_modules'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(file);
    return entry.isFile() ? [file] : [];
  });
}

function check() {
  const errors = [];
  for (const file of ['README.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'LICENSE.md', 'SECURITY.md', 'SKILL.md', 'package.json']) {
    if (!fs.existsSync(path.join(root, file))) errors.push(`缺少必备文件：${file}`);
  }
  if (errors.length) return errors;

  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || !/^name:\s*["']?chat-history["']?\s*$/m.test(frontmatter) || !/^description:\s*\S/m.test(frontmatter)) {
    errors.push('SKILL.md 须声明 name: chat-history 与非空 description frontmatter。');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (Object.keys(pkg.dependencies || {}).length) errors.push('运行时应只使用 Node.js 内置模块，不得引入 npm 运行时依赖。');

  const sourceFiles = ['scripts', 'tests', '.github'].flatMap(directory => {
    const full = path.join(root, directory);
    if (!fs.existsSync(full)) {
      errors.push(`缺少源码或测试目录：${directory}`);
      return [];
    }
    return filesUnder(full).filter(file => /\.[cm]?js$/.test(file));
  });
  for (const file of sourceFiles) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', shell: false });
    if (result.error || result.status !== 0) errors.push(`${path.relative(root, file)} 语法检查失败：${result.error?.message || result.stderr}`);
  }

  for (const file of filesUnder(root).filter(file => file.endsWith('.md'))) {
    const markdown = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, '');
    const links = markdown.matchAll(/\[[^\]\n]+\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g);
    for (const match of links) {
      const target = match[1] || match[2];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      const local = decodeURIComponent(target.split(/[?#]/)[0]);
      if (local && !fs.existsSync(path.resolve(path.dirname(file), local))) errors.push(`${path.relative(root, file)} 含无效本地链接：${target}`);
    }
  }

  const catalog = labelCatalog();
  if (new Set(catalog.map(entry => entry.label)).size !== catalog.length) errors.push('自动化标签名称重复。');
  for (const entry of catalog) {
    if (!/^[0-9a-f]{6}$/i.test(entry.color) || !entry.description) errors.push('自动化标签的颜色或描述无效。');
    if (!projectContract.labelStatus.some(rule => rule.label === entry.label)) errors.push(`标签缺少 Project 状态映射：${entry.label}`);
  }
  for (const kind of contract.issueKinds) {
    if (!catalog.some(entry => entry.label === kind.label)) errors.push('Issue 类型引用了未定义的标签。');
  }
  const template = sections(fs.readFileSync(path.join(root, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'));
  for (const section of ['Summary', 'Validation', 'Risk and Rollback', 'Related Issue']) {
    if (!template.has(section)) errors.push(`PR 模板缺少 ${section}。`);
  }
  for (const name of ['bug_report.yml', 'feature_request.yml']) {
    const form = fs.readFileSync(path.join(root, '.github/ISSUE_TEMPLATE', name), 'utf8');
    for (const area of contract.issueAreas) {
      if (!form.includes(`- ${area.name}\n`)) errors.push(`${name} 缺少所属范围选项：${area.name}`);
    }
  }
  if (!errors.length) console.log(`检查通过：${sourceFiles.length} 个 JavaScript 文件、Skill 和社区文档、Markdown 本地链接及自动化契约。`);
  return errors;
}

if (require.main === module) {
  try {
    const errors = check();
    errors.forEach(error => console.error(error));
    if (errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(`仓库检查失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { filesUnder, check };
