---
name: ultra
description: Best-of-N with a reasoned verifier and guided repair. Invoke with /ultra <task> to run N isolated attempts in parallel, pick the strongest with a skeptical verifier, then run one guided repair pass kept only if it is better. Use for hard problems where a single attempt is not enough.
argument-hint: <describe your task or challenge...>
allowed-tools: [spawn_subagent, get_command_or_subagent_output, Agent, Task, TodoWrite, Read, Write, Edit, Bash, Glob, Grep]
---

# /ultra: best-of-N, reasoned verify, guided repair

Run the **ultra** method on the user's task. Do NOT solve it yourself in the main thread. Your job is to orchestrate: run several isolated attempts, verify them, improve the winner, and deliver it. Everything you spawn shows live (in Grok, the Tasks pane on Ctrl+G; in Claude Code, inline subagent progress), so the user watches best-of-N happen.

**The task:**
$ARGUMENTS

## 0. Pick your subagent tool
Fan out and repair with whichever subagent tool your platform gives you:
- **Grok Build:** `spawn_subagent` with `background: true`, `isolation: worktree`, `capability_mode: all`; collect results with `get_command_or_subagent_output`; for repair, spawn with `resume_from` set to the winner's subagent ID.
- **Claude Code (and compatible agents):** the `Agent` tool (formerly `Task`) with `subagent_type: "general-purpose"`; launch all attempts in ONE message so they run in parallel; tell each attempt to work in its own `mktemp -d` so they never collide; for repair, launch a fresh `Agent` call whose prompt carries the winner's full solution plus your critique.

Use only the one you actually have. The rest of these steps are the same either way.

## 1. Set the stage
- Use `N = 3` independent attempts (unless the task clearly warrants more or fewer).
- In one line, tell the user what you are about to do: run N isolated attempts in parallel, pick the best with a skeptical reasoned verifier, then run one guided repair pass kept only if it is better.
- Track the phases with a TODO list (fan out, verify, repair, deliver) so progress is visible.

## 2. Fan out N attempts, in parallel
Start all `N` attempts in a SINGLE message, before collecting any result, so they genuinely run concurrently rather than one after another. On Claude Code that means calling the `Agent` tool (formerly `Task`, still accepted as an alias) `N` times in one message, each with `subagent_type: "general-purpose"`. On Grok, spawn all `N` with `spawn_subagent` and `background: true`. Give each the attempt prompt below, with the task substituted, and a description like `"ultra attempt <i>"`.

Attempt prompt (use for every attempt):

> Solve this task completely and correctly. Produce a full, working solution, not a sketch or a plan. If it is code, make it actually compile and run, and verify it yourself before finishing (write and run a quick test, or run the example). If you write and run code, do it in your OWN isolated area (a fresh worktree, or a directory you make with `mktemp -d`) so you never collide with the other attempts, and do not write into the user's project. When done, report in your final message: (a) the complete final solution, (b) exactly what you verified and the observed result, (c) any remaining risk you are unsure about.
>
> TASK: <the task above>

Record each attempt's id.

## 3. Collect the attempts
Once all `N` are running, retrieve each one's output and read its final solution and self-verification carefully.

## 4. Reasoned verify: pick the winner
You are the verifier. Reason skeptically about which attempt most likely FULLY and correctly solves the task:
- Prefer concrete evidence of a correct, complete, verified result.
- Penalize anything incomplete, unverified, or that only looks plausible.
- Compare pairwise in your reasoning, not by vibe.

State, briefly: your reasoning, the ONE winner, and a confidence of `low` / `medium` / `high` based on how clearly it beat the field.

## 5. Guided repair: improve the winner, never regress
- Critique the winner in 3 to 5 sentences: the most likely remaining problems (missed edge cases, incomplete coverage, wrong root cause, possible regressions). If it looks fully correct, name the single thing most worth double-checking.
- Run ONE repair attempt (on Grok, `resume_from` the winner so it inherits the winner's context and worktree; on Claude Code, a fresh `Agent` call carrying the winner's solution plus your critique). Ask for an improved, COMPLETE solution that keeps everything already correct, fixes the flagged issues, and is verified before finishing.
- Compare the repair to the winner with the same skeptical reasoning. **Keep the repair only if it is clearly better.** Otherwise keep the original winner. Repair can help, never hurt.

## 6. Deliver
- Present the final verified solution IN FULL and faithfully. Do not shrink, summarize away, or rewrite the working code. If the user wants it written into their project (or a Grok worktree applied back), do that now.
- End with exactly one summary line, for example:
  `ultra: 3 attempts, winner #2, confidence high, repair kept`

Begin with step 1.
