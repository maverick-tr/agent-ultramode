# ultra

[![npm](https://img.shields.io/npm/v/agent-ultramode?logo=npm&color=cb3837)](https://www.npmjs.com/package/agent-ultramode)
[![release](https://img.shields.io/github/v/release/maverick-tr/agent-ultramode?color=blue)](https://github.com/maverick-tr/agent-ultramode/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Took the [LLM-as-a-Verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) paper (Kwok et al., 2026) and turned it into a simple `/ultra` command for coding agents.

> ### New in v2: repair climbs past the best-of-N ceiling, putting a mid-range flash model in the frontier's coding tier
>
> Picking the best of N attempts can never beat **oracle@N**. If none of the attempts solved the task, selection cannot invent a fix. That ceiling is where every best-of-N method stops.
>
> v2 adds a **verifier-guided repair pass**: the verifier critiques the winner, a repair runs against that critique, and the result is kept **only if it verifies better** (your tests when they exist, the verifier otherwise). Because repair can synthesize a fix no attempt produced, it goes past the ceiling. On a 24-task SWE-bench Lite slice it reaches **91.7%, above the 87.5% oracle@5** of its own candidate pool.
>
> Plus **adaptive early-exit**: N is a budget, not a quota. The moment an attempt passes your tests, ultra takes it and abandons the rest.
>
> Stack that on the verify step and a small, non-vision flash model reaches **90.4%** on Terminal-Bench 2.1's coding subset, inside the band of GPT-5.6 Sol (89.5%), Claude Opus 5 (89.1%) and Grok 4.6 (88.4%), at a fraction of the per-token cost. Ours is best-of-5 against their pass@1, so read it as reaching the tier, not a like-for-like beat.
>
> [How it works](#repair-and-early-exit-v2)

Instead of shipping the agent's first attempt, `ultra` runs your task **N times in isolated git worktrees**, in parallel, then uses the **same model** as a verifier to pick the best result. When it is confident (or when most attempts succeeded) it applies the winning diff to your working tree; when the attempts diverge and it is not sure, it hands you the top candidates. No cross-model dependency, no extra services, no first-attempt lottery.

And unlike most "add a verifier" posts, I benchmarked it before believing it. The receipts are below, good and bad.

## Demo

<video src="https://github.com/user-attachments/assets/134487dc-1d60-434b-a2dc-97cfd5942959" controls muted playsinline width="100%"></video>

[▶ Watch the demo](https://github.com/user-attachments/assets/134487dc-1d60-434b-a2dc-97cfd5942959) (55s, opencode + DeepSeek V4 Flash)

## The receipts

Benchmarked with **a small open model (DeepSeek V4 Flash 0731)** as both the agent and the verifier, best-of-5. Every number below is from a real run, good and bad. Full method, per-experiment setup and the honest scope notes are in the technical report: **[PAPER.md](./PAPER.md)**.

![On Terminal-Bench 2.1, ultra ties the paper's verifier; on SWE-bench Lite, repair beats the oracle ceiling](viz/chart.png)

![Cost versus score on Terminal-Bench 2.1: a small non-vision flash model reaches 90.4% on the coding subset, inside the frontier's band, at a fraction of the per-token cost. Inset: verifier-guided repair reaches 91.7% on SWE-bench Lite, above the 87.5% oracle@5 ceiling.](viz/chart2.png)

### Terminal-Bench 2.1: reasoned verify ties the paper, with far fewer calls

| Stage | Terminal-Bench 2.1 (89 tasks) |
|---|:---:|
| base@1 (single shot) | 78.7% |
| **ultra (reasoned verify)** | **87.6%** (78/89) |
| oracle@5 (selection ceiling) | 96.6% |

The reasoned verifier **ties the LLM-as-a-Verifier paper's logprob PPT** (88.0% +/- 0.6%) while using **7.5x fewer verifier calls** (576 vs 4,320) and **no logprobs** at all. Same accuracy, a fraction of the verifier budget, and it runs on any OpenAI-compatible endpoint.

### The non-vision handicap (and the fair arena)

DeepSeek V4 Flash has **no vision**. Terminal-Bench 2.1 mixes image tasks in with the coding ones, so the blended score carries a penalty a text-only model can never pay down:

| Terminal-Bench 2.1 split | tasks | ultra |
|---|:---:|:---:|
| Vision tasks | 12 | 58% |
| **Coding tasks** | **77** | **90.4%** |
| Blended (headline) | 89 | 87.6% |

On the **coding subset**, the fair arena for a small, non-vision flash model, ultra reaches **90.4%**.

For context on the full 89-task set, as reported by Artificial Analysis (pass@1, avg of 3): GPT-5.6 Sol 89.5%, Claude Opus 5 89.1%, Grok 4.6 88.4%. Their coding-subset numbers are unpublished. So this is not a beat: ours is best-of-5 and theirs is pass@1. The honest framing is that a small, non-vision flash model reaches the **frontier's coding tier at a fraction of the cost**.

### SWE-bench Lite: repair climbs past the selection ceiling

Pure code repair, no vision, 24 django/pytest tasks, N=5:

| Stage | SWE-bench Lite (24 tasks) |
|---|:---:|
| base@1 (single shot) | 70.8% |
| ultra (reasoned verify) | 75.0% |
| oracle@5 (selection ceiling) | 87.5% |
| **ultra + repair** | **91.7%** (22/24) |

This is the clean "past the ceiling" result. Selection alone can never beat the best attempt it was handed (oracle@5 = 87.5%). Best-of-N **repair** rescued 2 tasks none of the five attempts solved, landing **above** the oracle ceiling at 91.7%.

### The trace-reading ceiling

The verifier is strong on code diffs and weak on **self-reported terminal outcomes**. It saturates on convincing-but-wrong self-reports: on `extract-elf`, a failing run reported "4102 entries, zero mismatches" when 698 was the correct answer, and the verifier believed it. Repair plus a real test overcomes this; a verifier reading a trace alone cannot. This is why SWE-bench (pure code diffs) is the clean signal and Terminal-Bench is muddied by both vision and self-report.

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

## Repair and early-exit (v2)

Two additions in v2, both designed so they can only help.

**Verifier-guided best-of-N repair (beyond the best-of-N ceiling).** Selection alone can never do better than the best attempt it was handed (its ceiling is oracle@N). After the tournament picks a winner, `ultra` critiques it and runs up to `--repair-n` guided repair passes (default 2), keeping the **first pass that passes your tests**; if none pass, it keeps the tournament winner unchanged. The keep-check uses your repo's own tests if there are any, otherwise the reasoned verifier. It is regression-safe and **never worse than the winner**: a repair is adopted only when it clears the bar, so repair can solve tasks no single attempt did while a bad repair is simply discarded. In a SWE-bench Lite run this reached 91.7%, above the 87.5% oracle@5 ceiling, by rescuing two tasks none of the five attempts solved.

**Adaptive early-exit (N as an upper bound).** N is a budget, not a quota. The moment an attempt's diff **passes your tests**, `ultra` takes it as the verified winner, abandons the still-running attempts, and skips the tournament and repair. Only this hard signal stops early; low verifier confidence never does, so you never trade quality for speed. With no detectable test command it runs all N, exactly as before. Turn repair off with `--no-repair` (or `ULTRA_REPAIR=0`); turn early-exit off with `--no-early-exit` (or `ULTRA_NO_EARLY_EXIT=1`).

## Install

Pick your agent. Each is one command, and each gives you the same native `/ultra <task>`.

**Claude Code**

```sh
mkdir -p ~/.claude/commands
curl -fsSL https://raw.githubusercontent.com/maverick-tr/agent-ultramode/main/install/ultra.md -o ~/.claude/commands/ultra.md
```

**Grok**

```sh
grok plugin install maverick-tr/agent-ultramode --trust
```

**opencode**

```sh
opencode plugin agent-ultramode
```

Then run it in any session:

```text
/ultra fix the failing test in foo/bar
```

`ultra` branches attempts off `HEAD`, so run it inside a git repo with at least one commit.

On **Claude Code** and **Grok**, attempts run as parallel subagents in the host itself (Grok shows them live in the Tasks pane, Ctrl+G). On **opencode** they run as isolated git worktrees and the winning diff is applied to your working tree. Same loop either way: fan out N, verify, repair the winner, keep it only if it is better.

### More install options

**Claude Code, as a full plugin** (instead of the single file above):

```sh
/plugin marketplace add maverick-tr/agent-ultramode
```

**opencode, pinning a specific model (optional).** To draft and verify with a model other than the session one:

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
| `repair` | `true` | run verifier-guided repair on the winner, kept only if it verifies better |
| `repairN` | `2` | repair passes to run (1 to 5); keeps the first that passes your tests, else the winner |
| `test` | auto-detected | test command for the repair keep-check and early-exit (npm / pytest / cargo / go if unset) |
| `earlyExit` | `true` | stop as soon as an attempt passes the test command, and apply it |

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

## How the hosts differ

One plugin serves all three, each using its host's own subagent primitive: Grok's `spawn_subagent` with worktree isolation, Claude Code's `Agent` tool, and opencode's own worktree runner. The best-of-N, verify and repair loop is identical; only the fan-out mechanism and the progress UI change. Both the Claude Code and Grok paths are verified end to end.

## DeepSeek Harness (experimental)

A native DeepSeek Harness `/ultra` plugin exists but is not recommended yet: the harness surfaces each attempt as a separate child session, which is noisy in the web UI. Use the Grok or Claude Code plugins above for a clean native `/ultra` today.

## Why I built this, and the honest story

I wanted to know if best-of-N verification could squeeze real quality out of a small-but-capable model without reaching for a bigger, pricier one. So, ran it on real Terminal-Bench tasks and let the numbers decide. What I found:

- **Planning-first best-of-N does nothing for execution tasks.** Drafting N plans, picking the best, then executing once: **0 out of 5** outcomes changed on Terminal-Bench, at 3 to 10 times the cost. It amplifies effort, not capability. I dropped it.
- **Best-of-N over full trajectories plus a same-model verifier does work.** This is the version that ships.
- **A fancier verifier did not help.** A multi-criteria checklist tied the plain holistic judge and sometimes did worse. Same-model verification hits a ceiling that more prompting does not break.
- **Confidence is a real signal, but a noisy one.** Useful, not a magic gate.

It significantly helps on the tasks that matter, and I can point at the per-task data.

## The honest caveats (because benchmarks lie by omission)

1. **The model has no vision, and image tasks are out of fair reach.** DeepSeek V4 Flash is text-only, so the 12 Terminal-Bench 2.1 vision tasks (58%) drag the blended score down in a way no amount of verifying can fix. The **coding subset (90.4%)** is the fair arena for a non-vision model; read the blended 87.6% with that in mind.
2. **The frontier comparison is not apples to apples.** Our headline numbers are **best-of-5**; the GPT-5.6 / Opus 5 / Grok 4.6 numbers are **pass@1**. So "reaches the frontier's coding tier" is a cost-and-capability framing, not a claim that this small model beats them head to head.
3. **The verifier hits a trace-reading ceiling.** It reasons well over code diffs but is fooled by convincing-but-wrong self-reports (the `extract-elf` run that claimed "4102 entries, zero mismatches" when 698 was correct). Selection over self-reported terminal outcomes saturates; only repair plus a real test breaks past it.
4. **SWE-bench is the clean signal; Terminal-Bench is muddied.** SWE-bench Lite is pure code repair with real tests, which is why repair cleanly beats the oracle@5 ceiling there (91.7% > 87.5%). Terminal-Bench mixes in vision and self-reported outcomes, so its blended number carries penalties that have nothing to do with the verifier.

## What this likely means at scale

On any full benchmark most tasks have no headroom: the model either always solves them or never does, and a verifier changes neither. The lift concentrates on the minority of tasks the model *sometimes* solves, where selection can grab the passing attempt and repair can climb one rung higher. So on Terminal-Bench 2.1 the base-to-verify jump is a real **+8.9 points blended** (78.7% to 87.6%), and on the coding subset it lands at **90.4%**, but the honest reading is that the dramatic per-task gains average out into a moderate headline lift, larger on repair-friendly pure-code sets like SWE-bench than on mixed sets diluted by vision. Average lift moderate, per-recoverable-task lift large. Same fact, two views.

## Roadmap

- [x] **Standalone CLI** (`npx agent-ultramode`) so the loop runs anywhere, with any agent, no opencode required.
- [x] **Multiple models in one pass** (repeatable `--agent`): spread attempts across different models, one neutral verifier picks the best.
- [x] **First-class integrations for opencode, Claude Code, and Grok**: a native `/ultra` command in each, all verified end to end. cline verified as an attempt runner.
- [x] **Verifier-guided best-of-N repair** (v2): up to `--repair-n` critique-guided passes on the winner, keeping the first that passes your tests. Beats the oracle@N ceiling on SWE-bench Lite (91.7% vs 87.5%).
- [x] **Adaptive early-exit** (v2): N becomes an upper bound; a test-passing attempt ends the run early with no quality trade-off.
- [ ] Native `/ultra` for more hosts (Pi, Codex) and MCP packaging. Contributions welcome.

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
