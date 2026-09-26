# Source formats and validation scope

**English** | [简体中文](providers.zh-CN.md)

The CLI uses built-in modules in Node.js 22.13 or newer. Reading history does not make network requests, start a model, or modify the source application's files. SQLite connections use `DatabaseSync(..., {readOnly: true})`. Tests create synthetic records in temporary directories that are cleaned up automatically; real conversations are not used as fixtures.

| `--source` | Default location | Reading scope |
| --- | --- | --- |
| `claude` | `~/.claude/projects/<project>/<id>.jsonl` | Main Claude Code sessions; prompt index from `history.jsonl` |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` | Codex events and raw messages; title and prompt indexes in the same data root |
| `grok` | `~/.grok/sessions/<encoded-project>/<id>/updates.jsonl` | Grok ACP session updates, with metadata from `summary.json` |
| `workbuddy` | `~/.workbuddy/projects/<project>/<id>.jsonl` | Main WorkBuddy sessions; `workbuddy.db` supplies titles and deletion state |
| `kimi` | `~/.kimi-code`, `~/.kimi`, and Kimi Desktop's local runtime directory | Wire protocol for newer Code / Desktop versions and context files for the older CLI |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | ZCode `session`, `message`, and `part` tables; excludes subagents with `parent_id` |
| `trae` | `User/*Storage/.../state.vscdb` under a TRAE user data root | CLI reads legacy Memento sessions; current SOLO / TraeWork uses the [read-only UI workflow](trae-ui.md) |

Paths are recognized by their storage formats. This does not establish compatibility with every version of a similarly named product, cloud-only sessions, or browser caches. Use `list --source X --json` to inspect the sessions the CLI discovers. An "unsupported" diagnostic on standard error does not mean that no history exists.

## Custom directories and command behavior

- `--home /path/to/home` replaces the user home in all default paths, which is useful for backups and isolated tests.
- `--source-root /path/to/data --source X` selects one tool's data root and cannot be combined with `--source all`. For example, the Grok root contains `sessions`, the ZCode root contains `cli/db/db.sqlite`, and the TRAE user data root contains `User`.
- Source environment variables such as `CODEX_HOME` and `GROK_HOME` are not used automatically. Specify moved data directories with `--source-root`.
- A Kimi root may also point to the Desktop user data directory or `daimon-share`; the adapter recognizes the known runtime layouts within it.
- Project filters use case-insensitive path substrings. For absolute paths with aliases, the reader also tries resolving symbolic links. `--cwd` uses the directory where the command is invoked.
- Times use the local time zone. `--until 2026-01-02` means 00:00 at the start of that date, not the whole day. Lists filter by session time span; searches filter by matching message timestamps. Formats without message timestamps use the session's latest time.
- Search targets user prompts by default. Claude / Codex sessions with prompt indexes use those indexes; other sessions use user messages from the conversation. `--content` searches user and assistant text.
- `last` uses each session's latest activity to skip sessions active within the default 120 seconds. It fails if all matches are active; `--grace 0` explicitly includes them. SQLite sources use per-session times rather than the modification time of the entire database.

## Claude Code

JSONL records have a `type` of `user` or `assistant`. Text comes from the string or `text` blocks in `message.content`. The reader skips `isSidechain`, command echoes, and known system injections. Subagent files in deeper directories are excluded from discovery. `--tools` preserves the original skill behavior of appending tool-call summaries to the corresponding assistant message.

`history.jsonl` uses `{sessionId,display,project,timestamp}` with millisecond timestamps. Without the index, prompt searches can fall back to conversation text, and the project can fall back to the first record's `cwd`.

## Codex

`session_meta` supplies the project and start time. An explicit timestamp takes precedence over the filename fallback. The reader handles `user_message` / `agent_message` in `event_msg`, as well as user / assistant `message` records in `response_item`. The two representations are matched one-to-one by role and text to avoid duplicates while preserving repeated identical prompts and answers recorded only as raw responses.

Tool calls retain their original order and appear only with `--tools`. The `analysis` channel and known environment injections are excluded from conversation text. Ordinary XML / HTML prompts are not discarded just because they start with `<`. Discovery currently scans `sessions`, not arbitrary logs, browser caches, or other export directories.

## Grok

The `user-guide/17-sessions.md` bundled with Grok 1.0.41 identifies `updates.jsonl` as the authoritative record used to restore sessions. `15-agent-mode.md` describes the ACP update structure:

```text
method: session/update
params.update.sessionUpdate: user_message_chunk | agent_message_chunk | tool_call | ...
params.update.content: {type: text, text: ...}
timestamp: milliseconds
```

The reader joins adjacent text chunks and separates them at role, prompt-index, tool, or turn boundaries. It does not show `agent_thought_chunk`. `--tools` controls tool-call summaries. Session lists use `info.id`, `info.cwd`, titles, and times from `summary.json`; the text file's modification time also contributes to activity detection. A `.cwd` file can recover the original path for long project directory names.

The reader does not use `system_prompt.txt`, `prompt_context.json`, `chat_history.jsonl` model context, or configuration credentials. The local ACP format and bundled official documentation have been checked. Failed sessions in the local sample contain only user messages; complete assistant chunks and tool combinations are covered by synthetic tests.

## WorkBuddy

Native JSONL messages have `type: message`, `role`, `sessionId`, `cwd`, and a millisecond `timestamp`. Text blocks use `input_text` / `output_text`. Reasoning, image references, snapshots, and tool results are excluded from default conversation text. `--tools` includes summaries of `function_call` records.

The `sessions` table in `workbuddy.db` supplies `custom_title` / `title`, `cwd`, and creation and activity times. Sessions with a nonempty, nonzero `deleted_at` are skipped. Without the database, the reader can still use conversation records and `ai-title` rows. It only scans main JSONL files under each project and does not recurse into `subagents`. Session listing and message parsing have been checked against this local JSONL and index format.

## Kimi Code, Desktop, and the older CLI

Newer Code versions use `~/.kimi-code` by default. The verified protocol version is wire 1.4:

```text
session_index.jsonl
sessions/<working-directory-bucket>/<id>/state.json
sessions/<working-directory-bucket>/<id>/agents/main/wire.jsonl
```

The reader extracts text from `context.append_message` and `context.append_loop_event`, joins streamed answers, and deduplicates user messages recorded in both prompt and context events. It does not extract request headers or model system prompts from `llm.request`. Reasoning, title-generation tasks, and subagents are excluded from main sessions.

The verified macOS Desktop data root is:

```text
~/Library/Application Support/kimi-desktop/
  daimon-share/daimon/runtime/kimi-code/home/
```

The adapter also tries the same application layout under common user data directories on other systems, derived from `--home`. Specify relocated data with `--source-root`. Actual Windows / Linux application directories may differ and may need an explicit root.

The older `~/.kimi` layout supports the working-directory index in `kimi.json`, `sessions/<working-directory-hash>/<id>/context.jsonl`, and older `<id>.jsonl` files. Messages use `role` / `content`; older formats without per-message times return null message timestamps. Arbitrary paths in the index cannot redirect conversation reads outside the source directory.

The modern format was checked against the [Kimi Code session documentation](https://github.com/MoonshotAI/kimi-code/blob/be7d5f5fea7800778e4660cd5f36780ba783bddd/docs/zh/guides/sessions.md), that commit's session-store / context-projector, and local Desktop records. Complete answers, tool activity, and interruption cases use synthetic tests; the local sample containing only user and tool messages does not establish full assistant-output validation.

## ZCode

The verified ZCode 0.16.3 / 0.16.5 session database contains:

- `session`: `id`, `directory`, `title`, `time_created`, `time_updated`, and optional `parent_id`.
- `message`: `id`, `session_id`, `data`, `sequence`, and `time_created`; `data` holds role and visibility.
- `part`: `message_id`, `session_id`, `data`, `sequence`, and `time_created`; `data` holds text or tool calls.

Messages are read in sequence and time order. Subagents with a nonempty `parent_id`, synthetic records, and internal messages with `transcriptVisibility: hidden` are skipped. Reasoning is hidden; `--tools` can show tool-call summaries. This shared storage format has been verified with local CLI and desktop records.

The reader does not reconstruct history from `model_io` request dumps in `cli/rollout`, avoiding request headers, repeated model inputs, and full system context in conversation output. `v2/tasks-index.sqlite` is a task index, not a source of conversation text.

## TRAE, TRAE SOLO, and TraeWork

The CLI supports `ItemTable` in legacy `state.vscdb` databases, matching only:

```text
memento/icube-ai-agent-storage[-user-id]
memento/icube-ai-ng-chat-storage-user-id
value.list[]: {sessionId,title,createdAt,updatedAt,messages}
message: {role,content,parsedQuery,timestamp,status}
```

Times are in milliseconds. `content` is a string; only string fragments in `parsedQuery` are included. Mention objects, attachments, and arbitrary caches are not treated as conversation text. Deleted messages and roles other than user / assistant are skipped. The project is recovered from `workspace.json` in the same directory.

Default roots try `Trae`, `Trae CN`, `TRAE SOLO`, and `TRAE SOLO CN` under macOS `~/Library/Application Support`, Windows `~/AppData/Roaming`, and Linux `~/.config`. `--source-root` is also supported. The legacy format was checked against the installed application's Memento read/write code and synthetic SQLite tests. The current local application has no real conversation text in that legacy format, so real-session recovery from those caches has not been verified.

Current SOLO / TraeWork `ModularData/ai-agent/database.db` storage is not a standard SQLite format supported by this adapter. When detected, the CLI explains the limitation. It does not attempt decryption, modify the database, or treat an empty list as proof that no conversations exist. A skill host with computer-use tools can follow the [TRAE UI workflow](trae-ui.md) to read existing conversations from the application's history list. This route has been verified with the current TraeWork CN application. A plain terminal without UI tools only supports the legacy caches.

The TRAE UI workflow and CLI are separate reading channels. The UI workflow does not add CLI database compatibility or assume an unverified Markdown export format.
