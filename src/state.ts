import { Database } from "bun:sqlite"
import type { Marks } from "./types"

export interface MarkRow { job: string; key: string; mark: string; at: number }

export interface State extends Marks {
  // Every mark, for `agent-loop adopt --list`. The loop itself never needs the
  // whole table: it asks about one job, key and mark at a time.
  all(): MarkRow[]
  // Test seam: move a mark back in time so gc() can be tested without waiting.
  backdate(job: string, key: string, mark: string, minutes: number): void
  close(): void
}

export function openState(path: string): State {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS marks (
      job TEXT NOT NULL,
      key    TEXT NOT NULL,
      mark   TEXT NOT NULL,
      at     INTEGER NOT NULL,
      PRIMARY KEY (job, key, mark)
    )
  `)
  // A database created before the rename has a `plugin` column, and CREATE
  // TABLE IF NOT EXISTS is a no-op against it, so every statement below would
  // reference a column that does not exist. Marks are a cache the spec says is
  // recoverable, but a loop that throws on every tick is not recovery.
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(marks)").all()
  if (columns.some((c) => c.name === "plugin")) {
    db.exec("ALTER TABLE marks RENAME COLUMN plugin TO job")
  }

  const get = db.query<{ at: number }, [string, string, string]>(
    "SELECT at FROM marks WHERE job = ? AND key = ? AND mark = ?",
  )
  const ins = db.query(
    "INSERT OR IGNORE INTO marks (job, key, mark, at) VALUES (?, ?, ?, ?)",
  )
  const del = db.query("DELETE FROM marks WHERE job = ? AND key = ? AND mark = ?")
  const move = db.query(
    "UPDATE marks SET at = ? WHERE job = ? AND key = ? AND mark = ?",
  )
  const sweep = db.query("DELETE FROM marks WHERE at < ?")
  const list = db.query<MarkRow, []>(
    "SELECT job, key, mark, at FROM marks ORDER BY job, key, mark",
  )

  return {
    has(job, key, mark) {
      return get.get(job, key, mark) !== null
    },
    age(job, key, mark) {
      const row = get.get(job, key, mark)
      if (row === null) return null
      return Math.max(0, Math.round((Date.now() - row.at) / 60000))
    },
    set(job, key, mark) {
      ins.run(job, key, mark, Date.now())
    },
    clear(job, key, mark) {
      del.run(job, key, mark)
    },
    backdate(job, key, mark, minutes) {
      move.run(Date.now() - minutes * 60000, job, key, mark)
    },
    gc(olderThanDays) {
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60000
      return sweep.run(cutoff).changes
    },
    all() {
      return list.all()
    },
    close() {
      db.close()
    },
  }
}

// A mark records that the loop did something: nudged a worker, restarted one,
// spawned an item. A tick without --live does none of those, so persisting the
// mark writes a claim about the world that never happened, and the next tick
// reads it back as history: the second dry tick fails an item the first only
// intended to nudge. It also means the shadow week of the cutover (docs/cutover.md
// phase 1) hands the first live tick a state directory full of stamps nothing
// earned. Writes stay in this process instead, so one tick is still internally
// consistent (the monitor's second visit to an item sees its own first) and
// leaves nothing behind. Reads fall through, so a stamp an operator imported
// still counts.
export function dryMarks<T extends Marks>(inner: T): T {
  const pending = new Map<string, number | null>()
  const id = (job: string, key: string, mark: string) => `${job} ${key} ${mark}`
  const has = (job: string, key: string, mark: string): boolean => {
    const at = pending.get(id(job, key, mark))
    return at === undefined ? inner.has(job, key, mark) : at !== null
  }
  return {
    ...inner,
    has,
    age(job: string, key: string, mark: string) {
      const at = pending.get(id(job, key, mark))
      if (at === undefined) return inner.age(job, key, mark)
      return at === null ? null : Math.max(0, Math.round((Date.now() - at) / 60000))
    },
    set(job: string, key: string, mark: string) {
      // INSERT OR IGNORE in the database above, and the same rule here: a mark
      // that is already there keeps its first timestamp, so the age the monitor
      // reads against the blocked timeout never resets.
      if (has(job, key, mark)) return
      pending.set(id(job, key, mark), Date.now())
    },
    clear(job: string, key: string, mark: string) {
      pending.set(id(job, key, mark), null)
    },
    // The test seam, and the one write here that still reaches the database,
    // for a mark that is only there. Nothing in the loop calls it.
    backdate(job: string, key: string, mark: string, minutes: number) {
      const at = pending.get(id(job, key, mark))
      if (at === undefined || at === null) (inner as Partial<State>).backdate?.(job, key, mark, minutes)
      else pending.set(id(job, key, mark), Date.now() - minutes * 60000)
    },
    // tradeoff: a dry tick collects nothing, so the count is honestly zero.
    // Collection is the one write here that would be harmless, and skipping it
    // keeps the rule one sentence: without --live, this database is read-only.
    gc: () => 0,
  } as T
}
