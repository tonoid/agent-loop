import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { makeHerdr } from "../../src/adapters/herdr"
import { makeRunners } from "../../src/adapters/run"
import { sendBrief } from "../../src/runtime/worker"
import type { Ctx } from "../../src/types"

const LIVE = process.env.AGENT_LOOP_LIVE_HERDR === "1"
const WORKSPACE = process.env.AGENT_LOOP_LIVE_WORKSPACE ?? "acme"
const KIND = process.env.AGENT_LOOP_LIVE_KIND ?? "claude"

// Skipped unless explicitly asked for: this is the only test that touches a
// real herdr, and it starts a real agent.
test.skipIf(!LIVE)("a brief actually lands in a real agent's composer", async () => {
  const { runJson } = makeRunners(true)
  const herdr = makeHerdr(runJson)
  const ctx = { herdr, sleep: (ms: number) => Bun.sleep(ms) } as unknown as Ctx

  const ws = (await herdr.workspaces()).find((w) => w.label === WORKSPACE)
  expect(ws, `no herdr workspace labelled "${WORKSPACE}"`).toBeDefined()

  const cwd = mkdtempSync(`${tmpdir()}/agent-loop-live-`)
  const label = `agent-loop-live-${Date.now()}`
  let tabId: string | null = null

  try {
    await herdr.tabCreate({ workspaceId: ws!.id, cwd, label, env: {}, })

    let pane: string | null = null
    for (let i = 0; i < 10 && !pane; i++) {
      const found = (await herdr.panes()).find((p) => p.cwd === cwd)
      if (found) { pane = found.paneId; tabId = found.tabId }
      else await Bun.sleep(1000)
    }
    expect(pane, "no pane appeared for the new tab").toBeTruthy()

    await herdr.agentStart({ pane: pane!, kind: KIND, name: label, args: [] })
    await sendBrief(ctx, pane!, "Reply with the single word ACK and then stop.")

    expect(await herdr.agentStatus(pane!)).toBe("working")
  } finally {
    // A test-body failure is already propagating here; a throw from cleanup
    // must never replace it, so every herdr call in this block is guarded.
    try {
      // tabId is only set once the polling loop above finds the pane; a slow
      // or loaded host can still be creating it when that loop gives up, so
      // give it one more bounded look here before accepting defeat.
      for (let i = 0; i < 10 && !tabId; i++) {
        const found = (await herdr.panes()).find((p) => p.cwd === cwd)
        if (found) tabId = found.tabId
        else await Bun.sleep(1000)
      }
      if (tabId) await herdr.tabClose(tabId)
      else console.warn(`could not resolve a tab to close for label "${label}" in workspace "${WORKSPACE}"; close it by hand`)
    } catch {
      console.warn(`cleanup failed for label "${label}" in workspace "${WORKSPACE}"; close it by hand`)
    }
  }
}, 120_000)
