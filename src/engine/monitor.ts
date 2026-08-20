import type { Ctx, Job, Decision, MonitorAction } from "../types"
import { worktreePath, matchesCwd } from "./naming"
import { applyDone, applyNudge, applyEscalate, applyRestart, applyFail, applyNotifyBlocked } from "../effects/monitor"

export async function monitorJob(ctx: Ctx, p: Job): Promise<Decision[]> {
  const claimed = await ctx.cache(`engine:claimed:${p.name}`, () => p.discoverClaimed(ctx))
  const agents = await ctx.cache("engine:agents", () => ctx.herdr.agents())
  const panes = await ctx.cache("engine:panes", () => ctx.herdr.panes())
  const timeout = ctx.config.blockedTimeoutMin ?? 180
  const out: Decision[] = []

  for (const item of claimed) {
    const key = await p.key(ctx, item)
    const wt = worktreePath(ctx.workspace.worktreeBase, p.name, key)
    const mk = (action: MonitorAction, reason: string): Decision => ({
      pass: "monitor", job: p.name, key, action, reason,
    })
    const act = async (fn: () => Promise<void>) => {
      if (!ctx.live) return
      try {
        await fn()
      } catch (err) {
        // One item's action failing must not stop the pass: the remaining
        // claimed items are unrelated to this failure.
        out.push({ pass: "error", job: p.name, where: "monitor", reason: String(err) })
      }
    }

    if (item.state !== "OPEN") {
      out.push(mk("done", `state ${item.state}`))
      await act(() => applyDone(ctx, item))
      continue
    }
    if (await p.done(ctx, item)) {
      if (ctx.marks.has(p.name, key, "spawned")) {
        out.push(mk("done", "done() true"))
      } else {
        ctx.marks.set(p.name, key, "spawned")
        out.push(mk("external", "done() true with no spawned mark"))
      }
      // Either way the work is over, so the claim comes off: an item that keeps
      // it counts against the job's slots for good.
      await act(() => applyDone(ctx, item))
      continue
    }

    const agent = agents.find((a) => matchesCwd(a.cwd, wt))

    if (agent?.status === "working") {
      out.push(mk("busy", "agent working"))
      continue
    }

    if (agent?.status === "blocked") {
      const age = ctx.marks.age(p.name, key, "blocked")
      if (age === null) {
        ctx.marks.set(p.name, key, "blocked")
        out.push(mk("blocked", "first sighting, notify once"))
        await act(() => applyNotifyBlocked(ctx, p, item, key))
      } else if (age >= timeout) {
        ctx.marks.clear(p.name, key, "blocked")
        out.push(mk("escalate", `blocked ${age}m >= ${timeout}m`))
        await act(() => applyEscalate(ctx, p, item, key))
      } else {
        out.push(mk("hold", `blocked ${age}m < ${timeout}m`))
      }
      continue
    }

    if (agent?.status === "missing") {
      // An unrecognized herdr agent_status maps to "missing" (see adapters/herdr.ts).
      // Hold, not nudge or fail: hold cannot kill a live agent and cannot
      // tombstone an item, so it is fail-safe if herdr renames or adds a status.
      out.push(mk("hold", "agent status missing, holding"))
      continue
    }

    if (!agent) {
      const paneAlive = panes.some((pane) => matchesCwd(pane.cwd, wt))
      // Once, per spec 11. A restart takes no spawns row, so an agent that
      // keeps dying would otherwise be restarted every tick forever, burning
      // real quota outside maxSpawnsPerDay.
      if (paneAlive && !ctx.marks.has(p.name, key, "restarted")) {
        ctx.marks.set(p.name, key, "restarted")
        out.push(mk("restart", "pane alive, agent gone"))
        await act(() => applyRestart(ctx, p, item, key))
        continue
      }
      out.push(mk("fail", paneAlive ? "agent gone again after a restart" : "no agent and no pane"))
      await act(() => applyFail(ctx, p, item, key))
      continue
    }

    if (!ctx.marks.has(p.name, key, "nudged")) {
      ctx.marks.set(p.name, key, "nudged")
      out.push(mk("nudge", agent ? `agent ${agent.status}` : "no agent"))
      await act(() => applyNudge(ctx, p, item, key))
      continue
    }

    out.push(mk("fail", "still not done after a nudge"))
    await act(() => applyFail(ctx, p, item, key))
  }
  return out
}

export async function monitorAll(ctx: Ctx, jobs: Job[]): Promise<Decision[]> {
  const out: Decision[] = []
  for (const p of jobs) {
    try {
      out.push(...(await monitorJob(ctx, p)))
    } catch (err) {
      out.push({ pass: "error", job: p.name, where: "monitor", reason: String(err) })
    }
  }
  return out
}
