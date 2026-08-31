// test/claude-usage.test.ts
import { test, expect } from "bun:test"
import { makeClaudeReader, REFRESH_MARGIN_MS, usageCachePath, readUsageCache, writeUsageCache } from "../src/router/providers/claude"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaudeDeps, Creds } from "../src/router/providers/claude"
import type { AccountConfig } from "../src/types"

const NOW = new Date("2026-08-19T09:00:00Z")
const acct = (o: Partial<AccountConfig> = {}): AccountConfig => ({
  id: "loop", provider: "claude", configDir: "~/.a", reserve: 0, ...o,
})

const fresh = (): Creds => ({
  accessToken: "at", refreshToken: "rt", expiresAt: NOW.getTime() + 3 * 3600_000,
})

const limit = (o: Record<string, unknown> = {}) => ({
  kind: "session", group: "session", percent: 12,
  resets_at: "2026-08-19T11:00:00Z", ...o,
})

function deps(o: Partial<ClaudeDeps> & { usage?: Array<{ status: number; body: any }> } = {}) {
  const calls = { refresh: 0, usage: 0 }
  const queue = o.usage ?? [{ status: 200, body: { limits: [limit()] } }]
  const d: ClaudeDeps = {
    readCreds: o.readCreds ?? (async () => fresh()),
    refresh: o.refresh ?? (async (c, _clientId, _configDir) => { calls.refresh++; return { ...c, accessToken: "new" } }),
    getUsage: o.getUsage ?? (async () => { calls.usage++; return queue[Math.min(calls.usage - 1, queue.length - 1)]! }),
  }
  return { d, calls }
}

test("a healthy account maps limits[] into windows", async () => {
  const { d } = deps()
  const u = await makeClaudeReader(d)(acct(), NOW)
  expect(u.readable).toBe(true)
  expect(u.readable === true && u.windows).toEqual([
    {
      kind: "session", group: "session", percent: 12,
      resetsAt: new Date("2026-08-19T11:00:00Z"),
      windowMinutes: 300, scope: undefined, observedAt: NOW,
    },
  ])
})

test("a token inside the refresh margin is refreshed before the read", async () => {
  const { d, calls } = deps({
    readCreds: async () => ({ ...fresh(), expiresAt: NOW.getTime() + REFRESH_MARGIN_MS - 1 }),
  })
  await makeClaudeReader(d)(acct(), NOW)
  expect(calls.refresh).toBe(1)
})

test("a 401 refreshes and retries exactly once", async () => {
  const { d, calls } = deps({
    usage: [{ status: 401, body: null }, { status: 200, body: { limits: [limit()] } }],
  })
  const u = await makeClaudeReader(d)(acct(), NOW)
  expect(u.readable).toBe(true)
  expect(calls.refresh).toBe(1)
  expect(calls.usage).toBe(2)
})

test("a second 401 leaves the account unreadable", async () => {
  const { d, calls } = deps({ usage: [{ status: 401, body: null }] })
  const u = await makeClaudeReader(d)(acct(), NOW)
  expect(u).toEqual({ readable: false, reason: "401 after refresh" })
  expect(calls.usage).toBe(2)
})

// A 429 from the usage endpoint is its per-token burst budget, about five
// calls a minute, shared with every interactive claude and every `c` run on
// the box. It once benched the account for the tick with no way back in.
test("a 429 is merely unreadable: it is a burst limit, not a quota", async () => {
  const { d } = deps({ usage: [{ status: 429, body: null }] })
  const u = await makeClaudeReader(d)(acct(), NOW)
  expect(u).toEqual({ readable: false, reason: "429 from the usage endpoint (burst limit, not quota)" })
})

test("the reader hands the config dir to getUsage so the answer can be shared", async () => {
  const seen: string[] = []
  const { d } = deps({
    getUsage: async (_t, configDir) => { seen.push(configDir); return { status: 200, body: { limits: [limit()] } } },
  })
  await makeClaudeReader(d)(acct({ configDir: "~/.claude-loop" }), NOW)
  expect(seen).toEqual(["~/.claude-loop"])
})

// Distinct from a 429: no windows means no usage has been recorded yet, which
// is a brand new login rather than an account that has spent its budget.
test("a payload with no usable windows is fresh, not merely unreadable", async () => {
  const { d } = deps({ usage: [{ status: 200, body: { limits: [] } }] })
  const u = await makeClaudeReader(d)(acct(), NOW)
  expect(u.readable).toBe(false)
  expect(u.readable === false && u.fresh).toBe(true)
})

test("missing credentials are unreadable and never refreshed", async () => {
  const { d, calls } = deps({ readCreds: async () => null })
  const u = await makeClaudeReader(d)(acct(), NOW)
  expect(u.readable).toBe(false)
  expect(calls.refresh).toBe(0)
})

test("an unrecognized kind throws instead of poisoning the arithmetic", async () => {
  const { d } = deps({ usage: [{ status: 200, body: { limits: [limit({ kind: "monthly_all" })] } }] })
  await expect(makeClaudeReader(d)(acct(), NOW)).rejects.toThrow("monthly_all")
})

test("a null reset time is skipped and an all-null payload is unreadable", async () => {
  const { d } = deps({ usage: [{ status: 200, body: { limits: [limit({ resets_at: null })] } }] })
  const u = await makeClaudeReader(d)(acct(), NOW)
  expect(u.readable).toBe(false)
})

test("a window scoped to another model is skipped, the matching one kept", async () => {
  const { d } = deps({
    usage: [{ status: 200, body: { limits: [
      limit({ kind: "weekly_scoped", resets_at: "2026-08-23T09:00:00Z", scope: { model: "other" } }),
      limit({ kind: "weekly_all", resets_at: "2026-08-23T09:00:00Z", percent: 40 }),
    ] } }],
  })
  const u = await makeClaudeReader(d)(acct({ model: "mine" }), NOW)
  expect(u.readable === true && u.windows.map((w) => w.kind)).toEqual(["weekly_all"])
})

test("an insane window makes the whole account unreadable", async () => {
  const { d } = deps({
    usage: [{ status: 200, body: { limits: [limit({ resets_at: "2027-01-01T00:00:00Z" })] } }],
  })
  const u = await makeClaudeReader(d)(acct(), NOW)
  expect(u.readable).toBe(false)
})

// The cache file is the contract with `c`, which reads and writes the same
// path and the same shape. Body verbatim: c reads five_hour, we read limits[].
test("the usage cache lives in the account dir, expires, and holds 429s longer", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-usage-"))
  const at = Date.now()

  expect(usageCachePath(dir)).toBe(`${dir}/cache/usage.json`)
  expect(readUsageCache(dir, at)).toBeNull()

  writeUsageCache(dir, { at, status: 200, body: { limits: [limit()] } })
  expect(readUsageCache(dir, at + 30_000)?.body.limits).toEqual([limit()])
  expect(readUsageCache(dir, at + 90_000)).toBeNull()

  writeUsageCache(dir, { at, status: 429, body: null })
  expect(readUsageCache(dir, at + 90_000)?.status).toBe(429)
  expect(readUsageCache(dir, at + 6 * 60_000)).toBeNull()

  writeFileSync(usageCachePath(dir), "{ torn")
  expect(readUsageCache(dir, at)).toBeNull()

  rmSync(dir, { recursive: true, force: true })
})
