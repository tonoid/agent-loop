import type { Ctx, Job, Decision, WorkItem, AgentStatus } from "../types"
import type { Worktree } from "../adapters/git"
import { owns, keyOf, matchesCwd } from "./naming"
import { applySweep, applyReap } from "../effects/sweep"
import { notifyOverdue } from "../overdue"
import { auditFiling } from "../filing"
import { appendJournal } from "../journal"
import { renderDecision } from "../render"

async function isFinished(ctx: Ctx, p: Job, rawKey: string): Promise<boolean> {
  if (p.sweepOk) return p.sweepOk(ctx, rawKey)
  const digits = rawKey.match(/\d+/g) ?? []
  const synthetic: WorkItem = {
    id: `key:${rawKey}`,
    // A synthetic item has no real number. Use one only when the key holds a
    // single digit run ("r80" -> 80). A multi-group key such as a date is not a
    // number, and a fabricated one would mislead done(); those jobs define
    // sweepOk instead.
    number: digits.length === 1 ? Number.parseInt(digits[0]!, 10) : 0,
    title: "",
    state: "OPEN",
    labels: [],
  }
  return p.done(ctx, synthetic)
}

// An agent in one of these has nothing left to run: "idle" is a session
// sitting at its prompt and "done" is one herdr has seen finish. "working" is
// still going and "blocked" wants a human, so neither is ever cut off here.
const REAPABLE: AgentStatus[] = ["idle", "done"]

// A worker that finishes its round and never exits keeps counting against its
// account in inFlightByAccount, for as long as its worktree waits on a
// sweepOk somebody outside the loop owns, which for a reviewer is until the
// pull request closes. The monitor cannot help: done() has already turned
// true, so the item lost its claim and monitor stopped looking at it. On
// 2026-09-07 two of them held the only account maplista may use, one for nine
// hours and one for eight, and every tick in between read as a healthy
// STARVED. Close the tab and leave the worktree, which is the half of a sweep
// that is safe while sweepOk is still false.
async function reapable(ctx: Ctx, p: Job, wt: Worktree, rawKey: string): Promise<string | null> {
  const stale = ctx.config.staleAgentMin
  if (!stale) return null
  const agents = await ctx.cache("engine:agents", () => ctx.herdr.agents())
  const agent = agents.find((a) => matchesCwd(a.cwd, wt.path) && REAPABLE.includes(a.status))
  if (!agent) {
    // It went away on its own, or went back to working. Either way the clock
    // this run started should not carry into the next idle spell.
    ctx.marks.clear(p.name, rawKey, "stale")
    return null
  }
  const age = ctx.marks.age(p.name, rawKey, "stale")
  if (age === null) {
    ctx.marks.set(p.name, rawKey, "stale")
    return null
  }
  if (age < stale) return null
  ctx.marks.clear(p.name, rawKey, "stale")
  return `agent ${agent.status} ${age}m >= ${stale}m, closing the tab`
}

export async function sweepJob(ctx: Ctx, p: Job): Promise<Decision[]> {
  const repo = ctx.workspace.repos[p.repo ?? ""]
  if (!repo) return []
  const base = ctx.workspace.worktreeBase
  // "engine:" prefixes every cache key the engine owns (here and in monitor.ts
  // and spawn.ts), reserving that namespace so a job's own ctx.cache key can
  // never collide with, and poison, the engine's snapshot for this tick.
  const worktrees = await ctx.cache(`engine:worktrees:${repo}`, () => ctx.git(repo).worktrees())
  const agents = await ctx.cache("engine:agents", () => ctx.herdr.agents())
  const out: Decision[] = []

  for (const wt of worktrees) {
    if (!owns(p.name, base, wt)) continue
    const rawKey = keyOf(p.name, wt.branch)!
    const mk = (action: "clean" | "hold" | "overdue" | "reap", reason: string): Decision => ({
      pass: "sweep", job: p.name, worktree: wt.path, branch: wt.branch!, action, reason,
    })
    // Both holds below are unbounded by design, and this pass is the only one
    // that sees the second of them: an item whose done() has turned true has
    // already lost its claim, so monitor stops looking at it while its worktree
    // waits here on a sweepOk that something outside the loop owns.
    const held = async (reason: string, what: string) => {
      const overdue = await notifyOverdue(ctx, p.name, rawKey, what)
      out.push(overdue ? mk("overdue", overdue) : mk("hold", reason))
    }

    const live = agents.some((a) => a.status === "working" && matchesCwd(a.cwd, wt.path))
    if (live && !p.sweepIgnoresWorking) {
      await held("agent working", "holding a worktree open for a working agent")
      continue
    }
    const predicate = p.sweepOk ? "sweepOk" : "done"
    if (!(await isFinished(ctx, p, rawKey))) {
      const reason = await reapable(ctx, p, wt, rawKey)
      if (reason) {
        out.push(mk("reap", reason))
        if (ctx.live) {
          try {
            await applyReap(ctx, wt)
          } catch (err) {
            // The worktree still holds below either way: a tab that will not
            // close is a slot left occupied, not a reason to skip the hold.
            out.push({ pass: "error", job: p.name, where: "sweep", reason: String(err) })
          }
        }
      }
      await held(`${predicate}(${rawKey}) false`, `waiting on ${predicate}(${rawKey})`)
      continue
    }
    out.push(mk("clean", `${predicate}(${rawKey})`))
    // The run is over, so this is the moment its output can be counted. Failure
    // here is reported and never blocks the cleanup: an audit is bookkeeping.
    if (p.filing) {
      try {
        const audit = await auditFiling(ctx, p, rawKey)
        if (audit && audit.filed > audit.budget) {
          const d: Decision = { pass: "audit", job: p.name, key: rawKey, filed: audit.filed, budget: audit.budget }
          out.push(d)
          appendJournal(ctx, renderDecision(d, ctx.live))
        }
      } catch (err) {
        out.push({ pass: "error", job: p.name, where: "sweep", reason: String(err) })
      }
    }
    if (ctx.live) {
      try {
        await applySweep(ctx, p, wt)
      } catch (err) {
        // One worktree that will not clean up must not strand the others: the
        // next worktree in this job's list is unrelated to this failure.
        out.push({ pass: "error", job: p.name, where: "sweep", reason: String(err) })
      }
    }
  }
  return out
}

export async function sweepAll(ctx: Ctx, jobs: Job[]): Promise<Decision[]> {
  const out: Decision[] = []
  for (const p of jobs) {
    try {
      out.push(...(await sweepJob(ctx, p)))
    } catch (err) {
      out.push({ pass: "error", job: p.name, where: "sweep", reason: String(err) })
    }
  }
  return out
}
