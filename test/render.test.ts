import { test, expect } from "bun:test"
import { renderDecision } from "../src/render"

test("dry-run decisions render as WOULD lines", () => {
  expect(renderDecision({ pass: "spawn", job: "build", key: "b7", action: "spawn", reason: "first eligible candidate" }))
    .toBe("WOULD spawn build b7 (first eligible candidate)")
  expect(renderDecision({ pass: "sweep", job: "review", worktree: "/b/wt-review-r80", branch: "review/r80", action: "clean", reason: "sweepOk(r80)" }))
    .toBe("WOULD sweep review /b/wt-review-r80 (sweepOk(r80))")
  expect(renderDecision({ pass: "monitor", job: "review", key: "80", action: "nudge", reason: "agent idle" }))
    .toBe("WOULD nudge review 80 (agent idle)")
  expect(renderDecision({ pass: "monitor", job: "review", key: "80", action: "busy", reason: "agent working" }))
    .toBe("BUSY review 80 (agent working)")
  expect(renderDecision({ pass: "spawn", job: "build", key: "", action: "skip", reason: "idle" }))
    .toBe("IDLE build")
  expect(renderDecision({ pass: "gc", removed: 3 })).toBe("GC 3 marks")
  expect(renderDecision({ pass: "tick", workspace: "acme", ms: 812 })).toBe("TICK acme 812ms")
  expect(renderDecision({ pass: "tick", workspace: "total", ms: 3400 })).toBe("TICK total 3400ms")
})

// F8
test("monitor done and external render uppercase, not WOULD", () => {
  expect(renderDecision({ pass: "monitor", job: "review", key: "80", action: "done", reason: "state MERGED" }))
    .toBe("DONE review 80 (state MERGED)")
  expect(renderDecision({ pass: "monitor", job: "review", key: "80", action: "external", reason: "done() true with no spawned mark" }))
    .toBe("EXTERNAL review 80 (done() true with no spawned mark)")
})

// F9
test("a spawn skip whose reason is not the idle reason renders as SKIP", () => {
  expect(renderDecision({ pass: "spawn", job: "build", key: "", action: "skip", reason: "slots 1/1 in flight" }))
    .toBe("SKIP build (slots 1/1 in flight)")
})

// F5
test("an error decision renders job, pass, and reason", () => {
  expect(renderDecision({ pass: "error", job: "review", where: "monitor", reason: "Error: boom" }))
    .toBe("ERROR review monitor (Error: boom)")
})

test("a spawn decision renders the account", () => {
  expect(renderDecision({
    pass: "spawn", job: "build", key: "b7", action: "spawn",
    account: "loop", reason: "session 10.0% of 90 with 200m left -> 4 workers, 0 in flight",
  })).toBe("WOULD spawn build b7 on loop (session 10.0% of 90 with 200m left -> 4 workers, 0 in flight)")
})

test("a spawn decision without an account still renders", () => {
  expect(renderDecision({
    pass: "spawn", job: "build", key: "b7", action: "spawn", reason: "why",
  })).toBe("WOULD spawn build b7 (why)")
})

// F2: a live run really did the thing, so the operator's only view of the loop
// must not read as a dry run.
test("live decisions render the verb instead of WOULD", () => {
  expect(renderDecision({ pass: "spawn", job: "build", key: "b7", action: "spawn", account: "loop", reason: "why" }, true))
    .toBe("SPAWN build b7 on loop (why)")
  expect(renderDecision({ pass: "sweep", job: "review", worktree: "/b/wt-review-r80", branch: "review/r80", action: "clean", reason: "sweepOk(r80)" }, true))
    .toBe("SWEEP review /b/wt-review-r80 (sweepOk(r80))")
  expect(renderDecision({ pass: "monitor", job: "review", key: "80", action: "nudge", reason: "agent idle" }, true))
    .toBe("NUDGE review 80 (agent idle)")
  // Lines that never said WOULD are unchanged.
  expect(renderDecision({ pass: "monitor", job: "review", key: "80", action: "busy", reason: "agent working" }, true))
    .toBe("BUSY review 80 (agent working)")
  expect(renderDecision({ pass: "sweep", job: "review", worktree: "/b/wt-review-r80", branch: "review/r80", action: "hold", reason: "agent working" }, true))
    .toBe("HOLD review /b/wt-review-r80 (agent working)")
})

test("a workspace that failed to load renders as one error line", () => {
  expect(
    renderDecision({ pass: "error", where: "workspace", workspace: "acme", reason: "no workspace.yml" }),
  ).toBe("ERROR workspace acme (no workspace.yml)")
})
