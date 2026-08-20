import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { Ctx, Job, WorkItem } from "../types"
import type { Kind } from "./validate"
import { renderBrief } from "../brief"
import { owns, keyOf } from "../engine/naming"
import { expandHome } from "../paths"
import { appendJournal } from "../journal"

interface Options {
  at: string[]
  days: string[]
  doneWhen: string
  base: string
  deleteRemote: boolean
  copyIntoWorktree: string[]
  journal: boolean
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

const pad = (n: number) => String(n).padStart(2, "0")
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`

// Deliberately not a cron expression. A real routine is due across a window,
// from its slot until the next one begins and then never, which is what makes a
// slot missed to a reboot fire once on the first tick back inside its window and
// never fire stale afterwards. A cron instant either misses slots after every
// reboot or double-fires them.
export function occurrenceKey(now: Date, at: string[]): string | null {
  const slots = [...at].filter((t) => TIME.test(t)).sort()
  if (!slots.length) return null
  const minutes = now.getHours() * 60 + now.getMinutes()
  const asMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const today = slots.filter((t) => asMinutes(t) <= minutes)
  if (today.length) {
    const slot = today[today.length - 1]!
    return `${stamp(now)}-${slot.replace(":", "")}`
  }
  // Before the first slot of the day: the occurrence still running is
  // yesterday's last one.
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  return `${stamp(yesterday)}-${slots[slots.length - 1]!.replace(":", "")}`
}

// The weekday of the occurrence, not of the clock: before the first slot of the
// day the occurrence still running is yesterday's, and it is yesterday's
// weekday that decides whether it was ever due.
function onDay(key: string, days: string[]): boolean {
  if (!days.length) return true
  const [y, m, d] = [key.slice(0, 4), key.slice(4, 6), key.slice(6, 8)].map(Number)
  return days.includes(DAYS[new Date(y!, m! - 1, d!).getDay()]!)
}

// The occurrence's own completion marker: the artifact the run exists to
// produce. Without one the only signal a routine has is its worktree
// disappearing, and that does not happen until the occurrence rolls, so a run
// that finished at 09:38 would be nudged and then failed for hours.
function donePath(spec: { dir: string }, pattern: string, key: string): string {
  const filled = expandHome(pattern.replaceAll("{{key}}", key))
  return isAbsolute(filled) ? filled : resolve(spec.dir, filled)
}

const itemFor = (key: string, name: string): WorkItem => ({
  // No url, so nothing labels it and nothing comments on it: the loop's own
  // mark and the worktree on disk are the whole record of this run.
  id: `key:${key}`,
  number: 0,
  title: name,
  state: "OPEN",
  labels: [],
})

export const routine: Kind = {
  name: "routine",
  workload: "routine",
  fields: [
    { name: "at", type: "string[]", required: true, doc: "slot times, local, like 09:10; due from the slot until the next one" },
    { name: "days", type: "string[]", default: [], doc: "weekdays the run is due, like mon tue; empty for every day" },
    { name: "doneWhen", type: "string", default: "", doc: "a file, {{key}} substituted, whose existence ends the occurrence" },
    { name: "base", type: "string", default: "origin/main", doc: "the ref the run branches from" },
    { name: "deleteRemote", type: "boolean", default: false, doc: "delete the branch on sweep if the run pushed one" },
    { name: "copyIntoWorktree", type: "string[]", default: [], doc: "files copied from the repository into a fresh worktree" },
    { name: "journal", type: "boolean", default: true, doc: "ask the worker to append one line to the journal" },
  ],

  check(spec) {
    const at = (spec.options.at ?? []) as string[]
    const errs = at.filter((t) => !TIME.test(t)).map((t) => `options.at: "${t}" is not a time of day like 09:10`)
    if (!errs.length && at.length === 0) errs.push("options.at must name at least one time of day")
    for (const d of (spec.options.days ?? []) as string[]) {
      if (!DAYS.includes(d)) errs.push(`options.days: "${d}" is not a weekday like mon`)
    }
    return errs
  },

  build(spec) {
    const o = spec.options as unknown as Options
    const optional = o.journal ? ["journal"] : []
    const keyOfItem = (item: WorkItem) => item.id.replace(/^key:/, "")

    const job: Job = {
      name: spec.name,
      dir: spec.dir,
      repo: spec.repo,
      workload: "routine",
      deleteRemote: o.deleteRemote,
      copyIntoWorktree: o.copyIntoWorktree,

      // The spawned mark is authoritative local state here, not derived: there
      // is no label and no pull request to read it back from (spec 7).
      async discover(ctx) {
        const key = occurrenceKey(ctx.now, o.at)
        if (!key || !onDay(key, o.days)) return []
        return ctx.marks.has(job.name, key, "spawned") ? [] : [itemFor(key, job.name)]
      },

      // Derived from the world after all: a worktree this job owns is a run in
      // flight, whatever the marks say.
      async discoverClaimed(ctx) {
        const repo = ctx.workspace.repos[job.repo ?? ""]
        if (!repo) return []
        // The engine's own worktree cache, not a job: prefix - the sweep pass
        // earlier in this same tick already reads this exact key, so sharing
        // its snapshot is the point, not an accident.
        const worktrees = await ctx.cache(`engine:worktrees:${repo}`, () => ctx.git(repo).worktrees())
        return worktrees
          .filter((wt) => owns(job.name, ctx.workspace.worktreeBase, wt))
          .map((wt) => itemFor(keyOf(job.name, wt.branch)!, job.name))
      },

      key: async (ctx, item) => keyOfItem(item) || occurrenceKey(ctx.now, o.at) || "",
      base: async () => o.base,

      // Done when the worktree is gone, which is the only external record this
      // job has. While it exists the monitor supervises the worker: busy,
      // nudge, then fail, like every other item.
      async done(ctx, item) {
        if (o.doneWhen && existsSync(donePath(spec, o.doneWhen, keyOfItem(item)))) return true
        const claimed = await job.discoverClaimed(ctx)
        return !claimed.some((c) => c.id === item.id)
      },

      // A routine must sweep occurrences that are no longer due, which is a
      // different question from done(): without a completion marker the current
      // occurrence's worktree has to stay until its window closes, because
      // nothing else says the run is over. A doneWhen does say so, and the run
      // that wrote it has no more use for its checkout or its tab: a six-hourly
      // routine that finished at 09:38 would otherwise hold both until 12:10.
      // The sweep checks for a working agent before it asks this, so a marker
      // written mid-run still cannot pull a worktree out from under one.
      async sweepOk(ctx, rawKey) {
        if (o.doneWhen && existsSync(donePath(spec, o.doneWhen, rawKey))) return true
        return rawKey !== occurrenceKey(ctx.now, o.at)
      },

      // The default failure path labels and comments, and there is nothing here
      // to label. The journal is the whole post-mortem, so it gets the tail.
      async onFail(ctx, item, transcriptTail) {
        appendJournal(ctx, `FAIL ${job.name} ${keyOfItem(item)}: ${transcriptTail.split("\n").slice(-5).join(" ").trim()}`)
      },

      brief: (ctx, item) =>
        renderBrief(ctx, job, item, keyOfItem(item), {
          extends: spec.brief?.extends ?? "default/routine",
          optional,
          append: spec.brief?.append,
        }),
    }
    return job
  },
}
