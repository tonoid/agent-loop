import { test, expect } from "bun:test"
import { makeGit } from "../src/adapters/git"

function recorder() {
  const calls: string[][] = []
  return { calls, run: async (argv: string[]) => { calls.push(argv); return "" } }
}

test("every git mutation is scoped with -C and never chdir", async () => {
  const r = recorder()
  const git = makeGit(r.run, "/r")
  await git.fetch()
  await git.worktreeAdd("/b/wt-build-b7", "build/b7", "origin/develop")
  await git.worktreeRemove("/b/wt-build-b7")
  await git.branchDelete("build/b7")
  await git.remoteDelete("build/b7")
  expect(r.calls).toEqual([
    ["git", "-C", "/r", "fetch", "origin", "--prune"],
    ["git", "-C", "/r", "worktree", "add", "-b", "build/b7", "/b/wt-build-b7", "origin/develop"],
    ["git", "-C", "/r", "worktree", "remove", "--force", "/b/wt-build-b7"],
    ["git", "-C", "/r", "branch", "-D", "build/b7"],
    ["git", "-C", "/r", "push", "origin", "--delete", "build/b7"],
  ])
})
