import { test, expect } from "bun:test"
import { makeHerdr } from "../src/adapters/herdr"

function recorder(reply: any = {}, text = "") {
  const calls: string[][] = []
  return {
    calls,
    run: async (argv: string[]) => { calls.push(argv); return reply },
    runText: async (argv: string[]) => { calls.push(argv); return text },
  }
}

test("workspaces are listed by label so a spawn can resolve one", async () => {
  const r = recorder({ result: { workspaces: [
    { workspace_id: "w6", label: "acme" },
    { workspace_id: "w7", label: "other" },
  ] } })
  const h = makeHerdr(r.run, r.runText)
  expect(await h.workspaces()).toEqual([
    { id: "w6", label: "acme" },
    { id: "w7", label: "other" },
  ])
  expect(r.calls).toEqual([["herdr", "workspace", "list"]])
})

test("a tab is created with one --env per variable and never focused", async () => {
  const r = recorder()
  await makeHerdr(r.run, r.runText).tabCreate({
    workspaceId: "w6",
    cwd: "/b/wt-build-b7",
    label: "build-b7",
    env: { CLAUDE_CONFIG_DIR: "~/.claude-loop", AGENT_LOOP: "1" },
  })
  expect(r.calls[0]).toEqual([
    "herdr", "tab", "create",
    "--workspace", "w6",
    "--cwd", "/b/wt-build-b7",
    "--label", "build-b7",
    "--env", "CLAUDE_CONFIG_DIR=~/.claude-loop",
    "--env", "AGENT_LOOP=1",
    "--no-focus",
  ])
})

test("a tab is closed by tab id, never by workspace id", async () => {
  const r = recorder()
  await makeHerdr(r.run, r.runText).tabClose("w6:t2")
  expect(r.calls[0]).toEqual(["herdr", "tab", "close", "w6:t2"])
})

test("an agent starts in an existing pane with its kind and start args", async () => {
  const r = recorder()
  await makeHerdr(r.run, r.runText).agentStart({
    pane: "w6:t2:p1", kind: "claude", name: "build-b7",
    args: ["--dangerously-skip-permissions"],
  })
  expect(r.calls[0]).toEqual([
    "herdr", "agent", "start", "build-b7", "--kind", "claude", "--pane", "w6:t2:p1",
    "--", "--dangerously-skip-permissions",
  ])
})

test("an agent can start with no args and no -- separator", async () => {
  const r = recorder()
  await makeHerdr(r.run, r.runText).agentStart({
    pane: "w6:t2:p1", kind: "claude", name: "build-b7",
    args: [],
  })
  expect(r.calls[0]).toEqual([
    "herdr", "agent", "start", "build-b7", "--kind", "claude", "--pane", "w6:t2:p1",
  ])
})

test("a prompt can wait for a state, and the text stays one argv element", async () => {
  const r = recorder()
  const h = makeHerdr(r.run, r.runText)
  await h.agentPrompt("w6:t2:p1", "do the thing\nwith a newline")
  await h.agentPrompt("w6:t2:p1", "go", { until: "working", timeoutMs: 15000 })
  expect(r.calls[0]).toEqual(["herdr", "agent", "prompt", "w6:t2:p1", "do the thing\nwith a newline"])
  expect(r.calls[1]).toEqual([
    "herdr", "agent", "prompt", "w6:t2:p1", "go",
    "--wait", "--until", "working", "--timeout", "15000",
  ])
})

// agent read answers with the terminal text itself, not a JSON envelope, so it
// is the one verb that must not go through the JSON runner.
test("keys and reads use the documented flags", async () => {
  const r = recorder({}, "tail text")
  const h = makeHerdr(r.run, r.runText)
  await h.agentSendKeys("w6:t2:p1", ["Enter"])
  expect(await h.agentRead("w6:t2:p1", 60)).toBe("tail text")
  expect(r.calls).toEqual([
    ["herdr", "agent", "send-keys", "w6:t2:p1", "Enter"],
    ["herdr", "agent", "read", "w6:t2:p1", "--source", "recent-unwrapped", "--lines", "60"],
  ])
})

test("an unknown agent status reads as missing, like the list path", async () => {
  const h = makeHerdr(async () => ({ result: { agent: { agent_status: "wat" } } }), async () => "")
  expect(await h.agentStatus("w6:t2:p1")).toBe("missing")
})
