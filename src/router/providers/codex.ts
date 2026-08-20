import { Database } from "bun:sqlite"
import { readdirSync } from "node:fs"
import type { AccountConfig, AccountUsage, UsageReader, Window } from "../../types"
import { checkWindows } from "../window"
import { expandHome } from "../../paths"

// Far enough back to cross a quiet weekend, short enough that a cold cache
// costs a handful of file reads rather than a directory walk.
export const ROLLOUT_SCAN_LIMIT = 20

export interface CodexDeps {
  indexPath(configDir: string): string | null
  recentRollouts(indexPath: string, limit: number): string[]
  readLines(path: string): Promise<string[]>
}

const no = (reason: string): AccountUsage => ({ readable: false, reason })

function windowsFrom(rl: any, observedAt: Date): Window[] {
  const out: Window[] = []
  for (const slot of [rl?.primary, rl?.secondary]) {
    if (!slot || slot.window_minutes == null || slot.resets_at == null) continue
    const minutes = Number(slot.window_minutes)
    out.push({
      // Keyed on the window's own length, never on the slot name: the
      // primary/secondary mapping is not stable across accounts or versions,
      // and a slot-keyed EWMA silently compares two different windows.
      kind: `w${minutes}`,
      group: String(rl.limit_id ?? "codex"),
      percent: Number(slot.used_percent),
      resetsAt: new Date(Number(slot.resets_at) * 1000), // epoch seconds
      windowMinutes: minutes,
      observedAt,
    })
  }
  return out
}

function lastRateLimits(lines: string[]): { rl: any; observedAt: Date } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes("rate_limits")) continue
    try {
      const ev = JSON.parse(line)
      const rl = ev?.payload?.rate_limits
      if (!rl) continue
      const observedAt = new Date(ev.timestamp)
      if (Number.isNaN(observedAt.getTime())) continue
      return { rl, observedAt }
    } catch {
      continue // a torn last line in a session still being written
    }
  }
  return null
}

export function makeCodexReader(d: CodexDeps): UsageReader {
  return async (a: AccountConfig, now: Date): Promise<AccountUsage> => {
    const index = d.indexPath(a.configDir)
    if (!index) return no(`no session index in ${a.configDir}`)

    for (const path of d.recentRollouts(index, ROLLOUT_SCAN_LIMIT)) {
      const hit = lastRateLimits(await d.readLines(path))
      if (!hit) continue
      const windows = windowsFrom(hit.rl, hit.observedAt)
      if (windows.length === 0) continue
      const bad = checkWindows(windows, now)
      return bad ? no(bad) : { readable: true, windows }
    }
    return no(`no rate_limits event in the ${ROLLOUT_SCAN_LIMIT} newest sessions`)
  }
}

export function liveCodexDeps(): CodexDeps {
  return {
    indexPath(configDir) {
      const dir = expandHome(configDir)
      // A configured account whose codex directory hasn't been created yet
      // (never logged in, or a fresh box) is an unreadable account, not a
      // crash: readdirSync throws ENOENT, and every other failure path in
      // this file returns null so the caller can shape it as { readable:
      // false, reason }.
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return null
      }
      let best: { n: number; path: string } | null = null
      for (const name of names) {
        const m = name.match(/^state_(\d+)\.sqlite$/)
        if (!m) continue
        const n = Number(m[1])
        if (!best || n > best.n) best = { n, path: `${dir}/${name}` }
      }
      return best?.path ?? null
    },
    recentRollouts(indexPath, limit) {
      const db = new Database(indexPath, { readonly: true })
      try {
        // updated_at_ms is a later column and is null on rows written by older
        // versions, where updated_at holds seconds.
        return db
          .query<{ rollout_path: string }, [number]>(
            `SELECT rollout_path FROM threads
             ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC LIMIT ?`,
          )
          .all(limit)
          .map((r) => r.rollout_path)
      } finally {
        db.close()
      }
    },
    async readLines(path) {
      const f = Bun.file(path)
      if (!(await f.exists())) return []
      return (await f.text()).split("\n")
    },
  }
}
