import type { Ctx, FilingConfig, Job, WorkItem } from "../types"
import { type Kind, oneOf, unknownKey } from "./validate"
import { issues, prs, unblocked } from "./shared"
import { renderBrief } from "../brief"
import { filingBudget } from "../filing"
import { repoOf } from "../engine/item"

interface Options {
  identity: string
  headRef: string
  rounds: number
  commentPrefix: string
  mergeMode: string
  passLabel: string
  filing?: Record<string, unknown>
  deleteRemote: boolean
  copyIntoWorktree: string[]
  journal: boolean
  subagents: boolean
  screenshots: boolean
}

const IDENTITIES = ["pr", "closing-issue", "head-ref-issue"]
const MERGE_MODES = ["merge", "squash", "none"]
const FILING_KEYS = ["queue", "maxOpen", "perRound", "dedupeBy"]

// "build/b12" and "build/b12-a-title-slug" both name issue 12. Anchored on the
// separator so "b4" cannot be read out of "b48".
const HEAD_ISSUE = /(?:^|\/)b(\d+)(?:-|$)/

export const reviewer: Kind = {
  name: "reviewer",
  workload: "reviewer",
  fields: [
    { name: "identity", type: "string", default: "pr", doc: "what a review is keyed on: pr, closing-issue, or head-ref-issue" },
    { name: "headRef", type: "string", default: "", doc: "only pull requests whose head branch starts with this; empty for every one" },
    { name: "rounds", type: "number", default: 0, doc: "advisory cap on review rounds, passed to the brief, 0 for none" },
    { name: "commentPrefix", type: "string", default: "Review round", doc: "the prefix a round comment starts with" },
    { name: "mergeMode", type: "string", default: "", doc: "merge, squash, none, or empty for the workspace's mergeMethod" },
    { name: "passLabel", type: "string", default: "", doc: "a label that releases the slot while the pull request stays open" },
    { name: "filing", type: "object", doc: "backpressure: queue, maxOpen, perRound, dedupeBy" },
    { name: "deleteRemote", type: "boolean", default: false, doc: "delete the branch on sweep; a review branch is never pushed" },
    { name: "copyIntoWorktree", type: "string[]", default: [], doc: "files copied from the repository into a fresh worktree" },
    { name: "journal", type: "boolean", default: false, doc: "ask the worker to append one line to the journal" },
    { name: "subagents", type: "boolean", default: false, doc: "allow parallel review subagents" },
    { name: "screenshots", type: "boolean", default: false, doc: "allow screenshots on an orphan asset branch" },
  ],

  // Three reviewer variants in production differ in six substantive ways, and
  // every one of them is a state-machine switch rather than a cosmetic. A typo
  // in one of these parses clean and changes what the loop does with a merge,
  // so none of them may be validated by shape alone.
  check(spec) {
    const o = spec.options as unknown as Options
    const errs = [...oneOf("identity", String(o.identity ?? ""), IDENTITIES)]
    if (o.mergeMode && !MERGE_MODES.includes(o.mergeMode)) {
      errs.push("options.mergeMode must be one of merge, squash, none, or empty for the workspace default")
    }
    // Nothing merges and nothing releases the claim, so the item is claimed
    // forever and the slot never comes back.
    if (o.mergeMode === "none" && !o.passLabel) {
      errs.push("options.mergeMode none requires a passLabel, which is the only thing left that releases the item")
    }
    if (o.filing) {
      for (const key of Object.keys(o.filing)) {
        if (!FILING_KEYS.includes(key)) errs.push(`options.filing: ${unknownKey(key, FILING_KEYS)}`)
      }
      if (typeof o.filing.queue !== "string" || !o.filing.queue) {
        errs.push("options.filing.queue is required and must name the consumer job")
      }
      for (const key of ["maxOpen", "perRound"]) {
        if (typeof o.filing[key] !== "number") errs.push(`options.filing.${key} is required and must be a number`)
      }
      if (o.filing.dedupeBy !== undefined && typeof o.filing.dedupeBy !== "string") {
        errs.push("options.filing.dedupeBy must be a string")
      }
    }
    return errs
  },

  build(spec) {
    const o = spec.options as unknown as Options
    const optional = [
      o.journal ? "journal" : "",
      o.subagents ? "subagents" : "",
      o.screenshots ? "screenshots" : "",
    ].filter(Boolean)
    // The loader does not look inside an object option, so the one filing
    // value with a default gets it here, beside the check that validates it.
    const filing = o.filing
      ? ({ dedupeBy: "path", ...o.filing } as unknown as FilingConfig)
      : undefined

    const numberOf = (rawKey: string): number => Number.parseInt(rawKey.replace(/^r/, ""), 10)

    // A repository can hold work this job has no business reviewing, and a
    // reviewer that claims one takes a human's pull request hostage behind its
    // claim label. Two reviewers over one repository split it the same way.
    const inScope = (items: WorkItem[]) =>
      o.headRef ? items.filter((i) => (i.headRef ?? "").startsWith(o.headRef)) : items

    const job: Job = {
      name: spec.name,
      dir: spec.dir,
      repo: spec.repo,
      workload: "reviewer",
      deleteRemote: o.deleteRemote,
      copyIntoWorktree: o.copyIntoWorktree,
      filing,

      async discover(ctx) {
        const open = unblocked(ctx, inScope(await prs(ctx, job, "open")), o.passLabel ? [o.passLabel] : [])
        // First in, first out. The engine takes the first eligible candidate and
        // never re-sorts, so this ordering is an external contract.
        return [...open].sort((a, b) => a.number - b.number)
      },

      async discoverClaimed(ctx) {
        const claim = ctx.workspace.naming.labels.claim
        return inScope(await prs(ctx, job, "all")).filter((i) => i.labels.includes(claim))
      },

      async key(ctx, item) {
        if (o.identity === "pr") return `r${item.number}`
        if (o.identity === "head-ref-issue") {
          const m = item.headRef?.match(HEAD_ISSUE)
          if (m) return `r${m[1]}`
          ctx.log({ pass: "warn", job: job.name, reason: `no issue in head "${item.headRef ?? ""}" for ${item.id}, keying on the pull request` })
          return `r${item.number}`
        }
        const view = await ctx.cache(`job:closing:${item.id}`, () =>
          ctx.gh.prView(repoOf(item), String(item.number), ["closingIssuesReferences"]))
        const closing = view?.closingIssuesReferences?.[0]?.number
        if (typeof closing === "number") return `r${closing}`
        ctx.log({ pass: "warn", job: job.name, reason: `${item.id} closes no issue, keying on the pull request` })
        return `r${item.number}`
      },

      // Counted from the pull request's own comments, with startsWith and never
      // includes: a transcript tail is posted in a fenced block and contains the
      // prefix, which would make every failure look like another round.
      async attempt(ctx, item) {
        if (!o.rounds) return 1
        const view = await ctx.cache(`job:comments:${item.id}`, () =>
          ctx.gh.prView(repoOf(item), String(item.number), ["comments"]))
        const rounds = (view?.comments ?? []).filter((c: any) =>
          String(c?.body ?? "").startsWith(o.commentPrefix)).length
        return rounds + 1
      },

      // The head branch itself is checked out in the builder's worktree and git
      // forbids a second checkout, so a review works a throwaway local branch
      // based on the remote head.
      base: async (_ctx, item) => `origin/${item.headRef ?? ""}`,

      // A pass label is a terminal state that releases the slot while the pull
      // request is still open (continuous integration owns the merge). Merged
      // and closed are handled by the monitor's own state check.
      async done(_ctx, item) {
        return o.passLabel ? item.labels.includes(o.passLabel) : false
      },

      // Frequently a different predicate from done(): done releases the slot,
      // sweepOk tears the worktree down, and tearing it down at the pass label
      // would destroy a run that is still reconciling.
      //
      // A lookup that finds nothing falls through to the pull request branch
      // rather than answering false. key() falls back to the pull request's own
      // number whenever the identity cannot be resolved, and sweepOk cannot know
      // that happened: a key matching no issue is exactly what that fallback
      // produces, so reading it as a pull request number is what the fallback
      // means. Answering false instead leaks the worktree, the branch and the
      // tab forever.
      async sweepOk(ctx, rawKey) {
        const number = numberOf(rawKey)
        if (o.identity === "closing-issue") {
          const issue = (await issues(ctx, job, "all")).find((i) => i.number === number)
          if (issue) return issue.state !== "OPEN"
        }
        if (o.identity === "head-ref-issue") {
          const all = await prs(ctx, job, "all")
          const mine = all.filter((p) => p.headRef?.match(HEAD_ISSUE)?.[1] === String(number))
          const newest = mine.length ? mine.reduce((a, b) => (b.number > a.number ? b : a)) : null
          if (newest) return newest.state !== "OPEN"
        }
        const pr = (await prs(ctx, job, "all")).find((p) => p.number === number)
        return pr !== undefined && pr.state !== "OPEN"
      },

      async brief(ctx, item) {
        const budget = await filingBudget(ctx, job)
        // The brief has no conditionals, so the kind writes the whole verdict
        // step. Under "none" the merge is not the worker's to make, and a brief
        // that said "merge with none" would hand an unattended worker the forge
        // default: the merge the operator set this option to prevent.
        const method = o.mergeMode === "none" ? "" : o.mergeMode || ctx.workspace.naming.mergeMethod
        const mergeInstruction = method
          ? `Merge with \`${method}\`, then poll the merge state until it is definitive. A state of UNKNOWN is not a merge; keep polling.`
          : `The merge is not yours to make. Apply the \`${o.passLabel}\` label instead, and do not merge. Continuous integration owns the merge from there.`
        return renderBrief(ctx, job, item, await job.key(ctx, item), {
          extends: spec.brief?.extends ?? "default/review",
          optional,
          append: spec.brief?.append,
        }, {
          attemptCap: o.rounds,
          filingBudget: budget.filingBudget,
          openQueue: budget.openQueue,
          mergeInstruction,
          // Never the literal "none": that names an absence of a merge, not a
          // method, and prose elsewhere reads this as a method.
          mergeMethod: method || ctx.workspace.naming.mergeMethod,
          commentPrefix: o.commentPrefix,
          passLabel: o.passLabel,
          dedupeBy: filing?.dedupeBy ?? "path",
        })
      },
    }
    return job
  },
}
