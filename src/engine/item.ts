import type { WorkItem } from "../types"

// The gh adapter stamps every item's id as "<kind>:<number>".
export function itemKind(item: WorkItem): "issue" | "pr" {
  return item.id.startsWith("pr:") ? "pr" : "issue"
}

// gh takes an "owner/name" slug while a job's repo names a local path, so
// the slug is derived from the item's own url. Anchored at the end so the
// path is unambiguous, and host agnostic so a self-hosted forge resolves the
// same way. A missing or unusable url yields null rather than a guess.
const REPO_FROM_URL = /\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+\/?$/

export function ghRepo(item: WorkItem): string | null {
  return item.url?.match(REPO_FROM_URL)?.[1] ?? null
}

// A caller that needs a repo to act (label, comment) has no fallback: an item
// with no usable url is an error to report, not a silent no-op. Shared here
// because spawn's executor needs the identical wrapper.
export function repoOf(item: WorkItem): string {
  const repo = ghRepo(item)
  if (!repo) throw new Error(`item ${item.id} has no url to derive a repo from`)
  return repo
}

// A routine occurrence has no issue and no pull request behind it: the loop's
// own mark and the worktree are its whole record. The writes that label and
// unlabel an item have nothing to address, and must not throw on the way past.
export function trackerless(item: WorkItem): boolean {
  return ghRepo(item) === null
}
