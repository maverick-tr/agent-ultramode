# Contributing to ultra

Thanks for your interest in improving `agent-ultramode`. It is a small, focused tool: best-of-N for coding agents with a same-model reasoned verifier and verifier-guided repair. The aim is to keep it simple, honest, and zero-dependency.

## Ground rules

- **Keep it zero-dependency.** The CLI (`cli.mjs`) and the opencode plugin (`ultra.ts`) use only Node built-ins, the global `fetch`, and an OpenAI-compatible endpoint. Please do not add runtime dependencies.
- **Match the surrounding style.** Small, readable, no framework. Look at the file you are editing and follow its conventions.
- **Be honest about numbers.** If you add or change a benchmark claim, include how it was measured and the raw result. This project reports the good and the bad.

## Setup

Node 18 or newer. Clone the repo; there is nothing to install for the CLI.

```sh
git clone https://github.com/maverick-tr/agent-ultramode
cd agent-ultramode
node cli.mjs --help
```

## Running it

The CLI runs a task N times in isolated git worktrees, verifies, and applies the winner:

```sh
node cli.mjs "fix the failing test in foo/bar" \
  --agent 'your-agent "{task}"' \
  --verify-model your-model --base-url <endpoint> --api-key <key>
```

The opencode plugin is `ultra.ts`; load it via `opencode.json` as documented in the README.

## Testing your change

There is no test framework; test end to end. A quick smoke for the CLI: create a throwaway git repo, point `--agent` at a command that edits a file, pass a `--test` that passes when the edit is present, and confirm ultra applies the winner. For the verifier path, point `--base-url` at any OpenAI-compatible endpoint (a tiny mock that returns `FINAL: A` works). Please describe what you tested in the PR.

## Pull requests

- Open an issue first for anything larger than a small fix, so we can agree on the approach before you build it.
- Keep PRs small and focused: one change per PR.
- Update the README if you change behavior or add an option.
- Do not bump the version or publish; the maintainer handles releases.

## Scope

ultra is intentionally small. New verifier signals, agent integrations, and honest benchmarks are welcome. Large framework additions or heavy dependencies are probably out of scope; open an issue to discuss first.

By contributing, you agree that your contributions are licensed under the MIT License of this project.
