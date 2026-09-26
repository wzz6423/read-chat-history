# read-chat-history

**English** | [简体中文](README.zh-CN.md)

List, search, and read selected parts of AI conversation history on your machine. Run the command-line script directly or install it as the **chat-history** skill so your assistant can retrieve earlier discussions when needed.

Sources include Claude Code, Codex, Grok CLI, WorkBuddy, Kimi Code / Desktop, ZCode, and TRAE. See the [source reference](references/providers.md) for CLI storage formats and limitations. Newer TRAE SOLO / Work versions also have a [skill workflow for reading the application UI](references/trae-ui.md), which requires native computer-use tools in the host.

## Features

- Find sessions by source, project, and time.
- Search user prompts, or search conversation text with `--content`.
- Read the beginning, end, a selected message range, or messages from one role.
- Find the previous session for the current project and resume an earlier discussion.
- Use `--json` for structured output in your own scripts.

The script uses built-in Node.js modules and has **no npm runtime dependencies**. It requires **Node.js 22.13.0 or newer**; SQLite sources use the built-in `node:sqlite` module.

## Run directly

```bash
git clone https://github.com/wzz6423/read-chat-history.git
cd read-chat-history
node scripts/chat_history.js --help
node scripts/chat_history.js list --limit 10
```

The script reads the current user's local data directories and queries all sources by default. A source without recognizable local data produces no sessions. See the [source reference](references/providers.md) for platform-specific paths and format differences.

Documentation is available in English and Simplified Chinese. Human-readable CLI help and diagnostics currently use Chinese; command names and flags are the same in both documentation versions.

## Install as a skill

The repository is named `read-chat-history`; the skill is named `chat-history`. Choose an installation directory for your tool. The commands below work in Bash / Zsh.

Claude Code:

```bash
mkdir -p ~/.claude/skills
git clone https://github.com/wzz6423/read-chat-history.git ~/.claude/skills/chat-history
```

Codex versions that support `SKILL.md`:

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/wzz6423/read-chat-history.git ~/.codex/skills/chat-history
```

You can also copy `SKILL.md`, `SKILL.zh-CN.md`, `scripts/`, and `references/` into a `skills/chat-history/` directory, preserving their relative paths. Windows users can use the same directory structure. Check an existing installation before updating a directory with the same name.

After installation, ask your assistant to "list recent sessions for this project", "find our earlier discussion about database migrations", or "read the last ten messages from the previous session". Usage rules are in [SKILL.md](SKILL.md).

## Common commands

Run these commands from the repository directory, or replace the script path with its absolute installation path. Replace `SESSION_ID` with a session ID from `list` or `search`; unique prefixes are accepted.

```bash
# Recent sessions, or a specific source and project
node scripts/chat_history.js list --limit 10
node scripts/chat_history.js list --source kimi --project my-project
node scripts/chat_history.js list --source codex --since 2026-09-01 --until "2026-09-10 18:00"

# Locate a session before expanding selected messages
node scripts/chat_history.js show SESSION_ID --tail 10
node scripts/chat_history.js show SESSION_ID --range 3:8 --role user
node scripts/chat_history.js show SESSION_ID --head 5 --full

# Search prompts; --content also searches conversation text
node scripts/chat_history.js search "database migration"
node scripts/chat_history.js search "database migration" --content --source codex

# Previous session for the project in the current directory
node scripts/chat_history.js last --tail 20
node scripts/chat_history.js last --project my-project --grace 0

# Structured output
node scripts/chat_history.js list --source grok --json
```

`--range A:B` is one-based and includes both endpoints. When combined with `--role`, the range applies after filtering by role. Each message is limited to 800 characters by default; `--full` shows its complete text. `last` skips sessions with activity in the last 120 seconds by default; use `--grace 0` to include a session that just ended. Dates and times use the machine's local time zone.

`--cwd` filters projects by the directory where you run the command. For example, run `node /path/to/chat-history/scripts/chat_history.js list --cwd` inside your project. For sessions without a project path, query by source or ID instead.

## Sources and custom directories

| Tool | `--source` value |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Grok CLI | `grok` |
| WorkBuddy | `workbuddy` |
| Kimi Code / Desktop | `kimi` |
| ZCode | `zcode` |
| TRAE (legacy workspace session storage) | `trae` |
| All sources (default) | `all` |

Grok conversation text comes from its native ACP `updates.jsonl`; `chat_history.jsonl` contains model context and is not used as conversation text. ZCode reads main sessions and excludes subagents with a nonempty `parent_id`.

CLI support is limited to the [recognized local storage formats](references/providers.md). It does not cover similarly named web services, cloud-only sessions, or messages that were never saved locally. Client updates may change compatibility. The source reference describes text availability, paths, and known limits.

TRAE has two distinct reading methods:

| Method | Scope |
| --- | --- |
| CLI: `--source trae` | Reads conversation text from legacy workspace SQLite storage. It cannot directly read or decrypt the newer SOLO / Work `ModularData/ai-agent/database.db`. |
| `chat-history` skill: application UI | When the host provides native computer-use tools, the skill can open existing SOLO / Work tasks, read displayed messages, and expand or scroll as needed. This was verified with `TraeWork CN` in Codex on macOS; other hosts and platforms depend on their available tools. |

Follow the [TRAE UI guide](references/trae-ui.md) and report only what was actually read. Unloaded content is not a verified complete conversation, and CLI options such as `--json` do not apply to this UI workflow. Without native UI tools, support is limited to the CLI formats.

You can specify an isolated home directory or one tool's data root:

```bash
node scripts/chat_history.js list --home /path/to/isolated-home
node scripts/chat_history.js list --source grok --source-root /path/to/.grok
```

`--home` points to a user home containing directories such as `.claude` and `.codex`. `--source-root` points to one tool's data root and requires a specific `--source`; it cannot be combined with `all`.

## Privacy and data boundaries

The CLI only reads local session files or queries databases in read-only mode. It does not modify original records, upload conversations, or call remote AI APIs.

Output may contain prompts, answers, project paths, and tool calls. When an assistant reads this output through the skill, it becomes part of that assistant's context; further processing depends on your tool and configuration. Redact examples before sharing them, and do not commit real conversations or databases to this repository.

## Contributing

Run `npm run check` and `npm test` to validate changes. Tests use synthetic data. When adding a source or format version, state what you actually verified in the PR.

- [Contributing guide](CONTRIBUTING.md): development, tests, commits, and PR conventions.
- [Code of conduct](CODE_OF_CONDUCT.md): community participation and behavior reports.
- [Security policy](SECURITY.md): private vulnerability reports and support scope.
- [GitHub Project #3](https://github.com/users/wzz6423/projects/3): development board and PR status.

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). The source is public and may be used for purposes permitted by that license. Commercial use is not included in the default grant. The full license governs the rights and conditions.
