import { test, expect } from "bun:test"
import { startWorker, sendBrief, START_RETRIES, PROMPT_ATTEMPTS } from "../src/runtime/worker"
import type { AgentStatus, Ctx } from "../src/types"

function ctxWith(o: {
  startFails?: number
  statuses?: AgentStatus[]
  promptThrows?: boolean
} = {}) {
  const calls: string[] = []
  const slept: number[] = []
  let starts = 0
  const statuses = o.statuses ?? ["working"]
  let read = 0
  const ctx = {
    sleep: async (ms: number) => { slept.push(ms) },
    herdr: {
      async agentStart() {
        calls.push("start")
        if (++starts <= (o.startFails ?? 0)) throw new Error("pane not ready")
      },
      async agentPrompt() {
        calls.push("prompt")
        if (o.promptThrows) throw new Error("timed out waiting for working")
      },
      async agentSendKeys() { calls.push("enter") },
      async agentStatus(): Promise<AgentStatus> {
        calls.push("status")
        return statuses[Math.min(read++, statuses.length - 1)]!
      },
    },
  } as unknown as Ctx
  return { ctx, calls, slept }
}

const spec = { pane: "w6:t2:p1", kind: "claude", name: "build-b7", args: [], brief: "go" }

test("a healthy start prompts once and asserts the agent is working", async () => {
  const { ctx, calls } = ctxWith()
  await startWorker(ctx, spec)
  expect(calls).toEqual(["start", "prompt", "status"])
})

test("a not-yet-ready pane is retried at the documented interval", async () => {
  const { ctx, calls, slept } = ctxWith({ startFails: 2 })
  await startWorker(ctx, spec)
  expect(calls.filter((c) => c === "start")).toHaveLength(3)
  expect(slept).toEqual([3000, 3000])
})

test("a pane that never comes up fails after the last attempt, not before", async () => {
  const { ctx, calls } = ctxWith({ startFails: START_RETRIES })
  await expect(startWorker(ctx, spec)).rejects.toThrow(/after 5 attempts/)
  expect(calls.filter((c) => c === "start")).toHaveLength(START_RETRIES)
})

test("a stuck composer gets one Enter and is then confirmed", async () => {
  const { ctx, calls } = ctxWith({ statuses: ["idle", "working"] })
  await sendBrief(ctx, "w6:t2:p1", "go")
  expect(calls).toEqual(["prompt", "status", "enter", "status"])
})

test("a composer still stuck after the recovery Enter is an error, not a silent success", async () => {
  const { ctx } = ctxWith({ statuses: ["idle", "idle"] })
  await expect(sendBrief(ctx, "w6:t2:p1", "go")).rejects.toThrow(/did not start working/)
})

test("a prompt that times out still gets the recovery path", async () => {
  const { ctx, calls } = ctxWith({ promptThrows: true, statuses: ["idle", "working"] })
  await sendBrief(ctx, "w6:t2:p1", "go")
  expect(calls).toEqual(["prompt", "status", "enter", "status"])
})

// A session whose SessionStart hooks are still streaming reports idle and
// moves no state, so herdr answers agent_prompt_stalled and drops the brief.
// That is a slow start, not a refusal, and sending it again is the recovery.
test("a stalled prompt is sent again until the session has settled", async () => {
  const { ctx, calls } = ctxWith({
    promptThrows: true,
    // idle through the whole of the first attempt, then working on the second.
    statuses: ["idle", "idle", "idle", "working"],
  })
  await sendBrief(ctx, "w6:t2:p1", "go")
  expect(calls.filter((c) => c === "prompt")).toHaveLength(2)
})

test("a session that never settles fails after the last attempt, naming the count", async () => {
  const { ctx, calls } = ctxWith({ promptThrows: true, statuses: ["idle"] })
  await expect(sendBrief(ctx, "w6:t2:p1", "go")).rejects.toThrow(
    new RegExp(`did not start working after ${PROMPT_ATTEMPTS} briefs`),
  )
  expect(calls.filter((c) => c === "prompt")).toHaveLength(PROMPT_ATTEMPTS)
})
