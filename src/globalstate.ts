// src/globalstate.ts
import { Database } from "bun:sqlite"
import type { Window } from "./types"

export interface UsageSample {
  percent: number
  at: number
}

export interface GlobalStore {
  recordUsage(accountId: string, w: Window): void
  lastUsage(accountId: string, kind: string, beforeMs: number): UsageSample | null
  // The newest row per kind, for an account the reader cannot reach right now.
  // `group` and `scope` are not stored, so what comes back prices a window and
  // does not describe one: group falls back to the kind, and a model scope is
  // gone. Both are read before a window is recorded, never after.
  lastWindows(accountId: string, notBeforeMs: number): Window[]
  rate(provider: string, kind: string): number | null
  observeRate(provider: string, kind: string, sample: number): number
  spawnAdd(accountId: string, workspace: string, job: string, key: string, at: Date): void
  reserve(accountId: string, workspace: string, job: string, key: string, at: Date, cap: number, sinceMs: number): boolean
  confirm(job: string, key: string, at: Date): void
  release(job: string, key: string, at: Date): void
  // Scoped by workspace: job names and item-derived keys collide freely across
  // repos, so two services each running a job called "build" keyed on issue
  // numbers both hold a "b7". Unscoped, a restart in one looks up the other's
  // account and starts the wrong agent kind against the wrong config dir.
  accountFor(workspace: string, job: string, pathKey: string): string | null
  spawnsSince(sinceMs: number): number
  close(): void
}

// One sample moves the estimate a third of the way. High enough to follow a
// model or plan change within a few ticks, low enough that a single noisy
// interval does not swing the whole fleet's concurrency.
export const EWMA_ALPHA = 0.3

export function openGlobalState(path: string): GlobalStore {
  const db = new Database(path)
  migrate(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      account        TEXT NOT NULL,
      kind           TEXT NOT NULL,
      percent        REAL NOT NULL,
      resets_at      INTEGER NOT NULL,
      window_minutes INTEGER NOT NULL,
      at             INTEGER NOT NULL,
      PRIMARY KEY (account, kind, at)
    );
    CREATE TABLE IF NOT EXISTS rates (
      provider TEXT NOT NULL,
      kind     TEXT NOT NULL,
      ewma     REAL NOT NULL,
      samples  INTEGER NOT NULL,
      PRIMARY KEY (provider, kind)
    );
    CREATE TABLE IF NOT EXISTS spawns (
      account   TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT '',
      job       TEXT NOT NULL,
      key       TEXT NOT NULL,
      at        INTEGER NOT NULL,
      pending   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job, key, at)
    );
  `)
  // This database is shared across workspaces (spec section 7), and the
  // router now writes a usage row and a rate EWMA update on every tick, so
  // two workspaces ticking in the same minute will collide on a write lock.
  // Without a busy timeout that is SQLITE_BUSY on a normal day; WAL lets
  // reads and writes overlap and the timeout gives a blocked writer room to
  // wait its turn instead of failing immediately.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `)

  const insUsage = db.query(
    `INSERT OR IGNORE INTO usage (account, kind, percent, resets_at, window_minutes, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const prevUsage = db.query<UsageSample, [string, string, number]>(
    `SELECT percent, at FROM usage
     WHERE account = ? AND kind = ? AND at < ?
     ORDER BY at DESC LIMIT 1`,
  )
  // Bare columns beside MAX(at): SQLite defines them as coming from the row
  // the aggregate chose, which is the whole point here. One row per kind.
  const recentUsage = db.query<
    { kind: string; percent: number; resets_at: number; window_minutes: number; at: number },
    [string, number]
  >(
    `SELECT kind, percent, resets_at, window_minutes, MAX(at) AS at FROM usage
     WHERE account = ? AND at >= ?
     GROUP BY kind`,
  )
  const getRate = db.query<{ ewma: number }, [string, string]>(
    "SELECT ewma FROM rates WHERE provider = ? AND kind = ?",
  )
  const putRate = db.query(
    `INSERT INTO rates (provider, kind, ewma, samples) VALUES (?, ?, ?, 1)
     ON CONFLICT (provider, kind) DO UPDATE SET ewma = ?, samples = samples + 1`,
  )
  const insSpawn = db.query(
    "INSERT OR IGNORE INTO spawns (account, workspace, job, key, at) VALUES (?, ?, ?, ?, ?)",
  )
  const insPending = db.query(
    "INSERT OR IGNORE INTO spawns (account, workspace, job, key, at, pending) VALUES (?, ?, ?, ?, ?, 1)",
  )
  // Scoped by `at`, not just job/key: job names and item-derived keys collide
  // freely across repos, so two workspaces can each hold a distinct pending
  // row for the same (job, key) at different `at` values. Each workspace gets
  // its own `now`, so the instant is what separates them; without the `at`
  // predicate one workspace's confirm or release would match the other's live
  // reservation.
  const setConfirmed = db.query(
    "UPDATE spawns SET pending = 0 WHERE job = ? AND key = ? AND at = ? AND pending = 1",
  )
  const delPending = db.query(
    "DELETE FROM spawns WHERE job = ? AND key = ? AND at = ? AND pending = 1",
  )
  // The exact key, or a directory that carries a title slug after it.
  // A legacy row (no workspace, from before the column existed) never
  // matches here: it carries no workspace to disambiguate, so resolving it
  // for any workspace's query is the cross-workspace collision this column
  // exists to prevent. It still counts toward the daily cap (spawnsSince is
  // workspace-agnostic); it just never hands back an account.
  const findAccount = db.query<{ account: string }, [string, string, string, string]>(
    `SELECT account FROM spawns
     WHERE workspace = ? AND job = ? AND (key = ? OR ? LIKE key || '-%')
     ORDER BY at DESC LIMIT 1`,
  )
  const countSince = db.query<{ n: number }, [number]>(
    "SELECT COUNT(*) AS n FROM spawns WHERE at >= ?",
  )

  return {
    recordUsage(accountId, w) {
      insUsage.run(
        accountId,
        w.kind,
        w.percent,
        w.resetsAt.getTime(),
        w.windowMinutes,
        w.observedAt.getTime(),
      )
    },
    lastUsage(accountId, kind, beforeMs) {
      return prevUsage.get(accountId, kind, beforeMs)
    },
    lastWindows(accountId, notBeforeMs) {
      return recentUsage.all(accountId, notBeforeMs).map((r) => ({
        kind: r.kind,
        group: r.kind,
        percent: r.percent,
        resetsAt: new Date(r.resets_at),
        windowMinutes: r.window_minutes,
        observedAt: new Date(r.at),
      }))
    },
    rate(provider, kind) {
      return getRate.get(provider, kind)?.ewma ?? null
    },
    observeRate(provider, kind, sample) {
      const prev = getRate.get(provider, kind)?.ewma
      const next = prev === undefined ? sample : EWMA_ALPHA * sample + (1 - EWMA_ALPHA) * prev
      putRate.run(provider, kind, next, next)
      return next
    },
    spawnAdd(accountId, workspace, job, key, at) {
      insSpawn.run(accountId, workspace, job, key, at.getTime())
    },
    // tradeoff: nothing reaps an orphaned pending row (one left by a hard
    // kill between reserve and confirm/release). It sits consuming a cap
    // slot until spawnsSince's window rolls past UTC midnight, at which
    // point it stops counting on its own. Add a reaper if that daily
    // self-heal turns out not to be good enough in practice.
    reserve(accountId, workspace, job, key, at, cap, sinceMs) {
      // BEGIN IMMEDIATE takes the write lock before the count, so two
      // workspaces ticking in the same minute cannot both read "one slot left"
      // and both take it.
      db.exec("BEGIN IMMEDIATE")
      try {
        const used = countSince.get(sinceMs)?.n ?? 0
        if (used >= cap) {
          db.exec("ROLLBACK")
          return false
        }
        // OR IGNORE means the insert can silently do nothing (an exact
        // account/job/key/at row already exists), and a caller must not be
        // told it holds a reservation with no row backing it.
        const { changes } = insPending.run(accountId, workspace, job, key, at.getTime())
        db.exec("COMMIT")
        return changes === 1
      } catch (err) {
        try {
          db.exec("ROLLBACK")
        } catch {
          // SQLite may have already rolled back on its own; that must not
          // replace the original error, which is the one that explains what
          // actually went wrong.
        }
        throw err
      }
    },
    confirm(job, key, at) {
      setConfirmed.run(job, key, at.getTime())
    },
    release(job, key, at) {
      // Only a pending row is deletable: a confirmed spawn stays on the record
      // even if a later step decides to tidy up.
      delPending.run(job, key, at.getTime())
    },
    accountFor(workspace, job, pathKey) {
      return findAccount.get(workspace, job, pathKey, pathKey)?.account ?? null
    },
    spawnsSince(sinceMs) {
      return countSince.get(sinceMs)?.n ?? 0
    },
    close() {
      db.close()
    },
  }
}

// A database written before the ledger-to-spawns rename keeps a populated
// `ledger` table, and CREATE TABLE IF NOT EXISTS happily creates an empty
// `spawns` beside it: the daily cap resets to zero, every account reads zero
// in flight and over-admits, and accountFor returns null for every worker
// already running, which throws in applyRestart and tombstones the item on the
// next tick. So the rename happens first, before any CREATE runs.
function migrate(db: Database): void {
  const has = (name: string) =>
    db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name)!.n > 0

  if (has("ledger") && !has("spawns")) {
    db.exec("ALTER TABLE ledger RENAME TO spawns")
    db.exec("ALTER TABLE spawns RENAME COLUMN plugin TO job")
  }
  if (!has("spawns")) return
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(spawns)").all()
  if (!columns.some((c) => c.name === "workspace")) {
    // Pre-existing rows carry no workspace, and the empty string is the
    // honest value for them: accountFor never matches it, so a legacy row
    // still counts toward the daily cap but resolves no account. A worker
    // that was in flight across the upgrade then fails once, restartable by
    // hand, rather than risk resolving the wrong workspace's account.
    db.exec("ALTER TABLE spawns ADD COLUMN workspace TEXT NOT NULL DEFAULT ''")
  }
}
