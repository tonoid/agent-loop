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

export async function startWorker(ctx: Ctx, w: WorkerSpec): Promise<void> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= START_RETRIES; attempt++) {
    try {
      await ctx.herdr.agentStart({ pane: w.pane, kind: w.kind, name: w.name, args: w.args })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      if (attempt < START_RETRIES) await ctx.sleep(START_DELAY_MS)
    }
  }
  if (lastErr) {
    throw new Error(`agent start failed after ${START_RETRIES} attempts: ${lastErr}`)
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
