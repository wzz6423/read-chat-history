# 来源格式与验证边界

[English](providers.md) | **简体中文**

CLI 使用 Node.js 22.13 及以上版本的内置模块。历史读取不请求网络，不启动模型，不修改原应用文件；SQLite 使用 `DatabaseSync(..., {readOnly: true})`。测试在自动清理的临时目录中生成合成记录，不使用真实聊天作为测试材料。

| `--source` | 默认数据位置 | 读取范围 |
| --- | --- | --- |
| `claude` | `~/.claude/projects/<项目>/<id>.jsonl` | Claude Code 主会话；提问索引来自 `history.jsonl` |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` | Codex 事件与原始消息；标题及提问索引来自同一根目录 |
| `grok` | `~/.grok/sessions/<编码项目>/<id>/updates.jsonl` | Grok ACP 会话更新流，元信息来自 `summary.json` |
| `workbuddy` | `~/.workbuddy/projects/<项目>/<id>.jsonl` | WorkBuddy 主会话，`workbuddy.db` 用于补充标题和删除状态 |
| `kimi` | `~/.kimi-code`、`~/.kimi`、Kimi Desktop 的本地运行时目录 | 新版 Code／Desktop 的 wire 协议与旧版 CLI 上下文 |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | ZCode 的 `session`、`message`、`part` 表；排除有 `parent_id` 的子代理 |
| `trae` | TRAE 用户数据根的 `User/*Storage/.../state.vscdb` | CLI 读取旧版 Memento 会话；当前 SOLO／TraeWork 使用[只读界面流程](trae-ui.zh-CN.md) |

数据位置按格式识别，不代表同名产品的所有历史版本、云端会话或浏览器缓存都已兼容。`list --source X --json` 可确认当前 CLI 发现的会话；标准错误中的“不支持”诊断不能等同于“没有历史”。

## 自定义目录与命令约定

- `--home /path/to/home` 替换所有默认路径中的用户目录，适合备份目录和隔离测试。
- `--source-root /path/to/data --source X` 直接指定该工具的数据根，不能与 `--source all` 一起使用。例如 Grok 指向包含 `sessions` 的目录，ZCode 指向包含 `cli/db/db.sqlite` 的目录，TRAE 指向包含 `User` 的用户数据目录。
- 不自动使用 `CODEX_HOME`、`GROK_HOME` 等来源环境变量；迁移过的目录需要明确传入 `--source-root`。
- Kimi 的根目录还可以指向 Desktop 用户数据目录或 `daimon-share`，适配器会识别其中已知的运行时布局。
- 项目按路径子串匹配，忽略大小写；绝对路径存在别名时会尝试解析符号链接。`--cwd` 使用调用命令时的工作目录。
- 时间参数按本地时区解析；`--until 2026-01-02` 是当天 00:00，不代表整天。列表按会话时间跨度筛选，搜索按匹配消息时间筛选。无消息时间的格式用会话最近时间作为搜索依据。
- 默认搜索用户提问。Claude／Codex 已有提问索引的会话以索引为准；缺索引会话及其他来源读取用户消息。`--content` 搜索用户和助手正文。
- `last` 根据每个会话的最近活动时间跳过默认 120 秒内活跃的会话。全部活跃时会报错，`--grace 0` 可明确包含它们。SQLite 来源使用会话时间，不把整个数据库的修改时间当成每个会话的活动时间。

## Claude Code

JSONL 的 `type` 为 `user`／`assistant`，正文位于 `message.content` 的字符串或 `text` 内容块。默认忽略 `isSidechain`、命令回显和已知系统注入；主项目目录下更深的子代理文件不参与发现。`--tools` 保留原技能行为，将工具调用摘要附在对应助手消息中。

`history.jsonl` 使用 `{sessionId,display,project,timestamp}`，时间为毫秒。索引缺失时可以从正文恢复提问搜索，项目可回退到首条记录的 `cwd`。

## Codex

`session_meta` 提供项目与开始时间，开始时间优先读取明确时间戳，文件名作为兜底。读取 `event_msg` 的 `user_message`／`agent_message`，也读取 `response_item` 的用户／助手 `message`。两种表示按角色和正文一对一配对，避免重复显示，同时保留重复同文提问的实际次数以及只有原始响应的回答。

工具调用保持原始顺序，需 `--tools` 才显示。`analysis` 通道和已知环境注入不会出现在正文中；普通 XML／HTML 提问不会因以 `<` 开头而被整体丢弃。目前默认发现范围是 `sessions`，不扫描任意日志、浏览器缓存或其他导出目录。

## Grok

Grok 1.0.41 随附的 `user-guide/17-sessions.md` 将 `updates.jsonl` 定义为恢复会话使用的权威记录，`15-agent-mode.md` 描述 ACP 更新结构：

```text
method: session/update
params.update.sessionUpdate: user_message_chunk | agent_message_chunk | tool_call | ...
params.update.content: {type: text, text: ...}
timestamp: 毫秒
```

读取器拼接相邻文本分片，在角色、提问编号、工具或轮次边界处分开；不展示 `agent_thought_chunk`。工具调用摘要由 `--tools` 控制。`summary.json` 的 `info.id`／`info.cwd`、标题和时间用于列表，正文文件修改时间也参与活动判断。长项目目录的 `.cwd` 文件可以恢复原始路径。

不读取 `system_prompt.txt`、`prompt_context.json`、`chat_history.jsonl` 模型上下文或配置凭证。已核对本地 ACP 与官方随附文档；本机样本中的失败会话仅有用户消息，完整助手分片及工具组合由合成测试验证。

## WorkBuddy

原生 JSONL 消息结构为 `type: message`，带 `role`、`sessionId`、`cwd` 和毫秒 `timestamp`。正文块使用 `input_text`／`output_text`；`reasoning`、图片引用、快照及工具结果不作为默认正文。`--tools` 读取 `function_call` 的调用摘要。

`workbuddy.db` 的 `sessions` 表提供 `custom_title`／`title`、`cwd`、创建和活动时间。`deleted_at` 非空且非零的会话跳过；没有数据库时仍可从正文和 `ai-title` 行读取。只扫描项目下的主 JSONL，不递归读取 `subagents`。已用本机这种 JSONL 与索引格式验证列表和消息解析。

## Kimi Code、Desktop 与旧版 CLI

新版 Code 默认根为 `~/.kimi-code`。已确认的协议版本为 wire 1.4：

```text
session_index.jsonl
sessions/<工作目录桶>/<id>/state.json
sessions/<工作目录桶>/<id>/agents/main/wire.jsonl
```

读取 `context.append_message` 和 `context.append_loop_event` 中的文本，拼接流式回答，去重同时写入 prompt 与 context 的用户消息。不会从 `llm.request` 提取请求头或模型系统提示词；思考、标题生成任务和子代理不混入主会话。

macOS Desktop 已确认的数据根为：

```text
~/Library/Application Support/kimi-desktop/
  daimon-share/daimon/runtime/kimi-code/home/
```

其他系统使用相同应用目录布局，并从指定的 `--home` 推导常见用户数据路径；迁移位置通过 `--source-root` 指定。Windows／Linux 的应用实际安装目录可能不同，需要显式指定。

旧版 `~/.kimi` 支持 `kimi.json` 的工作目录索引，以及 `sessions/<工作目录哈希>/<id>/context.jsonl` 和旧的 `<id>.jsonl`。正文是 `role`／`content`，没有逐条时间的旧格式会输出空消息时间。索引中的任意路径不能把正文读取重定向到来源目录外。

现代格式对照 [Kimi Code 会话文档](https://github.com/MoonshotAI/kimi-code/blob/be7d5f5fea7800778e4660cd5f36780ba783bddd/docs/zh/guides/sessions.md) 及该提交的 session-store／context-projector；已用本机 Desktop 会话核对结构。完整回答、工具与中断组合使用合成测试，不把本机仅有用户和工具的样本当成完整助手验证。

## ZCode

已确认的 ZCode 0.16.3／0.16.5 会话数据库包含：

- `session`：`id`、`directory`、`title`、`time_created`、`time_updated`、可选 `parent_id`。
- `message`：`id`、`session_id`、`data`、`sequence`、`time_created`；`data` 中保存角色和可见性。
- `part`：`message_id`、`session_id`、`data`、`sequence`、`time_created`；`data` 中保存文本或工具调用。

消息按 sequence 与时间读取。`parent_id` 非空的子代理、synthetic 记录和 `transcriptVisibility: hidden` 的内部消息跳过；`reasoning` 不显示。`--tools` 可显示工具调用摘要。本机 CLI 与桌面产生的这套共享存储已验证。

不从 `cli/rollout` 的 `model_io` 请求转储恢复历史，避免将请求头、重复模型输入和完整系统上下文混入聊天。`v2/tasks-index.sqlite` 是任务索引，不作为正文来源。

## TRAE、TRAE SOLO 与 TraeWork

CLI 支持旧版 `state.vscdb` 的 `ItemTable`，严格匹配：

```text
memento/icube-ai-agent-storage[-用户id]
memento/icube-ai-ng-chat-storage-用户id
value.list[]: {sessionId,title,createdAt,updatedAt,messages}
message: {role,content,parsedQuery,timestamp,status}
```

时间为毫秒。`content` 是字符串；`parsedQuery` 只提取字符串片段，不把 mention 对象、附件或任意缓存当成正文。删除消息和非用户／助手角色跳过，项目由同目录 `workspace.json` 恢复。

默认尝试 macOS `~/Library/Application Support`、Windows `~/AppData/Roaming`、Linux `~/.config` 下的 `Trae`、`Trae CN`、`TRAE SOLO`、`TRAE SOLO CN` 数据目录，也接受 `--source-root`。旧格式依据本机安装包的 Memento 读写代码核对，并通过合成 SQLite 测试；本机当前应用没有该格式的实际会话正文，不能宣称旧缓存的真机正文恢复已验证。

当前 SOLO／TraeWork 的 `ModularData/ai-agent/database.db` 并非本适配器支持的标准 SQLite。CLI 检测到它会提示限制；不尝试解密、修改数据库或把空列表解释为没有聊天。支持 computer-use 的技能宿主可按 [TRAE 只读界面流程](trae-ui.zh-CN.md) 从应用的历史任务列表读取已有会话，当前 TraeWork CN 已验证这一渠道。没有界面工具的普通终端环境，仅有旧版缓存读取能力。

TRAE 的界面读取与 CLI 是不同渠道。界面流程不会给 CLI 增加数据库兼容，也没有假定未验证的 Markdown 导出格式。
