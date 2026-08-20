// test/codex-usage.test.ts
import { test, expect } from "bun:test"
import { makeCodexReader } from "../src/router/providers/codex"
import type { CodexDeps } from "../src/router/providers/codex"
import type { AccountConfig } from "../src/types"

const NOW = new Date("2026-08-19T09:00:00Z")
const acct: AccountConfig = { id: "alt", provider: "codex", configDir: "~/.c", reserve: 0 }

const RESETS_5H = Math.floor(new Date("2026-08-19T11:00:00Z").getTime() / 1000)
const RESETS_7D = Math.floor(new Date("2026-08-23T09:00:00Z").getTime() / 1000)

const event = (rl: unknown, at = "2026-08-19T08:50:00Z") =>
  JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", rate_limits: rl } })

function deps(files: Record<string, string[]>, order: string[]): CodexDeps {
  return {
    indexPath: () => "/idx",
    recentRollouts: () => order,
    readLines: async (p) => files[p] ?? [],
  }
}

test("both slots become windows keyed by their own length", async () => {
  const d = deps({
    "/a.jsonl": [
      "{}",
      event({
        limit_id: "codex",
        primary: { used_percent: 40, window_minutes: 10080, resets_at: RESETS_7D },
        secondary: { used_percent: 3, window_minutes: 300, resets_at: RESETS_5H },
      }),
    ],
  }, ["/a.jsonl"])
  const u = await makeCodexReader(d)(acct, NOW)
  expect(u.readable).toBe(true)
  expect(u.readable === true && u.windows).toEqual([
    { kind: "w10080", group: "codex", percent: 40, resetsAt: new Date(RESETS_7D * 1000),
      windowMinutes: 10080, observedAt: new Date("2026-08-19T08:50:00Z") },
    { kind: "w300", group: "codex", percent: 3, resetsAt: new Date(RESETS_5H * 1000),
      windowMinutes: 300, observedAt: new Date("2026-08-19T08:50:00Z") },
  ])
})

test("a null secondary slot is skipped", async () => {
  const d = deps({
    "/a.jsonl": [event({ primary: { used_percent: 1, window_minutes: 300, resets_at: RESETS_5H }, secondary: null })],
  }, ["/a.jsonl"])
  const u = await makeCodexReader(d)(acct, NOW)
  expect(u.readable === true && u.windows.map((w) => w.kind)).toEqual(["w300"])
})

test("the last rate_limits event of the newest rollout wins", async () => {
  const d = deps({
    "/new.jsonl": [
      event({ primary: { used_percent: 1, window_minutes: 300, resets_at: RESETS_5H } }),
      event({ primary: { used_percent: 9, window_minutes: 300, resets_at: RESETS_5H } }),
    ],
    "/old.jsonl": [event({ primary: { used_percent: 50, window_minutes: 300, resets_at: RESETS_5H } })],
  }, ["/new.jsonl", "/old.jsonl"])
  const u = await makeCodexReader(d)(acct, NOW)
  expect(u.readable === true && u.windows[0]!.percent).toBe(9)
})

test("rollouts without any rate_limits event are skipped, not fatal", async () => {
  const d = deps({
    "/empty.jsonl": ["{}", JSON.stringify({ payload: { type: "token_count" } })],
    "/good.jsonl": [event({ primary: { used_percent: 7, window_minutes: 300, resets_at: RESETS_5H } })],
  }, ["/empty.jsonl", "/good.jsonl"])
  const u = await makeCodexReader(d)(acct, NOW)
  expect(u.readable === true && u.windows[0]!.percent).toBe(7)
})

test("no snapshot anywhere is unreadable", async () => {
  const u = await makeCodexReader(deps({}, []))(acct, NOW)
  expect(u).toEqual({ readable: false, reason: "no rate_limits event in the 20 newest sessions" })
})

test("no session index is unreadable", async () => {
  const d: CodexDeps = { indexPath: () => null, recentRollouts: () => [], readLines: async () => [] }
  const u = await makeCodexReader(d)(acct, NOW)
  expect(u.readable).toBe(false)
})

test("a snapshot older than its own window is unreadable", async () => {
  const stale = Math.floor(new Date("2026-08-19T09:30:00Z").getTime() / 1000)
  const d = deps({
    "/a.jsonl": [event({ primary: { used_percent: 1, window_minutes: 300, resets_at: stale } },
      "2026-08-19T01:00:00Z")],
  }, ["/a.jsonl"])
  const u = await makeCodexReader(d)(acct, NOW)
  expect(u.readable).toBe(false)
})
