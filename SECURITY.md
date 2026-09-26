# Security Policy

**English** | [简体中文](SECURITY.zh-CN.md)

## Support scope

The project is in its initial development stage. Security fixes target `main` on a best-effort basis. There is no commitment to maintaining older versions or to a fixed response time.

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/wzz6423/read-chat-history/security/advisories/new) to report security issues. Do not disclose unresolved vulnerabilities or personal conversations in public issues, PRs, or discussions.

Where possible, include:

- The affected commit, Node.js version, and operating system.
- The source client, data format, and security impact.
- Reproduction commands and a minimal synthetic example without private data.
- Any known mitigations.

Remove real credentials and personal information. Revoke or rotate credentials that have already been exposed. If GitHub's private reporting form is unavailable, email [2705704576@qq.com](mailto:2705704576@qq.com) with the subject `read-chat-history Security Report`.

Maintainers will investigate within their available capacity and coordinate fixes and public disclosure with the reporter.

## Data boundaries

The read-chat-history CLI only reads local session files or queries session databases in read-only mode. It does not upload records or call remote AI APIs.

Output may contain prompts, answers, project paths, and tool calls. When you pass that output to another AI tool, its handling depends on that tool and your configuration. Read only records you are authorized to access, and remove sensitive information before sharing output.
