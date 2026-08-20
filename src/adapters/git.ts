export interface Worktree { path: string; branch: string | null }
export interface Git {
  worktrees(): Promise<Worktree[]>
  remoteSlug(): Promise<string>
  lsRemote(pattern: string): Promise<string[]>
  fetch(): Promise<void>
  worktreeAdd(path: string, branch: string, base: string): Promise<void>
  worktreeRemove(path: string): Promise<void>
  branchDelete(branch: string): Promise<void>
  remoteDelete(branch: string): Promise<void>
}

export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = []
  let path: string | null = null
  let branch: string | null = null
  const flush = () => {
    if (path !== null) out.push({ path, branch })
    path = null
    branch = null
  }
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush()
      path = line.slice("worktree ".length)
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length)
    }
  }
  flush()
  return out
}

// "owner/name" from any origin form: ssh, https, with or without .git. A job
// names a local path, and `gh` wants a slug; deriving it beats configuring the
// same repository twice and getting the two out of step.
export function slugFromRemote(url: string): string {
  const m = url.trim().replace(/\.git$/, "").match(/([^/:]+\/[^/]+)$/)
  if (!m) throw new Error(`cannot read an owner/name out of origin "${url.trim()}"`)
  return m[1]!
}

export function makeGit(runText: (argv: string[]) => Promise<string>, repo: string): Git {
  return {
    async worktrees() {
      return parseWorktrees(await runText(["git", "-C", repo, "worktree", "list", "--porcelain"]))
    },
    async remoteSlug() {
      return slugFromRemote(await runText(["git", "-C", repo, "remote", "get-url", "origin"]))
    },
    async lsRemote(pattern) {
      const out = await runText(["git", "-C", repo, "ls-remote", "--heads", "origin", pattern])
      const prefix = "refs/heads/"
      return out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(prefix)
          return i === -1 ? "" : l.slice(i + prefix.length)
        })
        .filter(Boolean)
    },
    async fetch() {
      await runText(["git", "-C", repo, "fetch", "origin", "--prune"])
    },
    async worktreeAdd(path, branch, base) {
      await runText(["git", "-C", repo, "worktree", "add", "-b", branch, path, base])
    },
    async worktreeRemove(path) {
      // --force because a worker leaves build output behind and a worktree
      // with untracked files is refused otherwise; the sweep has already
      // established that this worktree is finished with.
      await runText(["git", "-C", repo, "worktree", "remove", "--force", path])
    },
    async branchDelete(branch) {
      await runText(["git", "-C", repo, "branch", "-D", branch])
    },
    async remoteDelete(branch) {
      await runText(["git", "-C", repo, "push", "origin", "--delete", branch])
    },
  }
}
