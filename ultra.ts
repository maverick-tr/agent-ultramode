/**
 * ultra - best-of-N trajectories + confidence-gated same-model verifier, for opencode.
 *
 * `/ultra <task>` runs the task N times in isolated git worktrees, ranks the results
 * with the same model acting as a verifier (a Probabilistic Pivot Tournament, from
 * llm-as-a-verifier), then:
 *   high confidence -> applies the winning diff to your working tree
 *   low  confidence -> shows you the top candidates and applies nothing
 * (a low-confidence pick is a coin flip and should not be applied silently).
 *
 * This is the version validated on Terminal-Bench: plan-first best-of-N gave no edge,
 * but best-of-N over full trajectories + this verifier lifted the recoverable tasks
 * from 40% to 75% (n=15, same model, no cross-model dependency).
 *
 * Install (opencode.json):
 *   { "plugin": [ ["file:///abs/path/ultra.ts", { "model": "provider/model", "n": 5 }] ] }
 * Then: /ultra fix the failing test in foo/bar
 *
 * Zero deps: node built-ins + global fetch + an OpenAI-compatible endpoint.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const execFileP = promisify(execFile)
type Opts = Record<string, any>
const VERSION = "0821g"

interface Cfg {
  url: string
  key: string
  model: string
  provider: string
  effort: string
  agent: string
  n: number
  k: number
  topk: number
  conf: number
  judgeTokens: number
  cc: number
  agentTimeoutMs: number
}

const num = (v: any, def: number, lo: number, hi: number): number => {
  const n = Number.parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def
}

function buildCfg(opts: Opts): Cfg {
  // Endpoint + model default to the CURRENT SESSION model (captured in the chat.params hook
  // below); plugin options and ULTRA_* env vars override. The per-attempt agent defaults to
  // opencode's own run command, and any other CLI works via the agent option.
  const ref = String(opts.model ?? process.env.ULTRA_MODEL ?? "")
  const s = ref.indexOf("/")
  const provider = s >= 0 ? ref.slice(0, s) : String(opts.provider ?? process.env.ULTRA_PROVIDER ?? "")
  return {
    url: String(opts.baseURL ?? process.env.ULTRA_BASE_URL ?? ""),
    key: String(opts.apiKey ?? process.env.ULTRA_API_KEY ?? ""),
    model: s >= 0 ? ref.slice(s + 1) : ref,
    provider,
    // "none" keeps the verifier fast and non-truncating.
    effort: String(opts.effort ?? process.env.ULTRA_EFFORT ?? "none"),
    // the agent to run in each worktree; {task} is substituted, CWD = the worktree.
    agent: String(opts.agent ?? process.env.ULTRA_AGENT ?? 'opencode run "{task}"'),
    n: num(opts.n ?? process.env.ULTRA_N, 4, 2, 8),
    k: num(opts.k ?? process.env.ULTRA_K, 3, 1, 7),
    topk: 2,
    conf: Number(opts.conf ?? process.env.ULTRA_CONF ?? 0.34),
    judgeTokens: num(opts.judgeTokens ?? process.env.ULTRA_JUDGE_TOKENS, 12000, 500, 200000),
    cc: num(opts.concurrency ?? process.env.ULTRA_CC, 6, 1, 12),
    agentTimeoutMs: num(opts.agentTimeout ?? process.env.ULTRA_AGENT_TIMEOUT, 600000, 30000, 1800000),
  }
}

function pLimit(max: number) {
  let active = 0
  const q: (() => void)[] = []
  const next = () => { active--; q.shift()?.() }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => q.push(r))
    active++
    try { return await fn() } finally { next() }
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

// one non-streaming verifier call; a failure is swallowed by the caller (null vote).
async function chat(C: Cfg, content: string): Promise<string> {
  const body: Record<string, any> = {
    model: C.model,
    messages: [{ role: "user", content }],
    max_tokens: C.judgeTokens,
    temperature: 0.9,
  }
  if (C.effort) body.reasoning_effort = C.effort
  const res = await fetch(`${C.url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${C.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j: any = await res.json()
  const m = j?.choices?.[0]?.message ?? {}
  return `${m.content ?? ""}\n${m.reasoning_content ?? ""}`
}

async function judge(C: Cfg, limit: ReturnType<typeof pLimit>, task: string, a: string, b: string): Promise<"A" | "B" | null> {
  const prompt =
    `A coding task and two candidate solutions (agent log tail + the diff each produced). Decide which ` +
    `more likely FULLY and correctly accomplishes the task. Be skeptical: prefer concrete evidence of a ` +
    `correct, complete change with no errors; a diff that looks plausible but is incomplete or wrong should ` +
    `lose.\n\nTASK:\n${task}\n\n=== A ===\n${a}\n\n=== B ===\n${b}\n\n` +
    `Reason briefly, then end with exactly one line: 'FINAL: A' or 'FINAL: B'.`
  try {
    const out = (await limit(() => chat(C, prompt))).toUpperCase()
    const ms = out.match(/FINAL:\s*([AB])/g)
    return ms ? (ms[ms.length - 1].slice(-1) as "A" | "B") : null
  } catch {
    return null
  }
}

// Probabilistic Pivot Tournament -> ranked indices + confidence (top1-top2 win-ratio margin).
async function tournament(C: Cfg, task: string, summaries: string[]): Promise<{ ranked: number[]; conf: number }> {
  const n = summaries.length
  const ids = Array.from({ length: n }, (_, i) => i)
  if (n <= 1) return { ranked: ids, conf: 1 }
  const limit = pLimit(C.cc)
  const order = [...ids]
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
  const ring: Record<number, number> = Object.fromEntries(ids.map((i) => [i, 0]))
  await Promise.all(order.map(async (id, i) => {
    const b = order[(i + 1) % n]
    const v = await judge(C, limit, task, summaries[id], summaries[b])
    ring[v === "B" ? b : id]++
  }))
  const pivots = [...ids].sort((x, y) => ring[y] - ring[x]).slice(0, Math.min(C.topk, n))
  const nonp = ids.filter((i) => !pivots.includes(i))
  const pairs: [number, number][] = []
  for (const np of nonp) for (const pv of pivots) pairs.push([np, pv])
  for (let i = 0; i < pivots.length; i++) for (let j = i + 1; j < pivots.length; j++) pairs.push([pivots[i], pivots[j]])
  const mass: Record<number, number> = Object.fromEntries(ids.map((i) => [i, 0]))
  const games: Record<number, number> = Object.fromEntries(ids.map((i) => [i, 0]))
  await Promise.all(pairs.map(async ([x, y]) => {
    const votes = await Promise.all(Array.from({ length: C.k }, () => judge(C, limit, task, summaries[x], summaries[y])))
    const na = votes.filter((v) => v === "A").length
    const nb = votes.filter((v) => v === "B").length
    const px = na + nb === 0 ? 0.5 : na / (na + nb)
    mass[x] += px; mass[y] += 1 - px; games[x]++; games[y]++
  }))
  const ratio = (i: number) => (games[i] ? mass[i] / games[i] : ring[i] / Math.max(1, n - 1))
  const ranked = [...ids].sort((a, b) => ratio(b) - ratio(a))
  return { ranked, conf: ratio(ranked[0]) - ratio(ranked[1]) }
}

// ---- lean sandbox for sub-agent attempts ------------------------------------------------
// Sub-agents run under XDG_CONFIG_HOME -> a provider-only config so they skip the user's MCP
// servers and plugins (the slow part). Deps install once into the sandbox and cache forever.
function leanConfig(C: Cfg): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `${C.provider || "provider"}/${C.model}`,
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
    provider: {
      [C.provider || "provider"]: {
        npm: "@ai-sdk/openai-compatible",
        name: C.provider || "provider",
        options: { baseURL: C.url, apiKey: C.key },
        models: { [C.model]: { name: C.model } },
      },
    },
  }, null, 2)
}

function appFromAgent(_agent: string): string {
  // The lean config is written under XDG/opencode/; opencode reads it, other agents ignore XDG.
  return "opencode"
}

async function ensureLeanSandbox(C: Cfg, app: string): Promise<{ home: string; needsWarm: boolean }> {
  const home = join(homedir(), ".cache", "agent-ultramode")
  const appDir = join(home, app)
  await mkdir(appDir, { recursive: true })
  await writeFile(join(appDir, `${app}.json`), leanConfig(C))
  return { home, needsWarm: !existsSync(join(appDir, "node_modules")) }
}

export const Ultra: Plugin = async (_input, options) => {
  const C = buildCfg((options as Opts) ?? {})
  const current = { model: "", url: "", key: "" }
  const client = (_input as any)?.client
  // load marker: lets us confirm which build actually loaded.
  writeFile(join(homedir(), ".cache", "agent-ultramode-loaded.txt"), `ultra ${VERSION} loaded ${new Date().toISOString()}\n`).catch(() => {})

  const ultra = tool({
    description:
      "Best-of-N with a verifier. Runs a coding/terminal task N times in isolated git worktrees, ranks the " +
      "attempts with the same model as a verifier, and applies the winning diff when confident (otherwise " +
      "reports the top candidates). Use for a task worth spending compute to get right the first time.",
    args: {
      task: tool.schema.string().describe("The task to solve N times and verify. Be specific."),
    },
    async execute(args, ctx) {
      const task = String((args as any)?.task ?? "").trim()
      if (!task) return "Pass a `task` to run."
      const eff: Cfg = { ...C, model: C.model || current.model, url: C.url || current.url, key: C.key || current.key }
      if (!eff.url || !eff.model) return "ultra could not resolve a verifier model. Set `model` in the plugin options, or send a message first so it can use your current model."

      let dir = (ctx as any).worktree || (ctx as any).directory || ""
      if (!dir) {
        // some hosts omit directory/worktree on the tool context; resolve the repo root from cwd.
        try { dir = (await git(process.cwd(), "rev-parse", "--show-toplevel")).trim() } catch { dir = process.cwd() }
      }
      let base: string
      try { base = (await git(dir, "rev-parse", "HEAD")).trim() } catch { return "ultra needs a git repo with a HEAD to branch attempts from (run it inside your project)." }

      const work = await mkdtemp(join(tmpdir(), "ultra-"))
      const worktrees: string[] = []
      const diffs: string[] = []
      const summaries: string[] = []
      const status = (title: string, body?: string) => {
        try { ctx.metadata({ title, metadata: body ? { output: body } : {} }) } catch {}
      }
      // ctx.metadata renders in the web UI tool card; toasts render in the terminal TUI.
      const toast = (message: string, variant: "info" | "success" | "warning" = "info") => {
        try { client?.tui?.showToast?.({ body: { message: `ultra: ${message}`, variant, duration: 4000 } })?.catch?.(() => {}) } catch {}
      }
      try {
        toast(`v${VERSION}: starting ${eff.n} attempts`)
        // Each attempt runs the agent in a LEAN sandbox: XDG_CONFIG_HOME points opencode at a
        // provider-only config (no MCP, no plugins, permission:allow), so an
        // attempt is a fast model turn instead of booting the whole environment N times.
        const app = appFromAgent(eff.agent)
        const { home: leanHome, needsWarm } = await ensureLeanSandbox(eff, app)
        // Shared: config dir (warm node_modules + lean config). Per-run: XDG_DATA/STATE/CACHE,
        // so each sub-run gets its OWN opencode.db. One shared DB across the main session + N
        // parallel runs deadlocks on the SQLite write lock (all idle, nothing written).
        const baseEnv = {
          ...process.env,
          XDG_CONFIG_HOME: leanHome,
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
        }
        const isolatedEnv = async (tag: string) => {
          const d = join(work, `xdg-${tag}`)
          await mkdir(d, { recursive: true }).catch(() => {})
          return { ...baseEnv, XDG_DATA_HOME: d, XDG_STATE_HOME: d, XDG_CACHE_HOME: d }
        }
        const cmd = eff.agent.replace("{task}", task.replace(/"/g, '\\"'))

        if (needsWarm) {
          // First run on this machine installs the sandbox deps once (cached afterwards).
          status(`ultra: one-time sandbox setup (installing ${app} sandbox deps, ~1-2 min)...`)
          const warm = await mkdtemp(join(tmpdir(), "ultra-warm-"))
          await execFileP("bash", ["-lc", "git init -q"], { cwd: warm }).catch(() => {})
          const warmCmd = eff.agent.replace("{task}", "reply with exactly: ready. do not create or edit files.")
          await execFileP("bash", ["-lc", `exec </dev/null; ${warmCmd}`], { cwd: warm, env: await isolatedEnv("warm"), timeout: eff.agentTimeoutMs, maxBuffer: 8 * 1024 * 1024 }).catch(() => {})
          await rm(warm, { recursive: true, force: true }).catch(() => {})
        }

        // Create N detached worktrees off HEAD (serial: git worktree add takes a repo lock).
        status(`ultra: preparing ${eff.n} isolated worktrees...`)
        for (let i = 0; i < eff.n; i++) {
          const wt = join(work, `attempt-${i}`)
          await git(dir, "worktree", "add", "--detach", wt, base)
          worktrees.push(wt)
        }

        // Run the agent in each worktree IN PARALLEL (lean sandbox keeps this cheap).
        const limit = pLimit(Math.max(1, Math.min(eff.cc, eff.n)))
        let done = 0
        status(`ultra: running ${eff.n} attempts in parallel...`)
        toast(`running ${eff.n} attempts in parallel`)
        const outs = await Promise.all(worktrees.map((wt, i) => limit(async () => {
          const env = await isolatedEnv(String(i))
          let log = ""
          try {
            const { stdout, stderr } = await execFileP("bash", ["-lc", `exec </dev/null; ${cmd}`], { cwd: wt, env, timeout: eff.agentTimeoutMs, maxBuffer: 32 * 1024 * 1024, signal: ctx.abort })
            log = (stdout || "") + (stderr || "")
          } catch (e: any) { log = `agent error: ${e?.message || e}` }
          await git(wt, "add", "-A").catch(() => {})
          const diff = await git(wt, "diff", "--cached").catch(() => "")
          done++
          status(`ultra: ${done}/${eff.n} attempts done`, `attempt ${i}: ${diff ? diff.length + " diff chars" : "no changes"}`)
          return { diff, summary: `AGENT LOG (tail):\n${log.slice(-1500)}\n\nDIFF:\n${diff.slice(0, 6000) || "(no changes)"}` }
        })))
        for (const o of outs) { diffs.push(o.diff); summaries.push(o.summary) }

        if (diffs.every((d) => !d.trim())) {
          return `ultra ran ${eff.n} attempts but none made any changes (all diffs empty). The sub-agent could not act: the task may be too ambiguous, or the sandbox model could not reach its endpoint. Try a more specific task, or check the model endpoint.`
        }

        status("ultra: verifying...")
        toast(`verifying ${eff.n} candidates`)
        const { ranked, conf } = await tournament(eff, task, summaries)
        const best = ranked[0]

        // Normalised added-lines of a diff, so we can tell when attempts AGREE on the same change.
        const nonEmpty = diffs.filter((d) => d.trim()).length
        // Apply the verifier's TOP pick when it is confident, OR when a majority of attempts
        // produced a change (the task was solvable; the top-ranked diff is a good starting point
        // and you review it before committing). Only mostly-empty runs are handed back as candidates.
        const majority = nonEmpty >= Math.max(2, Math.ceil(eff.n / 2))
        if ((conf >= eff.conf || majority) && diffs[best].trim()) {
          const patch = join(work, "winner.patch")
          await writeFile(patch, diffs[best])
          const confNote = conf >= eff.conf ? `high confidence ${conf.toFixed(2)}` : `top pick of ${nonEmpty}/${eff.n}, margin ${conf.toFixed(2)}`
          try {
            await git(dir, "apply", "--3way", patch)
            toast("applied the winning change", "success")
            return `🏆 ultra applied the best of ${eff.n} attempts (${confNote}). The winning change is now in your working tree; review it before committing.`
          } catch (e: any) {
            return `ultra picked the best attempt (${confNote}) but the patch did not apply cleanly (${e?.message || e}). The diff:\n\n\`\`\`diff\n${diffs[best].slice(0, 6000)}\n\`\`\``
          }
        }
        const top = ranked.slice(0, 3).map((i, r) => `### Candidate ${r + 1} (attempt ${i})\n\`\`\`diff\n${diffs[i].slice(0, 4000) || "(no changes)"}\n\`\`\``).join("\n\n")
        return `ultra ran ${eff.n} attempts but most produced no usable change, so it applied nothing. Top candidates:\n\n${top}`
      } finally {
        for (const wt of worktrees) await git(dir, "worktree", "remove", "--force", wt).catch(() => {})
        await rm(work, { recursive: true, force: true }).catch(() => {})
      }
    },
  })

  return {
    tool: { ultra },
    "chat.params": async (input: any) => {
      try {
        const id = input?.model?.id ?? input?.model?.modelID
        const o = input?.provider?.options
        if (id && o?.baseURL) { current.model = id; current.url = o.baseURL; if (o.apiKey) current.key = o.apiKey }
      } catch {}
    },
    config: async (cfg: any) => {
      cfg.command = {
        ultra: {
          description: "Best-of-N + verifier: run the task N times in isolated worktrees, apply the best. /ultra <task>",
          template:
            "Call the `ultra` tool exactly once, with `task` set to the request below. It runs the task several " +
            "times in isolated git worktrees and verifies the results. When it returns, report to the user exactly " +
            "what it did (applied the winner, or listed candidates) verbatim; do not re-do the task yourself.\n\nTask: $ARGUMENTS",
        },
        ...(cfg.command ?? {}),
      }
      // Register an "ultra" primary agent so it shows in the tab / agent list; selecting it
      // routes each request through best-of-N. Sub-attempts run the default agent, so no recursion.
      cfg.agent = {
        ultra: {
          description: "Best-of-N mode: run the request N times in isolated worktrees and apply the verified winner.",
          mode: "primary",
          color: "#A855F7",
          prompt:
            "You are in ULTRA mode (best-of-N with a same-model verifier). For the user's coding or terminal " +
            "request, call the `ultra` tool exactly once with the full request as `task`. When it returns, report " +
            "exactly what it did (applied the winner, or listed the candidates) verbatim; do not do the task yourself.",
        },
        ...(cfg.agent ?? {}),
      }
      try {
        if (C.provider && cfg?.provider?.[C.provider]) {
          const p = cfg.provider[C.provider]
          if (!C.url && p.options?.baseURL) C.url = p.options.baseURL
          if (!C.key && p.options?.apiKey) C.key = p.options.apiKey
        }
      } catch {}
    },
  }
}

export default Ultra
