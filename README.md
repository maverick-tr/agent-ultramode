# ultra

[![npm](https://img.shields.io/npm/v/agent-ultramode?logo=npm&color=cb3837)](https://www.npmjs.com/package/agent-ultramode)
[![release](https://img.shields.io/github/v/release/maverick-tr/agent-ultramode?color=blue)](https://github.com/maverick-tr/agent-ultramode/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Took the [LLM-as-a-Verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) paper (Kwok et al., 2026) and turned it into a simple `/ultra` command for coding agents.

Instead of shipping the agent's first attempt, `ultra` runs your task **N times in isolated git worktrees**, in parallel, then uses the **same model** as a verifier to pick the best result. When it is confident (or when most attempts succeeded) it applies the winning diff to your working tree; when the attempts diverge and it is not sure, it hands you the top candidates. No cross-model dependency, no extra services, no first-attempt lottery.

And unlike most "add a verifier" posts, I benchmarked it before believing it. The receipts are below, good and bad.

## Demo

<video src="https://github.com/user-attachments/assets/134487dc-1d60-434b-a2dc-97cfd5942959" controls muted playsinline width="100%"></video>

[▶ Watch the demo](https://github.com/user-attachments/assets/134487dc-1d60-434b-a2dc-97cfd5942959) (55s, opencode + DeepSeek V4 Flash)

## The receipts

Benchmarked on **Terminal-Bench** with **DeepSeek V4 Flash 0731** as both the agent and the verifier, running inside **opencode** (N=5 attempts, same-model verifier). Verified end to end with **OpenCode**, **Claude Code**, and **cline** as the agent (the numbers above are the OpenCode run; a Claude Code number will be added once benchmarked). Works with any agent, not just opencode.

| Slice | base@1 (single shot) | ultra (best-of-N + verify) | oracle@5 (ceiling) |
|---|:---:|:---:|:---:|
| All 15 tasks | 24% | **33%** | 40% |
| 4 recoverable tasks | 40% | **75%** | rescued 3 of 4 |

Overall the verifier captured about **56% of the pass@1 to pass@5 headroom**. On the tasks with real variance, where best-of-N can actually help, it took the passing attempt on `chess-best-move`, `new-encrypt-command`, and `decommissioning-service` (missing only `jupyter-notebook-server`). A 40 to 75 jump on recoverable tasks is not a rounding error.

## How the competition works

```text
                          your task
                              |
      +----------+-----------+-----------+----------+        N attempts, in parallel,
      |          |           |           |          |        each in its own git worktree
  worktree1  worktree2   worktree3   worktree4     ...       + a lean sandbox (no MCP,
      |          |           |           |          |          no plugins, isolated state)
    agent      agent       agent       agent      agent
      |          |           |           |          |
    diff1      diff2       diff3       diff4      diffN
      +----------+-----------+-----------+----------+
                              |
                              v
        Probabilistic Pivot Tournament   (same model, acting as verifier)
          1. ring pass    each diff judged once vs a neighbour  -> seed pivots
          2. pivot duels  field vs the top pivots, K reasoned votes per duel
          3. score        normalised win-rate; confidence = top1 minus top2
                              |
                              v
                           decide
          confident, or most attempts changed something  ->  APPLY the winner
          diverged and not confident                     ->  show top candidates
```

1. **Fan out.** N detached git worktrees off `HEAD`; the agent runs the full task in each, in parallel, isolated so the attempts never collide.
2. **Run each attempt lean.** Every attempt is a full agent process, but stripped to essentials (no MCP servers, no other plugins, its own private state). That is what makes N real agents in parallel take seconds instead of minutes.
3. **Verify.** The tournament ranks the N diffs by same-model reasoned votes. Confidence is the win-rate margin between the top two.
4. **Decide.** Confident or a clear majority produced a change: apply the winner to your working tree (uncommitted, you review before committing). Otherwise: present the top candidates instead of guessing.

Progress streams live: phase titles in the web UI tool card, and toasts in the terminal.

## Install

```sh
opencode plugin agent-ultramode
```

That is the whole setup. With no options it drafts and verifies with your **current session model**, so `/ultra <task>` just works:

```text
/ultra fix the failing test in foo/bar
```

`ultra` branches attempts off `HEAD`, so run it inside a git repo with at least one commit.

**Pin a specific model (optional).** To draft and verify with a model other than the session one:

```jsonc
{ "plugin": [ ["agent-ultramode", { "model": "myprovider/my-model" }] ] }
```

**Run a different agent (Claude Code, cline, Grok, Pi, Codex, ...).** The `agent` option is the command run once per attempt, with `{task}` substituted and the cwd set to an isolated worktree. Point it at any CLI that edits files and exits:

```jsonc
["agent-ultramode", { "agent": "claude -p --dangerously-skip-permissions \"{task}\"" }]  // Claude Code (verified)
["agent-ultramode", { "agent": "pi \"{task}\"" }]                                        // pi
["agent-ultramode", { "agent": "grok build \"{task}\"" }]                                // grok
```

Adjust each agent's flags for headless, file-editing runs (for example Claude Code's permission mode). The best-of-N and verify loop stays the same, which makes ultra-mode easy to push onto any agent you use.

## Configure

Every option also reads from an `ULTRA_*` env var.

| Option | Default | Meaning |
|---|---|---|
| `model` | your current session model | `"provider/model-id"` used to run attempts and to verify |
| `agent` | run the current model | the command run once per attempt; `{task}` substituted, cwd is an isolated worktree |
| `n` | `4` | number of attempts (2 to 8) |
| `k` | `3` | reasoned votes per verifier duel |
| `conf` | `0.34` | confidence margin at or above which the winner is applied |
| `baseURL` / `apiKey` | from the provider | override the OpenAI-compatible endpoint / key for the verifier |
| `effort` | `"none"` | `reasoning_effort` for the verifier calls (kept low so judging stays fast) |
| `concurrency` | `6` | how many attempts run at once |
| `agentTimeout` | `600000` | per-attempt timeout in ms |

## Use without opencode (the CLI)

Same loop, no opencode host required. Install and run it in any git repo:

```sh
npm i -g agent-ultramode        # or: npx agent-ultramode "<task>"
```

```sh
agent-ultramode "fix the failing test in foo/bar"
```

By default each attempt runs `opencode run` (and it tells you clearly if opencode is not installed). Point `--agent` at anything else that edits files:

```sh
agent-ultramode -t "add rate limiting to /login" \
  --agent 'claude -p --dangerously-skip-permissions "{task}"' \
  --verify-model gpt-4o-mini
```

**Multiple models in one pass.** Pass `--agent` more than once to spread the attempts across different models, judged by one neutral verifier:

```sh
agent-ultramode -t "design and implement the data migration" \
  --agent 'claude -p --dangerously-skip-permissions "{task}"' \
  --agent 'opencode run --model grok "{task}"' \
  --agent 'opencode run --model deepseek-v4-flash "{task}"' \
  --n 6 --verify-model gpt-4o-mini
```

The 6 attempts round-robin across the three agents, and the verifier picks the best regardless of which model produced it. Good for one hard task where you want several strong models to take a shot.

The verifier needs an OpenAI-compatible endpoint: by default it reads `OPENAI_API_KEY` and `OPENAI_BASE_URL`, or pass `--api-key` / `--base-url` / `--verify-model`. Run `agent-ultramode --help` for all options.

## Why I built this, and the honest story

I wanted to know if best-of-N verification could squeeze real quality out of a small-but-capable model without reaching for a bigger, pricier one. So, ran it on real Terminal-Bench tasks and let the numbers decide. What I found:

- **Planning-first best-of-N does nothing for execution tasks.** Drafting N plans, picking the best, then executing once: **0 out of 5** outcomes changed on Terminal-Bench, at 3 to 10 times the cost. It amplifies effort, not capability. I dropped it.
- **Best-of-N over full trajectories plus a same-model verifier does work.** This is the version that ships.
- **A fancier verifier did not help.** A multi-criteria checklist tied the plain holistic judge and sometimes did worse. Same-model verification hits a ceiling that more prompting does not break.
- **Confidence is a real signal, but a noisy one.** Useful, not a magic gate.

It significantly helps on the tasks that matter, and I can point at the per-task data.

## The honest caveats (because benchmarks lie by omission)

1. **Confidence is a noisy signal at this scale.** The one miss (`jupyter`) had confidence 0.25, higher than two tasks it got right (0.17, 0.21). Some beyond-capability tasks even show high confidence while being pure failures. "Trust when confident" is directionally real, not a clean gate.
2. **It cannot help beyond-capability tasks.** 9 of the 15 never passed in 5 tries, and no verifier manufactures a solution that was never there.
3. **n=15 (4 with real variance) is a credible but modest sample.** Enough to headline honestly, not enough to over-claim precision.

## What this likely means at scale

The 15 tasks were deliberately failure-skewed, so the +9 points is not what you would see on the whole benchmark. On the full set the model already passes about 83%, so most tasks have no headroom. My honest estimate for a full run is a **modest +2 to +5 points on average**, because the dramatic gains only land on the minority of tasks the model *sometimes* solves. Average lift small, per-recoverable-task lift large. Same fact, two views.

## Roadmap

- [x] **Standalone CLI** (`npx agent-ultramode`) so the loop runs anywhere, with any agent, no opencode required.
- [x] **Multiple models in one pass** (repeatable `--agent`): spread attempts across different models, one neutral verifier picks the best.
- [x] **OpenCode, Claude Code, and cline** verified end to end.
- [ ] **First-class agent integrations** (tuned defaults and a benchmark number) for Grok, Pi, and Codex.
- [ ] Native slash-command or MCP packaging per agent. Contributions welcome.

## Credits

The verification method is the **Probabilistic Pivot Tournament** from **LLM-as-a-Verifier** (Kwok et al., 2026), reimplemented from the paper. The authors maintain the **official implementation, [TurboAgent](https://github.com/llm-as-a-verifier/TurboAgent)** (a proxy for Claude Code and opencode); for clean, paper-faithful benchmark numbers, that is the tighter match. I built this before I knew other implementations existed, wanting a same-model, agent-agnostic drop-in: a **reasoned** pairwise verifier (so it self-verifies with the same model, or any model, with no logprobs and no separate verifier model), plus a confidence-gated apply policy and isolated git worktrees, my adaptations on top of the PPT. The self-verification ceiling I ran into is documented in the cross-model and weak-verifier literature, worth reading before you assume same-model verification is a free lunch:

- Paper: [arXiv:2607.05391](https://arxiv.org/abs/2607.05391)
- Repo: [llm-as-a-verifier/llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier)
- Official implementation: [llm-as-a-verifier/TurboAgent](https://github.com/llm-as-a-verifier/TurboAgent)
- On the ceiling: [LLM-as-a-Jury (cross-model)](https://arxiv.org/html/2607.10139), [Weaver: weak verifiers](https://arxiv.org/html/2506.18203), [Generative Verifiers](https://arxiv.org/pdf/2408.15240)

```bibtex
@misc{kwok2026llmasaverifiergeneralpurposeverificationframework,
      title={LLM-as-a-Verifier: A General-Purpose Verification Framework},
      author={Jacky Kwok and Shulu Li and Pranav Atreya and Yuejiang Liu and
              Yixing Jiang and Chelsea Finn and Marco Pavone and Ion Stoica
              and Azalia Mirhoseini},
      year={2026},
      eprint={2607.05391},
      archivePrefix={arXiv},
      primaryClass={cs.AI},
      url={https://arxiv.org/abs/2607.05391}
}
```

Built for [opencode](https://opencode.ai). Zero heavy dependencies: opencode's bundled `@opencode-ai/plugin`, the global `fetch`, and an OpenAI-compatible endpoint.

## License and author

MIT, by [maverick-tr](https://github.com/maverick-tr). Built on the method from [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) (Kwok et al., 2026). See [LICENSE](./LICENSE).
