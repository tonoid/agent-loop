import type { AgentStatus, Ctx } from "../types"

// The pane's shell is not ready the instant the tab exists, and this is the
// failure that shows up most often in production start logs.
export const START_RETRIES = 5
export const START_DELAY_MS = 3000
export const PROMPT_TIMEOUT_MS = 15000
export const RECOVER_WAIT_MS = 5000
// A session whose SessionStart hooks are still running reports idle and moves
// no state, so herdr answers agent_prompt_stalled and the brief is dropped on
// the floor. That is a slow start, not a refusal, and the only recovery is to
// send it again once the session has settled.
export const PROMPT_ATTEMPTS = 5

export interface WorkerSpec {
  pane: string
  kind: string
  name: string
  args: string[]
  brief: string
}

// Enough of the screen to carry a dialog's options and the cursor on one of them.
export const DIALOG_LINES = 40

// Both startup dialogs list their refusing answer first and highlight it, so a
// bare Enter answers neither: on the folder-trust one it picks "No, exit", the
// agent quits, herdr deregisters it, and every later read of that pane fails
// with agent_not_found. Read which option the cursor is on instead and walk it
// to the one that starts with "Yes", which is the answer these workers have
// always meant to give. A screen with no such options keeps the old bare Enter,
// because a dialog nobody has seen yet is still more likely to want confirming
// than cancelling.
export function dialogKeys(screen: string): string[] {
  const options = screen
    .split("\n")
    .map((l) => ({ selected: /^\s*[\u276f>]/.test(l), text: l.replace(/^\s*[\u276f>]?\s*/, "") }))
    .filter((o) => /^(Yes|No),/.test(o.text))
  const at = options.findIndex((o) => o.selected)
  const yes = options.findIndex((o) => o.text.startsWith("Yes"))
  if (at < 0 || yes < 0) return ["Enter"]
  const step = yes > at ? "Down" : "Up"
  return [...Array(Math.abs(yes - at)).fill(step), "Enter"]
}

// An agent that comes up on a startup dialog is running, not broken: it is
// waiting on a keypress, and every worktree is a directory the agent has never
// seen, so the folder-trust and external-CLAUDE.md-import questions are the
// normal case rather than the exception. Stacked dialogs get one answer per
// start attempt, which is what the retry loop is for.
async function answerStartupDialog(ctx: Ctx, pane: string): Promise<boolean> {
  if ((await ctx.herdr.agentStatus(pane)) !== "blocked") return false
  await ctx.herdr.agentSendKeys(pane, dialogKeys(await ctx.herdr.agentRead(pane, DIALOG_LINES)))
  await ctx.sleep(RECOVER_WAIT_MS)
  return (await ctx.herdr.agentStatus(pane)) !== "blocked"
}

export async function startWorker(ctx: Ctx, w: WorkerSpec): Promise<void> {
  // The first error, not the last: once an attempt has registered the name,
  // every retry after it fails with agent_name_taken, and reporting that hides
  // the only error that says why the start failed in the first place.
  let firstErr: unknown = null
  let started = false
  for (let attempt = 1; attempt <= START_RETRIES; attempt++) {
    try {
      await ctx.herdr.agentStart({ pane: w.pane, kind: w.kind, name: w.name, args: w.args })
      started = true
      break
    } catch (err) {
      if (firstErr === null) firstErr = err
      // Answering can fail in its own right: a dialog answered with the wrong
      // key quits the agent, and the reads here then throw agent_not_found.
      // Letting that escape replaces the start error with a symptom of the
      // recovery and skips every attempt that was left.
      if (await answerStartupDialog(ctx, w.pane).catch(() => false)) {
        started = true
        break
      }
      if (attempt < START_RETRIES) await ctx.sleep(START_DELAY_MS)
    }
  }
  if (!started) {
    throw new Error(`agent start failed after ${START_RETRIES} attempts: ${firstErr}`)
  }
  await sendBrief(ctx, w.pane, w.brief)
}

export async function sendBrief(ctx: Ctx, pane: string, brief: string): Promise<void> {
  let status: AgentStatus = "idle"
  for (let attempt = 1; attempt <= PROMPT_ATTEMPTS; attempt++) {
    // From the second attempt on only: never re-prompt an agent that is
    // already working, because the previous send may have landed a moment
    // after its own status check and a second one would queue the brief twice.
    // On the first pass there is nothing to double, and checking first would
    // skip the send entirely for an agent herdr already calls working.
    if (attempt > 1) {
      status = await ctx.herdr.agentStatus(pane)
      if (status === "working") return
    }

    try {
      await ctx.herdr.agentPrompt(pane, brief, { until: "working", timeoutMs: PROMPT_TIMEOUT_MS })
    } catch {
      // A timeout waiting for "working", or the stall herdr reports when the
      // session moved no state at all. Neither is fatal here; the assertions
      // below are what decide, and the throw at the end carries the status
      // actually seen.
    }
    status = await ctx.herdr.agentStatus(pane)
    if (status === "working") return

    // A stuck composer holds the brief as unsent text and presents as idle.
    // One Enter, one more look, then round again.
    await ctx.herdr.agentSendKeys(pane, ["Enter"])
    await ctx.sleep(RECOVER_WAIT_MS)
    status = await ctx.herdr.agentStatus(pane)
    if (status === "working") return
  }
  throw new Error(
    `agent did not start working after ${PROMPT_ATTEMPTS} briefs (status ${status})`,
  )
}
