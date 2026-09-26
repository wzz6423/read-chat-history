# 贡献指南

[English](CONTRIBUTING.md) | **简体中文**

欢迎为 read-chat-history 提交问题反馈、文档改进和代码。参与前请阅读[行为准则](CODE_OF_CONDUCT.zh-CN.md)；贡献的内容将按照本仓库的 [PolyForm Noncommercial License 1.0.0](LICENSE.md) 分发。

## 问题反馈

先搜索[已有 Issue](https://github.com/wzz6423/read-chat-history/issues)，再使用仓库提供的表单。

- 缺陷报告说明操作系统、Node.js 版本、来源工具及版本、执行命令、预期结果和实际结果。
- 新来源或格式支持请说明本地存储位置和数据结构，并提供最小的合成样例。不能公开的结构可先只描述字段。
- 不要提交真实会话、令牌、账号信息、个人路径或数据库副本。复现数据应手工构造或彻底脱敏。
- 安全问题按[安全策略](SECURITY.zh-CN.md)私下报告。

## 本地开发

需要 Node.js **22.13.0 或更新版本**。脚本使用 Node.js 内置模块，无需安装 npm 运行时依赖。

```bash
git clone https://github.com/wzz6423/read-chat-history.git
cd read-chat-history
node skills/chat-history/scripts/chat_history.js --help
npm run check
npm test
```

`npm test` 运行 Node.js 内置测试器。测试必须使用临时目录中的合成数据，并通过 `--home` 或 `--source-root` 隔离来源，避免读取开发者的真实聊天记录。

修改前先阅读相关解析器和现有测试，尽量复用格式处理逻辑。新增来源需要覆盖正常记录、缺失或损坏记录、来源隔离和读取范围；同时更新[技能说明](skills/chat-history/SKILL.zh-CN.md)与[来源说明](skills/chat-history/references/providers.zh-CN.md)。保持改动聚焦，不混入无关重构。

文档需同步维护两种语言：无后缀的 `.md` 为英文，`.zh-CN.md` 为简体中文。语言切换链接、示例、支持限制和验证结论应保持一致。许可证以英文 [LICENSE.md](LICENSE.md) 为准，[中文说明](LICENSE.zh-CN.md)用于帮助理解。

提交前运行相关检查，并清理测试生成的数据库、日志、二进制、构建产物和临时文件。真实会话和凭据不得进入 Git 历史。

## 分支与提交

从最新的 `main` 创建分支，每个 PR 处理一个明确目标。分支使用 `type/简短描述`，例如 `fix/kimi-message-order`、`docs/source-paths`；自动化也接受 `codex/` 和 `dependabot/` 前缀。

提交信息和 PR 标题全部使用英文，并采用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```text
feat(grok): support local session history
fix(codex): preserve message order
docs: clarify local data access
```

允许的类型为 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`、`build`、`ci`、`revert`。

## Pull Request

向 `main` 提交 PR，填写[仓库模板](.github/PULL_REQUEST_TEMPLATE.md)。正文全部使用英文，保留以下节标题：

| 节标题 | 需要说明的内容 |
| --- | --- |
| `Summary` | 原有问题、最终行为与改动范围。 |
| `Validation` | 每组填写 `- Status: passed`、`failed` 或 `not run`。前两者还需 `- Command:` 与 `- Result:`；未运行时填写 `- Reason:`。 |
| `Risk and Rollback` | 分别填写 `- Risk:` 与 `- Rollback:`，说明主要风险及回退方式。 |
| `Related Issue` | 使用 `Closes #123` 等方式关联 Issue，没有则写 `None`。 |

如使用 AI 协助，可在 `AI Attribution` 中记录工具及参与范围；若使用 `Co-authored-by`，请保证署名真实。贡献者仍需理解修改并核实测试结果。

`Validation` 可以包含多组记录。保留模板中的标题、字段名和状态值；不要把尚未验证的兼容性写成已通过。

仓库自动化根据标题推导类型标签，将 PR 分配给 `wzz6423`，并加入 [read-chat-history Development（Project #3）](https://github.com/users/wzz6423/projects/3)。PR 关闭后同步为 `Done`，重新打开时恢复对应类型的状态。无需在正文重复配置 Project 或 PR 类型。

提交后查看 GitHub Actions 的结果，修复与本次修改有关的失败。测试结果只能证明其覆盖的数据格式；新增工具版本和真实环境的验证范围请在 PR 中明确说明。

## 维护者：配置 Project 自动化

在仓库的 **Settings → Secrets and variables → Actions** 中添加 `PROJECT_AUTOMATION_TOKEN`。该令牌需要读取、写入目标用户 Project，以及读取本仓库 Issue 和 PR 的权限；请限制到所需范围。经典 PAT 可使用 `project` 和 `public_repo` scope。工作流自带的 `GITHUB_TOKEN` 无法直接写入个人 Project。

目标 Project 的 owner、序号、标题、`Status` 字段及状态映射由 [.github/project-automation.json](.github/project-automation.json) 管理。缺少令牌或配置不匹配时，工作流会明确失败。

在 **Actions → Project Automation → Run workflow** 中，`number` 留空会只读校验 Project #3 和状态配置；选择 `item_type` 并填写已有 Issue 或 PR 编号，可重新同步该条目。只读配置校验通过不代表实际条目同步已经执行，需另行核对条目及其状态。
