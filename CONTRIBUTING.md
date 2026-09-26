# Contributing

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

Contributions to read-chat-history can include bug reports, documentation improvements, and code. Read the [code of conduct](CODE_OF_CONDUCT.md) before participating. Contributions are distributed under this repository's [PolyForm Noncommercial License 1.0.0](LICENSE.md).

## Reporting issues

Search [existing issues](https://github.com/wzz6423/read-chat-history/issues) before using the repository's issue forms.

- For bugs, include your operating system, Node.js version, source client and version, command, expected behavior, and actual behavior.
- For a new source or format, describe its local storage location and structure, and provide a minimal synthetic example. If a structure cannot be shared publicly, start by describing its fields.
- Do not submit real conversations, tokens, account details, personal paths, or database copies. Construct reproduction data by hand or redact it thoroughly.
- Report security issues privately as described in the [security policy](SECURITY.md).

## Local development

Use **Node.js 22.13.0 or newer**. The scripts use built-in Node.js modules and require no npm runtime dependencies.

```bash
git clone https://github.com/wzz6423/read-chat-history.git
cd read-chat-history
node scripts/chat_history.js --help
npm run check
npm test
```

`npm test` uses Node.js's built-in test runner. Tests must use synthetic data in temporary directories and isolate sources with `--home` or `--source-root` so they do not read a developer's real conversations.

Read the relevant parsers and existing tests before changing them, and reuse existing format-handling code. New sources should cover normal records, missing or corrupt records, source isolation, and reading limits. Update [SKILL.md](SKILL.md) and the [source reference](references/providers.md) as well. Keep changes focused and avoid unrelated refactoring.

Maintain both documentation versions together: the unsuffixed `.md` file is English, and `.zh-CN.md` is Simplified Chinese. Keep their language links, examples, support limits, and validation claims consistent. The English [LICENSE.md](LICENSE.md) is the authoritative license; its [Chinese guide](LICENSE.zh-CN.md) is explanatory.

Before committing, run the relevant checks and remove generated databases, logs, binaries, build output, and temporary files. Real conversations and credentials must not enter Git history.

## Branches and commits

Create branches from the latest `main`, with one clear goal per PR. Use `type/short-description`, such as `fix/kimi-message-order` or `docs/source-paths`. Automation also accepts `codex/` and `dependabot/` prefixes.

Write commit messages and PR titles in English and follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(grok): support local session history
fix(codex): preserve message order
docs: clarify local data access
```

Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `build`, `ci`, and `revert`.

## Pull requests

Target `main` and complete the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Write the body in English and retain these section headings:

| Heading | Required content |
| --- | --- |
| `Summary` | The original problem, resulting behavior, and scope. |
| `Validation` | Each group needs `- Status: passed`, `failed`, or `not run`. The first two also require `- Command:` and `- Result:`; an unrun check requires `- Reason:`. |
| `Risk and Rollback` | Fill in `- Risk:` and `- Rollback:` with the main risks and how to revert the change. |
| `Related Issue` | Link an issue with a reference such as `Closes #123`, or write `None`. |

If AI assisted with a contribution, you may record the tool and its role under `AI Attribution`. Any `Co-authored-by` attribution must be accurate. Contributors remain responsible for understanding the changes and verifying the results.

`Validation` may contain several groups. Keep the headings, field names, and status values shown in the template. Do not report unverified compatibility as passing.

Automation derives type labels from the title, assigns the PR to `wzz6423`, and adds it to [read-chat-history Development (Project #3)](https://github.com/users/wzz6423/projects/3). Closed PRs move to `Done`; reopened PRs return to the status for their type. You do not need to repeat Project or type configuration in the body.

Check GitHub Actions after submitting and fix failures related to your change. Tests only establish the formats they cover. Clearly state which new client versions and real environments you verified.

## Maintainers: Project automation

Add `PROJECT_AUTOMATION_TOKEN` under **Settings → Secrets and variables → Actions**. The token needs read/write access to the target user Project and read access to this repository's issues and PRs. Limit its permissions to what is needed. A classic PAT can use the `project` and `public_repo` scopes. The workflow's `GITHUB_TOKEN` cannot directly write to a personal Project.

The Project owner, number, title, `Status` field, and status mappings are configured in [.github/project-automation.json](.github/project-automation.json). Missing credentials or mismatched configuration cause the workflow to fail explicitly.

Under **Actions → Project Automation → Run workflow**, leave `number` blank to validate Project #3 and its status configuration without changing items. Select `item_type` and enter an existing issue or PR number to synchronize that item again. A successful read-only configuration check does not establish that item synchronization occurred; verify the item and its status separately.
