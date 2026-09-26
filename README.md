# read-chat-history

在本机列出、搜索和局部读取 AI 工具的历史会话。既可直接运行命令行脚本，也可安装为 **chat-history** 技能，让 AI 助手按需找回以前的讨论。

来源包括 Claude Code、Codex、Grok CLI、WorkBuddy、Kimi Code / Desktop、ZCode 和 TRAE。CLI 的本地数据格式与限制见[来源说明](references/providers.md)；新版 TRAE SOLO / Work 另提供依赖宿主原生电脑操作工具的[技能界面读取路径](references/trae-ui.md)。

## 能做什么

- 按来源、项目和时间定位会话。
- 搜索用户提问，或使用 `--content` 搜索会话正文。
- 只读开头、结尾、指定消息区间，或某一角色的消息。
- 找到当前项目的上一段会话，继续之前的话题。
- 使用 `--json` 输出结构化结果，便于接入自己的脚本。

脚本使用 Node.js 内置模块，**无需安装 npm 运行时依赖**。需要 **Node.js 22.13.0 或更新版本**；SQLite 来源使用内置 `node:sqlite`。

## 直接运行

```bash
git clone https://github.com/wzz6423/read-chat-history.git
cd read-chat-history
node scripts/chat_history.js --help
node scripts/chat_history.js list --limit 10
```

脚本读取当前用户的本地数据目录。默认查询全部来源；没有可识别本地数据的来源不会产生会话。各操作系统的数据路径和来源版本差异见[来源说明](references/providers.md)。

## 安装为技能

仓库名称是 `read-chat-history`，技能名称是 `chat-history`。根据使用的工具，选择一个安装位置；以下命令适用于 Bash / Zsh。

Claude Code：

```bash
mkdir -p ~/.claude/skills
git clone https://github.com/wzz6423/read-chat-history.git ~/.claude/skills/chat-history
```

Codex（支持 `SKILL.md` 的版本）：

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/wzz6423/read-chat-history.git ~/.codex/skills/chat-history
```

也可以把仓库中的 `SKILL.md`、`scripts/` 和 `references/` 一起复制到对应的 `skills/chat-history/` 目录，保持相对路径。Windows 用户可按相同目录结构安装。已有同名目录时，请先检查现有安装再更新。

安装后可直接对助手说：“列出这个项目最近的会话”“找以前讨论过的数据库迁移方案”或“读取上一段会话的最后十条消息”。技能的使用规则见 [SKILL.md](SKILL.md)。

## 常用命令

以下命令在仓库目录执行；也可以把脚本路径换成安装位置的绝对路径。`SESSION_ID` 替换为 `list` 或 `search` 输出的会话 ID，支持唯一前缀。

```bash
# 最近的会话，或指定来源与项目
node scripts/chat_history.js list --limit 10
node scripts/chat_history.js list --source kimi --project my-project
node scripts/chat_history.js list --source codex --since 2026-09-01 --until "2026-09-10 18:00"

# 局部读取；先定位，再按需展开
node scripts/chat_history.js show SESSION_ID --tail 10
node scripts/chat_history.js show SESSION_ID --range 3:8 --role user
node scripts/chat_history.js show SESSION_ID --head 5 --full

# 搜索提问；--content 扩展为正文搜索
node scripts/chat_history.js search "数据库迁移"
node scripts/chat_history.js search "数据库迁移" --content --source codex

# 当前目录对应项目的上一段会话
node scripts/chat_history.js last --tail 20
node scripts/chat_history.js last --project my-project --grace 0

# 结构化输出
node scripts/chat_history.js list --source grok --json
```

`--range A:B` 从 1 开始，包含两端；与 `--role` 同用时，范围作用于筛选后的消息。默认每条消息最多显示 800 字符，`--full` 显示完整内容。`last` 默认尝试跳过最近 120 秒内有活动的会话；需要读取刚结束的会话时使用 `--grace 0`。日期与时间使用本机时区。

`--cwd` 按运行命令时所在的目录筛选项目，例如在目标项目中执行 `node /path/to/chat-history/scripts/chat_history.js list --cwd`。对没有项目路径的会话，请直接按来源或 ID 查询。

## 来源与自定义目录

| 工具 | `--source` 值 |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Grok CLI | `grok` |
| WorkBuddy | `workbuddy` |
| Kimi Code / Desktop | `kimi` |
| ZCode | `zcode` |
| TRAE（旧版工作区会话存储） | `trae` |
| 全部来源（默认） | `all` |

Grok 的正文来自原生 ACP `updates.jsonl`；`chat_history.jsonl` 是模型上下文，不作为历史正文。ZCode 读取主会话，排除 `parent_id` 非空的子代理。

CLI 的支持范围以[已识别的本地存储格式](references/providers.md)为准。同名网页服务、纯云端会话和没有落盘的消息不在 CLI 的读取范围内；工具版本变化也可能影响兼容性。来源说明会区分正文可用性、路径和已知限制。

TRAE 的两种读取方式有不同的适用范围：

| 方式 | 支持范围 |
| --- | --- |
| CLI：`--source trae` | 读取旧版工作区 SQLite 中的会话正文；不能直接读取或解密新版 SOLO / Work 的 `ModularData/ai-agent/database.db`。 |
| `chat-history` 技能：应用界面 | 宿主已提供原生电脑操作能力时，可打开新版 SOLO / Work 的已有任务，读取当前显示的消息，并按需展开或滚动。已在 Codex / macOS 的 `TraeWork CN` 验证；其他宿主和平台需按其工具能力判断。 |

界面路径按[TRAE 界面读取指引](references/trae-ui.md)执行，只报告实际读取到的可见内容；未加载部分不属于已验证的完整会话，也不支持直接套用 CLI 的 `--json` 等参数。没有原生界面工具时，支持范围仍以 CLI 为准。

可以指定隔离的用户目录，或单个工具的数据根目录：

```bash
node scripts/chat_history.js list --home /path/to/isolated-home
node scripts/chat_history.js list --source grok --source-root /path/to/.grok
```

`--home` 对应包含 `.claude`、`.codex` 等目录的用户主目录；`--source-root` 对应指定工具的数据根目录，必须同时选择一个具体的 `--source`，不能与 `all` 同用。

## 隐私与数据边界

命令行脚本只在本机读取会话文件或以只读方式查询数据库，不修改原始记录、不上传聊天内容，也不调用远程 AI 接口。

会话输出可能包含提示词、回答、项目路径和工具调用。作为技能交给 AI 助手读取时，这些输出会进入该助手的上下文；后续处理取决于你使用的工具和配置。分享问题样例前请先脱敏，不要把真实聊天记录或数据库提交到本仓库。

## 参与共建

运行 `npm run check` 和 `npm test` 检查修改。测试使用合成数据；新增来源或版本时，应在 PR 中说明实际验证范围。

- [贡献指南](CONTRIBUTING.md)：开发、测试、提交与 PR 规范。
- [行为准则](CODE_OF_CONDUCT.md)：社区参与和行为报告。
- [安全策略](SECURITY.md)：私密漏洞报告和支持范围。
- [GitHub Project #3](https://github.com/users/wzz6423/projects/3)：开发看板与 PR 状态。

## 许可

采用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)。源码公开，允许许可规定的非商业用途；商业使用不在默认授权范围内。具体权利和条件以许可全文为准。
