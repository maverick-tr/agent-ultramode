# Security Policy

## Supported versions

Only the latest published version of `agent-ultramode` is supported. Please upgrade before reporting.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue. Use GitHub's private vulnerability reporting (the "Report a vulnerability" button under the repository's Security tab), or send a direct message to @maverick-tr on GitHub.

Include what you found, how to reproduce it, and the impact you expect. You will get an acknowledgement as soon as the maintainer sees it. This is a small open-source project maintained on a best-effort basis, so there is no formal response-time SLA.

## Scope and trust model

ultra runs the agent command **you configure**, in isolated git worktrees, and sends candidate diffs and log tails to the verifier endpoint **you configure**. It then applies a diff to your working tree, which you review before committing. The agent command, the verifier endpoint, and the task input are trusted inputs that you control. Reports that ultra executes your own configured agent, or sends data to your own configured endpoint, are working as intended and are not vulnerabilities.

In scope: a way for a malicious task, repository, or agent output to make ultra run commands or leak data beyond what you configured, or to escape the worktree isolation.

The project is MIT licensed and provided as is, without warranty.
