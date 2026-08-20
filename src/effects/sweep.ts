import type { Ctx, Job } from "../types"
import type { Worktree } from "../adapters/git"
import { matchesCwd } from "../engine/naming"
import { withRepoLock } from "../lock"

export async function applySweep(ctx: Ctx, p: Job, wt: Worktree): Promise<void> {
  const repo = ctx.workspace.repos[p.repo ?? ""]
  if (!repo) return

  // By tab id from pane list: a workspace id would close the whole loop
  // workspace and every other worker in it, and a worker whose agent already
  // exited still has a tab, so pane list rather than agent list.
  const panes = await ctx.cache("engine:panes", () => ctx.herdr.panes())
  const pane = panes.find((x) => matchesCwd(x.cwd, wt.path))
  if (pane) await ctx.herdr.tabClose(pane.tabId)

  const git = ctx.git(repo)
  await withRepoLock(repo, ctx.lock, async () => {
    await git.worktreeRemove(wt.path)
    if (wt.branch) {
      await git.branchDelete(wt.branch)
      // Review branches are never pushed, so only a job that pushes asks
      // for the remote side to be deleted.
      if (p.deleteRemote) await git.remoteDelete(wt.branch)
    }
  })
}
