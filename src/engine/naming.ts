import type { Worktree } from "../adapters/git"

export function worktreePath(base: string, job: string, key: string): string {
  return `${base}/wt-${job}-${key}`
}

export function branchName(job: string, key: string): string {
  return `${job}/${key}`
}

export function keyOf(job: string, branch: string | null): string | null {
  if (!branch) return null
  const prefix = `${job}/`
  if (!branch.startsWith(prefix)) return null
  const key = branch.slice(prefix.length)
  return key.length > 0 ? key : null
}

export function owns(job: string, base: string, wt: Worktree): boolean {
  const pathPrefix = `${base}/wt-${job}-`
  if (!wt.path.startsWith(pathPrefix)) return false
  const key = keyOf(job, wt.branch)
  if (key === null) return false
  // The path and the branch must name the same key. A worktree whose checked-out
  // branch has drifted to another key would otherwise be swept under the wrong
  // identity. A trailing "-<slug>" is still the same key, because spawn pre-clean
  // matches worktrees by the "<key>-*" glob and slugged directories are real.
  const suffix = wt.path.slice(pathPrefix.length)
  return suffix === key || suffix.startsWith(`${key}-`)
}

export function matchesCwd(cwd: string, worktree: string): boolean {
  if (cwd === worktree) return true
  if (!cwd.startsWith(worktree)) return false
  const rest = cwd.slice(worktree.length)
  if (rest.startsWith("/")) return true
  // A trailing "-" belongs to a title slug. A digit right after it is treated
  // as a longer key instead (so key "b4" cannot match worktree "b4-8", which
  // belongs to key "b48" or similar). The cost: a worktree whose title slug
  // happens to start with a digit, e.g. "wt-review-r80-2fa-login", fails this
  // match and becomes invisible to monitor and sweep even while a healthy
  // agent is working in it. No slug-vs-key disambiguation exists to fix this
  // without also changing how keys and slugs are told apart elsewhere.
  return rest.startsWith("-") && !/^-\d/.test(rest)
}
