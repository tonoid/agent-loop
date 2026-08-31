import type { Ctx } from "./types"

// Every hold in the loop is deliberate and fail-safe: it cannot kill a live
// agent and cannot tombstone an item, so whatever it fails to resolve it simply
// keeps. What it has no way to say is that it has been keeping it too long.
// `blocked` is the one state carrying a clock (blockedTimeoutMin, then
// escalate). A worker wedged in `working` and a worktree whose sweepOk never
// turns true both hold with nothing counting the minutes, and both did: a
// content run held its job's only slot for two hours behind a leftover shell,
// and a review worktree waited eight for a pull request CI had quietly declined
// to merge. Neither is visible in a tick log that says HOLD every two minutes
// and has said HOLD every two minutes for a week.
//
// So: the same clock, and nothing else. No escalation and no kill, because a
// hold is the right response to not knowing and a timer is a bad reason to
// interrupt a run that might be mid-write. Silence was the defect, not holding.
//
// The age comes from the `spawned` mark, which covers the whole occurrence
// rather than time since this pass first noticed. An occurrence with no such
// mark has no age to read and is left alone, so an adopted or imported worktree
// never pings on a number nobody set.
export async function notifyOverdue(
  ctx: Ctx,
  job: string,
  key: string,
  what: string,
): Promise<string | null> {
  const timeout = ctx.config.holdTimeoutMin
  if (!timeout) return null
  const age = ctx.marks.age(job, key, "spawned")
  if (age === null || age < timeout) return null
  // Once per occurrence. The mark is what makes it once: a hold that lasts a
  // day is one notification, not seven hundred.
  if (ctx.marks.has(job, key, "overdue")) return null
  ctx.marks.set(job, key, "overdue")
  if (ctx.live) {
    await ctx.herdr
      .notify(
        `${job} has been held ${age}m`,
        `${job} ${key} is ${what}, and has been in flight ${age}m against a ${timeout}m timeout. Nothing is failing here, and nothing is finishing either.`,
      )
      .catch(() => {})
  }
  return `${what}, ${age}m >= ${timeout}m`
}
