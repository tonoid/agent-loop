import type { Ctx, Job, WorkItem } from "../types"

// Every remote read a kind performs is memoized per tick under the job's own
// namespace. Without this the natural implementation puts a list call inside a
// guard and pays one network round trip per candidate: on a repository with 139
// open issues that was roughly 175 seconds in the pick loop alone.
export async function slugOf(ctx: Ctx, job: Job): Promise<string> {
  const path = ctx.workspace.repos[job.repo ?? ""]
  if (!path) throw new Error(`job "${job.name}" has no resolvable repo`)
  return ctx.cache(`job:slug:${path}`, () => ctx.git(path).remoteSlug())
}

export async function issues(ctx: Ctx, job: Job, state: "open" | "all"): Promise<WorkItem[]> {
  const slug = await slugOf(ctx, job)
  return ctx.cache(`job:issues:${slug}:${state}`, () => ctx.gh.issueList({ repo: slug, state }))
}

export async function prs(ctx: Ctx, job: Job, state: "open" | "all"): Promise<WorkItem[]> {
  const slug = await slugOf(ctx, job)
  return ctx.cache(`job:prs:${slug}:${state}`, () => ctx.gh.prList({ repo: slug, state }))
}

// Claimed, failed, and parked items are not candidates: the claim belongs to a
// live worker, the failure is waiting for a human, and the park is a question
// nobody answered.
export function unblocked(ctx: Ctx, items: WorkItem[], extra: string[] = []): WorkItem[] {
  const l = ctx.workspace.naming.labels
  const blocked = new Set([l.claim, l.failed, l.park, ...extra].filter(Boolean))
  return items.filter((i) => !i.labels.some((name) => blocked.has(name)))
}

// Priority labels first, in the order the workspace lists them, then oldest
// first. discover() returns candidates in priority order and the engine takes
// the first eligible without re-sorting, so this ordering is the contract.
export function byPriority(ctx: Ctx, items: WorkItem[]): WorkItem[] {
  const priority = ctx.workspace.naming.labels.priority
  const rank = (i: WorkItem) => {
    const at = priority.findIndex((p) => i.labels.includes(p))
    return at === -1 ? priority.length : at
  }
  return [...items].sort((a, b) => rank(a) - rank(b) || a.number - b.number)
}

// The newest match, so a retried issue's old closed pull request never decides
// anything about the live one working the same key (spec 4.4).
export function newestByHead(items: WorkItem[], head: string): WorkItem | null {
  const mine = items.filter((i) => i.headRef === head)
  return mine.length ? mine.reduce((a, b) => (b.number > a.number ? b : a)) : null
}
