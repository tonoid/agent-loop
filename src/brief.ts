import { existsSync, readFileSync } from "node:fs"
import type { Ctx, Job, WorkItem } from "./types"
import { ghRepo } from "./engine/item"
import { worktreePath, branchName } from "./engine/naming"

export type Vars = Record<string, string | number>

export interface BriefLayers {
  // A role file under briefs/, named the way job.yml names it: "default/build".
  extends?: string
  // Shipped opt-in sections, by bare name: briefs/default/<name>.optional.md.
  optional?: string[]
  // The user's own prose, already an absolute path by the time the loader is done.
  append?: string
}

// Beside the sources, so a checkout carries its briefs and no install step
// copies them anywhere.
export const BRIEFS_DIR = `${import.meta.dir}/../briefs`

// Two segments of the safe alphabet. A name reaches the filesystem, so this is
// the whole defence against "../../etc/passwd" arriving from a job.yml.
const BRIEF_NAME = /^[a-z0-9-]+\/[a-z0-9-]+$/

export function briefPath(name: string): string {
  if (!BRIEF_NAME.test(name)) {
    throw new Error(`brief.extends "${name}" must look like default/build`)
  }
  const path = `${BRIEFS_DIR}/${name}.md`
  if (!existsSync(path)) throw new Error(`brief.extends "${name}" names no shipped brief`)
  return path
}

function optionalPath(name: string): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`optional brief section "${name}" is not a name`)
  const path = `${BRIEFS_DIR}/default/${name}.optional.md`
  if (!existsSync(path)) throw new Error(`optional brief section "${name}" names no shipped file`)
  return path
}

// Append, never replace: the fences in core.md are the reason an unattended
// worker is safe, and a user who could replace them would ship an agent that
// force-pushes (spec 8).
export function loadBrief(l: BriefLayers): string {
  const parts = [readFileSync(`${BRIEFS_DIR}/default/core.md`, "utf8")]
  if (l.extends) parts.push(readFileSync(briefPath(l.extends), "utf8"))
  for (const name of l.optional ?? []) parts.push(readFileSync(optionalPath(name), "utf8"))
  if (l.append) {
    if (!existsSync(l.append)) throw new Error(`brief.append "${l.append}" does not exist`)
    parts.push(readFileSync(l.append, "utf8"))
  }
  return parts.map((p) => p.trim()).join("\n\n") + "\n"
}

const VAR = /\{\{([a-zA-Z0-9_.]+)\}\}/g

// Plain substitution and nothing else. A brief is prose, and a template engine
// that can branch is a dependency and a second language to debug at 3am.
export function render(template: string, vars: Vars): string {
  return template.replace(VAR, (whole, name: string) => {
    const v = vars[name]
    return v === undefined ? whole : String(v)
  })
}

export function unresolved(text: string): string[] {
  return [...text.matchAll(VAR)].map((m) => m[1]!)
}

export async function briefVars(
  ctx: Ctx,
  job: Job,
  item: WorkItem,
  key: string,
  extra: Vars = {},
): Promise<Vars> {
  const labels = ctx.workspace.naming.labels
  // The account is what the PR body's "built-by:" line carries, which is what
  // makes distinctFrom (spec 6.4) derive from the outside world. The router has
  // already reserved the row by the time a brief is rendered.
  const account = ctx.global.accountFor(ctx.workspace.name, job.name, key) ?? "unknown"
  return {
    item: `#${item.number}`,
    number: item.number,
    title: item.title,
    itemUrl: item.url ?? "",
    key,
    worktree: worktreePath(ctx.workspace.worktreeBase, job.name, key),
    branch: branchName(job.name, key),
    headRef: item.headRef ?? "",
    base: job.base ? await job.base(ctx, item) : "",
    attempt: job.attempt ? await job.attempt(ctx, item) : 1,
    attemptCap: 0,
    repoSlug: ghRepo(item) ?? "",
    journal: ctx.workspace.journalPath,
    mergeMethod: ctx.workspace.naming.mergeMethod,
    // The kind that merges writes this whole step, because the template has no
    // conditionals. The default is the fail-safe direction: a job that renders
    // a merge step without saying how to merge is not told to merge.
    mergeInstruction: "Do not merge. The merge is not yours to make, so stop here and say so.",
    assetBranch: "assets",
    "labels.claim": labels.claim,
    "labels.failed": labels.failed,
    "labels.park": labels.park,
    filingBudget: 0,
    openQueue: 0,
    dedupeBy: "path",
    account,
    commentPrefix: "",
    passLabel: "",
    ...extra,
  }
}

export async function renderBrief(
  ctx: Ctx,
  job: Job,
  item: WorkItem,
  key: string,
  layers: BriefLayers,
  extra: Vars = {},
): Promise<string> {
  return render(loadBrief(layers), await briefVars(ctx, job, item, key, extra))
}
