import type { Ctx, Job, Decision, WorkItem } from "../types"
import { owns, keyOf, matchesCwd } from "./naming"
import { applySweep } from "../effects/sweep"
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
    const mk = (action: "clean" | "hold", reason: string): Decision => ({
      pass: "sweep", job: p.name, worktree: wt.path, branch: wt.branch!, action, reason,
    })

    const live = agents.some((a) => a.status === "working" && matchesCwd(a.cwd, wt.path))
    if (live && !p.sweepIgnoresWorking) {
      out.push(mk("hold", "agent working"))
      continue
    }
    const predicate = p.sweepOk ? "sweepOk" : "done"
    if (!(await isFinished(ctx, p, rawKey))) {
      out.push(mk("hold", `${predicate}(${rawKey}) false`))
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
