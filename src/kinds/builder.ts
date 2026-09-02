import type { Job, WorkItem, Ctx } from "../types"
import type { Kind } from "./validate"
import { issues, prs, unblocked, byPriority, newestByHead, humanOwned } from "./shared"
import { renderBrief } from "../brief"
import { branchName } from "../engine/naming"

// The one reading of a closed pull request, shared by guard(), done() and
// sweepOk() because the three have to agree about it: whichever of them reads
// it differently is the one that makes the loop spawn, release and sweep the
// same issue every tick. Human-owned is not a retry: `agent-failed` on a pull
// request is the monitor's tombstone and `needs-human` is a question nobody
// answered, and re-picking either is the loop overruling the human it asked.
function retriable(ctx: Ctx, pr: WorkItem): boolean {
  return pr.state === "CLOSED" && !humanOwned(ctx, pr)
}

interface Options {
  base: string
  reviewDebt: number
  debtIgnoreLabels: string[]
  issueLabel: string
  deleteRemote: boolean
  sweepIgnoresWorking: boolean
  copyIntoWorktree: string[]
  journal: boolean
  screenshots: boolean
}

export const builder: Kind = {
  name: "builder",
  workload: "builder",
  fields: [
    { name: "base", type: "string", default: "origin/main", doc: "the ref new work branches from" },
    { name: "reviewDebt", type: "number", default: 0, doc: "stop taking issues at this many open pull requests, 0 to never stop" },
    { name: "debtIgnoreLabels", type: "string[]", default: [], doc: "labels that mean a pull request is no longer the reviewer's debt, typically a reviewer's passLabel" },
    { name: "issueLabel", type: "string", default: "", doc: "only take issues carrying this label, empty for all of them" },
    { name: "deleteRemote", type: "boolean", default: true, doc: "delete the pushed branch when the work is swept" },
    { name: "sweepIgnoresWorking", type: "boolean", default: true, doc: "sweep even while an agent works, because a merge is definitive here" },
    { name: "copyIntoWorktree", type: "string[]", default: [], doc: "files copied from the repository into a fresh worktree" },
    { name: "journal", type: "boolean", default: false, doc: "ask the worker to append one line to the journal" },
    { name: "screenshots", type: "boolean", default: false, doc: "allow screenshots on an orphan asset branch" },
  ],
  build(spec) {
    const o = spec.options as unknown as Options
    const optional = [o.journal ? "journal" : "", o.screenshots ? "screenshots" : ""].filter(Boolean)

    // One place the key format is written. It names the branch, the worktree
    // and the pull request lookup, so a second spelling of it is a bug that
    // only shows up as work rebuilt from scratch.
    const keyFor = (item: WorkItem): string => `b${item.number}`

    // A pull request whose head is this job's branch for that key, newest
    // first: a retried issue's old closed pull request must not answer for the
    // live one.
    const prFor = async (ctx: Ctx, key: string): Promise<WorkItem | null> =>
      newestByHead(await prs(ctx, job, "all"), branchName(job.name, key))

    const job: Job = {
      name: spec.name,
      dir: spec.dir,
      repo: spec.repo,
      workload: "builder",
      deleteRemote: o.deleteRemote,
      sweepIgnoresWorking: o.sweepIgnoresWorking,
      copyIntoWorktree: o.copyIntoWorktree,

      // The throttle reads the reviewer's queue rather than this job's own
      // item, which is why it is admit() and not guard(). Spec 5.1: the queue
      // is every open pull request a reviewer still owes work on, claimed ones
      // very much included, minus the two states a human owns. Excluding
      // claimed items would count the queue as empty exactly when it is
      // busiest, and two parked items would otherwise deadlock the pipeline
      // forever, the builder throttled and the reviewer idle.
      async admit(ctx) {
        if (!o.reviewDebt) return null
        const l = ctx.workspace.naming.labels
        // debtIgnoreLabels alongside the two the spec names: a pass label is
        // terminal for the reviewer, and under mergeMode none such a pull
        // request stays open until continuous integration merges it, so
        // counting it would throttle the builder on finished work.
        const done = new Set([l.park, l.failed, ...o.debtIgnoreLabels].filter(Boolean))
        const open = (await prs(ctx, job, "open")).filter(
          (p) => !p.labels.some((name) => done.has(name)),
        )
        return open.length >= o.reviewDebt ? `review debt ${open.length}/${o.reviewDebt}` : null
      },

      async discover(ctx) {
        const open = await issues(ctx, job, "open")
        const mine = o.issueLabel ? open.filter((i) => i.labels.includes(o.issueLabel)) : open
        return byPriority(ctx, unblocked(ctx, mine))
      },

      // --state all, per spec 4.5: a claim label left on a closed issue would
      // otherwise never be seen, and its slot would be held forever.
      async discoverClaimed(ctx) {
        const claim = ctx.workspace.naming.labels.claim
        return (await issues(ctx, job, "all")).filter((i) => i.labels.includes(claim))
      },

      key: async (_ctx, item) => keyFor(item),
      base: async () => o.base,

      // done() releases the claim as soon as the pull request exists, and the
      // issue stays open until the merge closes it, so without this the next
      // tick re-picks the issue and the spawn's pre-clean destroys the
      // worktree the reviewer's rounds are still working in.
      guard: async (ctx, item) => {
        const pr = await prFor(ctx, keyFor(item))
        return pr === null || retriable(ctx, pr)
      },

      // The work is over when the pull request exists: what happens to it after
      // that belongs to the reviewer, and holding the claim would count this
      // issue against the builder's slots through every review round.
      //
      // Except for the one pull request guard() re-picks. This read "a pull
      // request exists" until 2026-09-02, when a closed one made the two
      // disagree: the retry was declared finished before its worker had done
      // anything, the claim came off, and the next tick picked the same issue
      // again. 41 workers on one issue in 82 minutes, the box's whole daily
      // spawn budget, and the scheduled routines sharing the box missed their
      // slots behind a cap they had not spent.
      async done(ctx, item) {
        const pr = await prFor(ctx, keyFor(item))
        return pr !== null && !retriable(ctx, pr)
      },

      // Not done: the worktree has to survive until the pull request is
      // finished, because the reviewer's rounds ask the builder's worker for
      // changes in it.
      //
      // With no pull request at all there is nothing to wait for, and a builder
      // that fails opens none: it labels its issue for a human and exits. Read
      // as "no pull request yet" that answered false forever, and a hold never
      // kills, so six dead worktrees and their tabs accumulated on one box in a
      // day while the log carried a HOLD line for each every two minutes. The
      // park and failed labels are the two states a human owns, and a human
      // owning the item is when the machine should let go. The pull request
      // still decides whenever there is one: a failed label on an issue whose
      // pull request is open is a review round that found something, and its
      // worktree is where the next round works.
      async sweepOk(ctx, rawKey) {
        const pr = await prFor(ctx, rawKey)
        // The label on the pull request itself, which is the monitor
        // tombstoning it rather than a review round asking for changes. A
        // failed pull request is out of the reviewer's discovery, so nothing
        // will ever move it and both worktrees wait on a state change only a
        // human can cause: two pairs sat 19 and 21 hours that way, holding
        // 1.4GB of live worker processes between them.
        if (pr !== null && !retriable(ctx, pr)) return pr.state !== "OPEN" || humanOwned(ctx, pr)
        // No pull request, or the one guard() is going to try again: either way
        // the worktree belongs to a run that is not finished. sweepIgnoresWorking
        // is on for builders, so nothing else holds it, and a retry whose fresh
        // worktree is deleted ninety seconds in works in a directory that no
        // longer exists. The issue decides instead: a closed one is out of
        // discover() and a human-owned one is a state only a human can change,
        // so neither is ever picked up again and neither worktree is waiting
        // for anything.
        const number = Number(rawKey.replace(/^\D+/, ""))
        const issue = (await issues(ctx, job, "all")).find((i) => i.number === number)
        return issue !== undefined && (issue.state !== "OPEN" || humanOwned(ctx, issue))
      },

      brief: (ctx, item) =>
        renderBrief(ctx, job, item, keyFor(item), {
          extends: spec.brief?.extends ?? "default/build",
          optional,
          append: spec.brief?.append,
        }),
    }
    return job
  },
}
