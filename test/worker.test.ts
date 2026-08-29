import { test, expect } from "bun:test"
import { startWorker, sendBrief, dialogKeys, START_RETRIES, PROMPT_ATTEMPTS } from "../src/runtime/worker"
import type { AgentStatus, Ctx } from "../src/types"

function ctxWith(o: {
  startFails?: number
  startErrors?: string[]
  statuses?: AgentStatus[]
  promptThrows?: boolean
  screen?: string
  statusThrowsFrom?: number
} = {}) {
  const calls: string[] = []
  const slept: number[] = []
  const keys: string[][] = []
  let starts = 0
  const statuses = o.statuses ?? ["working"]
  let read = 0
  const ctx = {
    sleep: async (ms: number) => { slept.push(ms) },
    herdr: {
      async agentStart() {
        calls.push("start")
        if (++starts <= (o.startFails ?? 0)) {
          const errs = o.startErrors ?? ["pane not ready"]
          throw new Error(errs[Math.min(starts - 1, errs.length - 1)]!)
        }
      },
      async agentPrompt() {
        calls.push("prompt")
        if (o.promptThrows) throw new Error("timed out waiting for working")
      },
      async agentRead() {
        calls.push("read")
        return o.screen ?? ""
      },
      async agentSendKeys(_t: string, k: string[]) {
        calls.push("enter")
        keys.push(k)
      },
      async agentStatus(): Promise<AgentStatus> {
        calls.push("status")
        const n = ++read
        if (o.statusThrowsFrom !== undefined && n >= o.statusThrowsFrom) {
          throw new Error("herdr exited 1: agent_not_found")
        }
        return statuses[Math.min(n - 1, statuses.length - 1)]!
      },
    },
  } as unknown as Ctx
  return { ctx, calls, slept, keys }
}

// Verbatim from a worker that came up on the folder-trust question, which lists
// the refusing answer first and highlights it.
const TRUST_SCREEN = [
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " \u276f No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm \u00b7 Esc to cancel",
].join("\n")

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

// herdr fails the start when the agent comes up on a folder-trust or external
// -import dialog. The agent is running and the dialog can be answered, so the
// start is finished, not retried: retrying it can only collide with the name
// the failed attempt already registered.
test("an agent blocked on a startup dialog is answered, not retried", async () => {
  const { ctx, calls } = ctxWith({ startFails: 1, statuses: ["blocked", "idle", "working"] })
  await startWorker(ctx, spec)
  expect(calls).toEqual(["start", "status", "read", "enter", "status", "prompt", "status"])
})

test("a dialog that the answer does not clear falls back to the retry loop", async () => {
  const { ctx, calls } = ctxWith({ startFails: START_RETRIES, statuses: ["blocked"] })
  await expect(startWorker(ctx, spec)).rejects.toThrow(/after 5 attempts/)
  expect(calls.filter((c) => c === "start")).toHaveLength(START_RETRIES)
  expect(calls.filter((c) => c === "enter")).toHaveLength(START_RETRIES)
})

// The folder-trust dialog highlights "No, exit". Enter there quits the agent
// rather than answering it, and herdr then has nothing left at the pane.
test("the trusting answer is selected before Enter, not the highlighted refusal", async () => {
  const { ctx, keys } = ctxWith({
    startFails: 1,
    statuses: ["blocked", "idle", "working"],
    screen: TRUST_SCREEN,
  })
  await startWorker(ctx, spec)
  expect(keys).toEqual([["Down", "Enter"]])
})

// An answer that quits the agent leaves herdr with nothing at the pane, and the
// status read that follows fails. That read must not become the reported error:
// it hides the start failure and eats the attempts that would have recovered.
test("a failed status read neither masks the start error nor ends the retries", async () => {
  const { ctx, calls } = ctxWith({
    startFails: START_RETRIES,
    startErrors: ["pane not ready"],
    statusThrowsFrom: 1,
  })
  await expect(startWorker(ctx, spec)).rejects.toThrow(/pane not ready/)
  expect(calls.filter((c) => c === "start")).toHaveLength(START_RETRIES)
})

test("a screen with no yes-or-no options is still answered with a bare Enter", () => {
  expect(dialogKeys("some banner with no question on it")).toEqual(["Enter"])
})

test("the permissive answer is walked to whichever side of the cursor it is on", () => {
  expect(dialogKeys(TRUST_SCREEN)).toEqual(["Down", "Enter"])
  expect(dialogKeys(" \u276f Yes, allow external imports\n   No, disable external imports")).toEqual(["Enter"])
  expect(dialogKeys("   Yes, I trust this folder\n \u276f No, exit")).toEqual(["Up", "Enter"])
})

test("the reported start error is the first one, not the collision it caused", async () => {
  const { ctx } = ctxWith({ startFails: START_RETRIES, startErrors: ["pane not ready", "agent_name_taken"] })
  await expect(startWorker(ctx, spec)).rejects.toThrow(/pane not ready/)
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
