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
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
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
  -h, --help               show this help

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
    const outs = await Promise.all(worktrees.map((wt, i) => limit(async () => {
      const cmd = agents[i % agents.length].replace("{task}", esc)
      const d = join(work, `xdg-${i}`)
      await mkdir(d, { recursive: true }).catch(() => {})
      const env = {
        ...process.env,
        XDG_DATA_HOME: d, XDG_STATE_HOME: d, XDG_CACHE_HOME: d,
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      }
      let log = ""
      try {
        const { stdout, stderr } = await execFileP("bash", ["-lc", `exec </dev/null; ${cmd}`], { cwd: wt, env, timeout: agentTimeout, maxBuffer: 32 * 1024 * 1024 })
        log = (stdout || "") + (stderr || "")
      } catch (e) { log = `agent error: ${e?.message || e}` }
      await git(wt, "add", "-A").catch(() => {})
      const diff = await git(wt, "diff", "--cached").catch(() => "")
      err(`    attempt ${i} [${binOf(agents[i % agents.length])}]: ${diff ? diff.length + " diff chars" : "no changes"}`)
      return { diff, summary: `AGENT LOG (tail):\n${log.slice(-1500)}\n\nDIFF:\n${diff.slice(0, 6000) || "(no changes)"}` }
    })))

    const diffs = outs.map((o) => o.diff)
    const summaries = outs.map((o) => o.summary)
    if (diffs.every((d) => !d.trim())) {
      console.log("agent-ultramode: none of the attempts made any changes. Try a more specific task, or check that your agent can edit files headlessly.")
      return
    }

    err(`>>> verify: probabilistic pivot tournament (${C.verifyModel}) ...`)
    const { ranked, conf: margin } = await tournament(C, task, summaries)
    const best = ranked[0]
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
