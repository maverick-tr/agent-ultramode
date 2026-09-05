#!/usr/bin/env node
// agent-ultramode: best-of-N for coding agents with a same-model verifier, as a CLI.
//
// Runs your task N times in isolated git worktrees, verifies the diffs with a
// Probabilistic Pivot Tournament (the same-model verifier from llm-as-a-verifier),
// and applies the winner. No opencode host required. Defaults the per-attempt
// agent to `opencode run`, but `--agent` takes any CLI that edits files.
//
// Node 18+ (uses global fetch and node:util parseArgs). Zero dependencies.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

const execFileP = promisify(execFile)
const int = (v, def, lo, hi) => { const n = parseInt(String(v ?? ""), 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def }
const err = (m) => process.stderr.write(m + "\n")

function printHelp() {
  err(`agent-ultramode - best-of-N for coding agents with a same-model verifier

USAGE
  agent-ultramode --task "<what to do>" [options]
  agent-ultramode "<what to do>" [options]

OPTIONS
  -t, --task <text>        the task to solve (or pass it as positional words)
  -a, --agent <cmd>        command run per attempt; "{task}" substituted, cwd is an isolated
                           worktree. Repeatable: pass several to spread attempts across
                           different models in one pass (round-robin). default: opencode run "{task}"
  -n, --n <int>            number of attempts, 2 to 8 (default 4)
      --k <int>            reasoned votes per verifier duel (default 3)
      --conf <float>       confidence margin to auto-apply (default 0.34)
  -m, --verify-model <id>  model id for the verifier (default $ULTRA_VERIFY_MODEL or gpt-4o-mini)
      --base-url <url>     verifier OpenAI-compatible endpoint (default $OPENAI_BASE_URL or OpenAI)
      --api-key <key>      verifier api key (default $OPENAI_API_KEY)
      --repo <path>        repo to run in (default: current directory)
      --concurrency <int>  attempts to run at once (default 6)
      --effort <level>     verifier reasoning_effort (default none)
      --test <cmd>         test command for the repair keep-check (else auto-detected:
                           npm test / pytest / cargo / go). Passing exit code = ok.
      --repair-agent <cmd> agent for the repair pass ("{task}" substituted; default: --agent)
      --repair-n <int>     repair attempts to run, 1 to 5 (default 2; env ULTRA_REPAIR_N).
                           Keeps the best that verifies; never worse than the winner.
      --no-repair          disable the verifier-guided repair pass (on by default)
      --no-early-exit      disable adaptive early-exit (on by default when a test
                           command is available)
  -h, --help               show this help

REPAIR (on by default; ULTRA_REPAIR=0 or --no-repair to disable)
  After the tournament picks a winner, ultra critiques it and runs --repair-n
  guided repair passes (default 2), each in its own worktree seeded with the
  winner's diff and the same critique, then keeps the best that verifies:
  with a test command, the first repair that PASSES the tests; otherwise the
  first repair the reasoned verifier clearly prefers over the winner. If none
  qualify, the winner is kept. So repair can lift the result past the best-of-N
  ceiling, and the applied result is never worse than the tournament winner.

ADAPTIVE EARLY-EXIT (on by default; --no-early-exit or ULTRA_NO_EARLY_EXIT=1 to disable)
  N is an upper bound. If an attempt PASSES the repo's tests (--test or an
  auto-detected npm/pytest/cargo/go command), ultra takes it as a verified
  winner, abandons the still-running attempts, and skips the tournament and
  repair. Only this hard signal stops early; low verifier confidence never does,
  so the result can never be worse than running all N.

EXAMPLES
  # default: opencode as the per-attempt agent, verify with your OpenAI key
  agent-ultramode "fix the failing test in foo/bar"

  # use Claude Code as the agent
  agent-ultramode -t "add rate limiting to /login" \\
    --agent 'claude -p --dangerously-skip-permissions "{task}"' \\
    --verify-model gpt-4o-mini

  # point the verifier at any OpenAI-compatible endpoint
  agent-ultramode "..." --base-url http://localhost:8000/v1 --api-key x --verify-model my-model
`)
}

async function git(cwd, ...args) {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

function pLimit(max) {
  let active = 0
  const q = []
  const next = () => { active--; q.shift()?.() }
  return async (fn) => {
    if (active >= max) await new Promise((r) => q.push(r))
    active++
    try { return await fn() } finally { next() }
  }
}

async function chat(C, content) {
  const body = { model: C.verifyModel, messages: [{ role: "user", content }], max_tokens: 12000, temperature: 0.9 }
  if (C.effort) body.reasoning_effort = C.effort
  const res = await fetch(`${C.baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${C.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`verifier HTTP ${res.status}`)
  const j = await res.json()
  const m = j?.choices?.[0]?.message ?? {}
  return `${m.content ?? ""}\n${m.reasoning_content ?? ""}`
}

async function judge(C, limit, task, a, b) {
  const prompt =
    `A coding task and two candidate solutions (agent log tail + the diff each produced). Decide which ` +
    `more likely FULLY and correctly accomplishes the task. Be skeptical: prefer concrete evidence of a ` +
    `correct, complete change with no errors; a diff that looks plausible but is incomplete or wrong should ` +
    `lose.\n\nTASK:\n${task}\n\n=== A ===\n${a}\n\n=== B ===\n${b}\n\n` +
    `Reason briefly, then end with exactly one line: 'FINAL: A' or 'FINAL: B'.`
  try {
    const out = (await limit(() => chat(C, prompt))).toUpperCase()
    const ms = out.match(/FINAL:\s*([AB])/g)
    return ms ? ms[ms.length - 1].slice(-1) : null
  } catch { return null }
}

async function tournament(C, task, summaries) {
  const n = summaries.length
  const ids = Array.from({ length: n }, (_, i) => i)
  if (n <= 1) return { ranked: ids, conf: 1 }
  const limit = pLimit(C.cc)
  const order = [...ids]
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
  const ring = Object.fromEntries(ids.map((i) => [i, 0]))
  await Promise.all(order.map(async (id, i) => {
    const b = order[(i + 1) % n]
    const v = await judge(C, limit, task, summaries[id], summaries[b])
    ring[v === "B" ? b : id]++
  }))
  const pivots = [...ids].sort((x, y) => ring[y] - ring[x]).slice(0, Math.min(2, n))
  const nonp = ids.filter((i) => !pivots.includes(i))
  const pairs = []
  for (const np of nonp) for (const pv of pivots) pairs.push([np, pv])
  for (let i = 0; i < pivots.length; i++) for (let j = i + 1; j < pivots.length; j++) pairs.push([pivots[i], pivots[j]])
  const mass = Object.fromEntries(ids.map((i) => [i, 0]))
  const games = Object.fromEntries(ids.map((i) => [i, 0]))
  await Promise.all(pairs.map(async ([x, y]) => {
    const votes = await Promise.all(Array.from({ length: C.k }, () => judge(C, limit, task, summaries[x], summaries[y])))
    const na = votes.filter((v) => v === "A").length
    const nb = votes.filter((v) => v === "B").length
    const px = na + nb === 0 ? 0.5 : na / (na + nb)
    mass[x] += px; mass[y] += 1 - px; games[x]++; games[y]++
  }))
  const ratio = (i) => (games[i] ? mass[i] / games[i] : ring[i] / Math.max(1, n - 1))
  const ranked = [...ids].sort((a, b) => ratio(b) - ratio(a))
  return { ranked, conf: ratio(ranked[0]) - ratio(ranked[1]) }
}

// --- verifier-guided repair (generic: never benchmark-specific) ------------
// After the tournament picks a winner, critique it and run one guided repair
// pass, then KEEP the repair only when it verifies as better (repo's own tests
// if available, else the reasoned verifier). So repair can only help, not hurt.

async function critique(C, task, diff, log) {
  const prompt =
    `A coding task and the patch a verifier selected as the best of several attempts. You are a strict ` +
    `reviewer. In 3-5 sentences name the MOST LIKELY remaining problems: missed edge cases, incomplete ` +
    `coverage, wrong root cause, or regressions it could introduce. If it looks fully correct, say so and ` +
    `name the single thing most worth double-checking. Be concrete and actionable.\n\n` +
    `TASK:\n${task}\n\nPATCH:\n${diff.slice(0, 6000)}\n\nAGENT LOG (tail):\n${(log || "").slice(-1200)}\n\nReview:`
  try { return (await chat(C, prompt)).trim().slice(0, 1500) } catch { return "" }
}

const XDG_ENV = (d) => ({
  ...process.env, XDG_DATA_HOME: d, XDG_STATE_HOME: d, XDG_CACHE_HOME: d,
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
})

// run an agent command inside a fresh worktree (optionally pre-seeded with a
// base diff), return the full diff off `base` + the log tail.
async function agentInWorktree(repo, base, work, tag, agentCmd, taskText, seedDiff, timeout) {
  const wt = join(work, tag)
  await git(repo, "worktree", "add", "--detach", wt, base)
  if (seedDiff && seedDiff.trim()) {
    const p = join(work, `${tag}.seed.patch`); await writeFile(p, seedDiff)
    await git(wt, "apply", "--3way", p).catch(() => {})
  }
  const cmd = agentCmd.replace("{task}", taskText.replace(/"/g, '\\"'))
  const d = join(work, `${tag}-xdg`); await mkdir(d, { recursive: true }).catch(() => {})
  let log = ""
  try {
    const { stdout, stderr } = await execFileP("bash", ["-lc", `exec </dev/null; ${cmd}`], { cwd: wt, env: XDG_ENV(d), timeout, maxBuffer: 32 * 1024 * 1024 })
    log = (stdout || "") + (stderr || "")
  } catch (e) { log = `agent error: ${e?.message || e}` }
  await git(wt, "add", "-A").catch(() => {})
  const diff = await git(wt, "diff", "--cached").catch(() => "")
  await git(repo, "worktree", "remove", "--force", wt).catch(() => {})
  return { diff, log }
}

// true iff `testCmd` exits 0 in a fresh worktree with `diff` applied.
async function runTests(repo, base, work, tag, diff, testCmd, timeout) {
  const wt = join(work, `t-${tag}`)
  await git(repo, "worktree", "add", "--detach", wt, base)
  try {
    if (diff.trim()) { const p = join(work, `t-${tag}.patch`); await writeFile(p, diff); await git(wt, "apply", "--3way", p).catch(() => {}) }
    await execFileP("bash", ["-lc", `exec </dev/null; ${testCmd}`], { cwd: wt, env: process.env, timeout, maxBuffer: 32 * 1024 * 1024 })
    return true
  } catch { return false }
  finally { await git(repo, "worktree", "remove", "--force", wt).catch(() => {}) }
}

// auto-detect a repo test command if the user didn't pass --test.
async function detectTestCmd(repo) {
  const has = async (f) => !!(await readFile(join(repo, f), "utf8").catch(() => ""))
  const pkg = await readFile(join(repo, "package.json"), "utf8").catch(() => "")
  if (pkg && /"test"\s*:/.test(pkg) && !/no test specified/.test(pkg)) return "npm test --silent"
  if (await has("pytest.ini") || await has("pyproject.toml") || await has("setup.cfg") || await has("tox.ini")) return "python -m pytest -q"
  if (await has("Cargo.toml")) return "cargo test -q"
  if (await has("go.mod")) return "go test ./..."
  return ""
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      task: { type: "string", short: "t" },
      agent: { type: "string", short: "a", multiple: true },
      n: { type: "string", short: "n" },
      k: { type: "string" },
      conf: { type: "string" },
      "verify-model": { type: "string", short: "m" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      repo: { type: "string" },
      concurrency: { type: "string" },
      effort: { type: "string" },
      "no-repair": { type: "boolean" },
      "no-early-exit": { type: "boolean" },
      "repair-agent": { type: "string" },
      "repair-n": { type: "string" },
      test: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) { printHelp(); process.exit(0) }
  const task = (values.task || positionals.join(" ")).trim()
  if (!task) { printHelp(); err("\nagent-ultramode: pass a --task (or task words) to run."); process.exit(1) }

  const agents = values.agent && values.agent.length ? values.agent : ['opencode run "{task}"']
  const n = int(values.n, 4, 2, 8)
  const k = int(values.k, 3, 1, 7)
  const conf = Number(values.conf ?? 0.34)
  const cc = int(values.concurrency, 6, 1, 12)
  const agentTimeout = 600000
  const doRepair = !values["no-repair"] && process.env.ULTRA_REPAIR !== "0"
  const repairN = int(values["repair-n"] ?? process.env.ULTRA_REPAIR_N, 2, 1, 5)
  const earlyExit = !values["no-early-exit"] && process.env.ULTRA_NO_EARLY_EXIT !== "1"
  const repairAgent = values["repair-agent"] || (agents[0] || 'opencode run "{task}"')
  let testCmd = values.test ?? process.env.ULTRA_TEST ?? ""
  const C = {
    verifyModel: values["verify-model"] || process.env.ULTRA_VERIFY_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    baseURL: values["base-url"] || process.env.OPENAI_BASE_URL || process.env.ULTRA_BASE_URL || "https://api.openai.com/v1",
    apiKey: values["api-key"] || process.env.OPENAI_API_KEY || process.env.ULTRA_API_KEY || "",
    effort: values.effort ?? process.env.ULTRA_EFFORT ?? "none",
    k, cc,
  }

  // Friendly check: an opencode agent must exist on PATH.
  const binOf = (a) => a.trim().split(/\s+/)[0]
  for (const b of [...new Set(agents.map(binOf))]) {
    if (b !== "opencode") continue
    try { await execFileP(b, ["--version"], { timeout: 10000 }) }
    catch {
      err(`\nagent-ultramode: '${b}' is not installed or not on your PATH.\n` +
        `Install it, or pass --agent to use a different agent, for example:\n` +
        `  --agent 'claude -p --dangerously-skip-permissions "{task}"'\n`)
      process.exit(1)
    }
  }
  if (!C.apiKey) {
    err(`\nagent-ultramode: no verifier api key. The verifier needs an OpenAI-compatible model to judge attempts.\n` +
      `Set OPENAI_API_KEY (and OPENAI_BASE_URL / --verify-model for a non-OpenAI endpoint), or pass --api-key.\n`)
    process.exit(1)
  }

  const repoArg = values.repo || process.cwd()
  let repo
  try { repo = (await git(repoArg, "rev-parse", "--show-toplevel")).trim() } catch { err(`\nagent-ultramode: '${repoArg}' is not inside a git repo.`); process.exit(1) }
  let base
  try { base = (await git(repo, "rev-parse", "HEAD")).trim() } catch { err(`\nagent-ultramode: the repo has no commits yet (need a HEAD to branch attempts from).`); process.exit(1) }

  const work = await mkdtemp(join(tmpdir(), "ultramode-"))
  const worktrees = []
  try {
    const label = agents.length > 1 ? `${agents.length} agents (round-robin)` : `'${binOf(agents[0])}'`
    err(`>>> fan-out: ${n} attempts off ${base.slice(0, 8)} with ${label} ...`)
    for (let i = 0; i < n; i++) {
      const wt = join(work, `attempt-${i}`)
      await git(repo, "worktree", "add", "--detach", wt, base)
      worktrees.push(wt)
    }
    const limit = pLimit(Math.max(1, Math.min(cc, n)))
    const esc = task.replace(/"/g, '\\"')

    // Adaptive early-exit (#141): N is an upper bound. If a completed attempt
    // PASSES the repo's tests (a hard, non-regressible signal), take it as the
    // verified winner, abandon the still-running/queued attempts, and skip the
    // tournament + repair. Low verifier confidence never stops early, so the
    // result can never be worse than running all N.
    if (earlyExit && testCmd === "") testCmd = await detectTestCmd(repo)
    const exitTestCmd = earlyExit ? testCmd : ""
    if (exitTestCmd) err(`>>> early-exit armed: stop as soon as an attempt passes '${exitTestCmd}'`)
    const ac = new AbortController()
    let verified = null
    const outs = new Array(n)

    const runAgent = (wt, i) => new Promise((resolve) => {
      const cmd = agents[i % agents.length].replace("{task}", esc)
      const d = join(work, `xdg-${i}`)
      mkdir(d, { recursive: true }).catch(() => {}).finally(() => {
        const env = {
          ...process.env,
          XDG_DATA_HOME: d, XDG_STATE_HOME: d, XDG_CACHE_HOME: d,
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
        }
        const child = execFile("bash", ["-lc", `exec </dev/null; ${cmd}`],
          { cwd: wt, env, timeout: agentTimeout, maxBuffer: 32 * 1024 * 1024, detached: true },
          (e, stdout, stderr) => resolve(((stdout || "") + (stderr || "")) || (e ? `agent error: ${e?.message || e}` : "")))
        // if a verified winner is found elsewhere, kill this attempt's process group
        ac.signal.addEventListener("abort", () => { try { process.kill(-child.pid, "SIGTERM") } catch {} }, { once: true })
      })
    })

    await Promise.all(worktrees.map((wt, i) => limit(async () => {
      if (ac.signal.aborted) return            // verified winner already found; don't start queued attempts
      const log = await runAgent(wt, i)
      await git(wt, "add", "-A").catch(() => {})
      const diff = await git(wt, "diff", "--cached").catch(() => "")
      outs[i] = { diff, log, summary: `AGENT LOG (tail):\n${log.slice(-1500)}\n\nDIFF:\n${diff.slice(0, 6000) || "(no changes)"}` }
      err(`    attempt ${i} [${binOf(agents[i % agents.length])}]: ${diff ? diff.length + " diff chars" : "no changes"}`)
      if (exitTestCmd && !verified && diff.trim()) {
        const pass = await runTests(repo, base, work, `ee-${i}`, diff, exitTestCmd, agentTimeout)
        if (pass && !verified) { verified = { i, ...outs[i] }; err(`    ✔ attempt ${i} PASSED tests; abandoning the rest`); ac.abort() }
      }
    })))

    // verified fast path: a test-passing attempt is correct by the repo's own
    // criterion, so apply it directly (no tournament, no repair, no regression).
    if (verified && verified.diff.trim()) {
      const patch = join(work, "winner.patch")
      await writeFile(patch, verified.diff)
      try {
        await git(repo, "apply", "--3way", patch)
        console.log(`\n🏆 attempt ${verified.i} passed the repo's tests (${exitTestCmd}); applied it and abandoned the rest. Review, then commit.`)
      } catch (e) {
        console.log(`\nattempt ${verified.i} passed tests but the patch did not apply cleanly (${e?.message || e}). The diff:\n\n${verified.diff.slice(0, 8000)}`)
      }
      return
    }

    const diffs = outs.map((o) => o.diff)
    const summaries = outs.map((o) => o.summary)
    if (diffs.every((d) => !d.trim())) {
      console.log("agent-ultramode: none of the attempts made any changes. Try a more specific task, or check that your agent can edit files headlessly.")
      return
    }

    err(`>>> verify: probabilistic pivot tournament (${C.verifyModel}) ...`)
    const { ranked, conf: margin } = await tournament(C, task, summaries)
    const best = ranked[0]

    // --- repair: critique the winner, run repairN guided passes, keep the best that verifies.
    // Best-of-N repair (regression-safe): fan out repairN attempts off `base`, each seeded with
    // the winner's diff and the SAME critique injected (one critique, reused). Keep-policy:
    //   * with tests: keep the FIRST repair that PASSES the repo's tests; else keep the winner.
    //     (a passing repair is correct by the repo's own criterion, so it cannot regress.)
    //   * without tests: keep the FIRST repair the reasoned verifier CLEARLY prefers over the
    //     current winner (same >k/2 threshold as before); else keep the winner.
    // INVARIANT: the final applied result is never worse than the tournament winner.
    if (doRepair && diffs[best].trim()) {
      err(`>>> repair: critique + ${repairN} guided pass(es) on the winner (keep the best that verifies) ...`)
      const crit = await critique(C, task, diffs[best], outs[best].log)
      const rtask =
        `${task}\n\n--- A previous attempt (already applied to your working tree) produced a partial ` +
        `solution. A reviewer flagged the issues below. Improve and COMPLETE it, keeping what is correct; ` +
        `verify before finishing. ---\nREVIEWER NOTES:\n${crit}`
      if (testCmd === "") testCmd = await detectTestCmd(repo)
      // run the repairN attempts in parallel, honoring the concurrency limiter (cc).
      const rlimit = pLimit(C.cc)
      const reps = await Promise.all(Array.from({ length: repairN }, (_, r) => rlimit(async () => {
        const rr = await agentInWorktree(repo, base, work, `repair-${r}`, repairAgent, rtask, diffs[best], agentTimeout)
        const rsum = `AGENT LOG (tail):\n${rr.log.slice(-1500)}\n\nDIFF:\n${rr.diff.slice(0, 6000) || "(no changes)"}`
        err(`    repair ${r} [${binOf(repairAgent)}]: ${rr.diff ? rr.diff.length + " diff chars" : "no changes"}`)
        return { diff: rr.diff, summary: rsum }
      })))
      // only real, changed candidates are eligible.
      const cands = reps.filter((x) => x.diff.trim() && x.diff !== diffs[best])
      let kept = false, why = ""
      if (!cands.length) { err(`    repair produced no new change; winner kept`) }
      else if (testCmd) {
        // regression-safe: keep the FIRST repair that PASSES the repo's own tests.
        err(`    keep-check: running tests (${testCmd}) on ${cands.length} repair candidate(s) ...`)
        for (let r = 0; r < cands.length; r++) {
          const pass = await runTests(repo, base, work, `rep-${r}`, cands[r].diff, testCmd, agentTimeout)
          if (pass) { diffs[best] = cands[r].diff; summaries[best] = cands[r].summary; kept = true; why = `repair ${r} passes the tests`; break }
        }
        if (!kept) why = "no repair passed the tests"
      } else {
        // no tests: keep the FIRST repair the verifier CLEARLY prefers over the current winner.
        const preferRepair = async (rsum) => {   // reasoned verifier: keep repair only if it clearly wins
          const limit = pLimit(C.cc)
          const votes = await Promise.all(Array.from({ length: C.k }, () => judge(C, limit, task, summaries[best], rsum)))
          return votes.filter((v) => v === "B").length > C.k / 2   // B = repaired
        }
        for (let r = 0; r < cands.length; r++) {
          if (await preferRepair(cands[r].summary)) { diffs[best] = cands[r].diff; summaries[best] = cands[r].summary; kept = true; why = `verifier prefers repair ${r}`; break }
        }
        if (!kept) why = "verifier keeps winner"
      }
      if (kept) err(`    ✔ repair KEPT (${why})`)
      else if (cands.length) err(`    all repairs discarded (${why})`)
    }

    const nonEmpty = diffs.filter((d) => d.trim()).length
    const majority = nonEmpty >= Math.max(2, Math.ceil(n / 2))

    if ((margin >= conf || majority) && diffs[best].trim()) {
      const patch = join(work, "winner.patch")
      await writeFile(patch, diffs[best])
      const why = margin >= conf ? `confidence ${margin.toFixed(2)}` : `top pick of ${nonEmpty}/${n}, margin ${margin.toFixed(2)}`
      try {
        await git(repo, "apply", "--3way", patch)
        console.log(`\n🏆 applied the best of ${n} attempts (${why}). The change is in your working tree; review it, then commit.`)
      } catch (e) {
        console.log(`\nverified the best attempt (${why}) but the patch did not apply cleanly (${e?.message || e}). The diff:\n\n${diffs[best].slice(0, 8000)}`)
      }
    } else {
      console.log(`\nattempts diverged and the verifier was not confident (margin ${margin.toFixed(2)}); applied nothing. Top candidates:\n`)
      ranked.slice(0, 3).forEach((idx, r) => {
        console.log(`# ${r + 1}  attempt ${idx}  (${diffs[idx].length} chars)\n${diffs[idx].slice(0, 4000) || "(no changes)"}\n`)
      })
    }
  } finally {
    for (const wt of worktrees) await git(repo, "worktree", "remove", "--force", wt).catch(() => {})
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((e) => { err(`agent-ultramode: ${e?.message || e}`); process.exit(1) })
