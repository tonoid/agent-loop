import { copyFileSync, existsSync, mkdirSync, statSync, chmodSync } from "node:fs"
import { dirname } from "node:path"
import type { Ctx, Job, WorkItem, AccountConfig } from "../types"
import { owns, keyOf, matchesCwd, worktreePath, branchName } from "../engine/naming"
import { itemKind, repoOf, trackerless } from "../engine/item"
import { withRepoLock } from "../lock"
import { expandHome } from "../paths"
import { startWorker } from "../runtime/worker"

function repoPath(ctx: Ctx, p: Job): string {
  const repo = ctx.workspace.repos[p.repo ?? ""]
  if (!repo) throw new Error(`job "${p.name}" has no resolvable repo`)
  return repo
}

// Idempotent, and it runs on every path. Round two of a multi-round job
// otherwise fails at `worktree add -b` against a path and branch that both
// still exist, and a crash between the claim and the worker start leaves an
// orphan no sweep predicate can match.
export async function preClean(ctx: Ctx, p: Job, key: string): Promise<void> {
  const repo = repoPath(ctx, p)
  const base = ctx.workspace.worktreeBase
  const git = ctx.git(repo)

  // Read fresh rather than through the tick cache: the sweep pass earlier in
  // this same tick may already have removed some of these.
  const worktrees = await git.worktrees()
  const mine = worktrees.filter((wt) => owns(p.name, base, wt) && keyOf(p.name, wt.branch) === key)

  const panes = await ctx.herdr.panes()
  for (const wt of mine) {
    const pane = panes.find((x) => matchesCwd(x.cwd, wt.path))
    if (pane) await ctx.herdr.tabClose(pane.tabId)
  }

  await withRepoLock(repo, ctx.lock, async () => {
    for (const wt of mine) await git.worktreeRemove(wt.path)
    // By computed name rather than per worktree, and last so no worktree still
    // holds it: `mine` only ever contains this key's branch anyway, and a
    // branch whose worktree removal succeeded while its delete failed is listed
    // by nothing here or in the sweep, yet `worktree add -b` refuses forever
    // while it exists. Failure is ignored: usually it simply is not there.
    await git.branchDelete(branchName(p.name, key)).catch(() => {})
  })
}

// The write is checked. Unchecked, a forge 5xx produces a live worker with no
// claim, the item is re-picked next tick, and the second spawn's pre-clean
// removes the first worker's worktree out from under a running agent.
export async function claim(ctx: Ctx, p: Job, item: WorkItem): Promise<boolean> {
  // Nothing to claim, so nothing can fail to stick: the spawn proceeds and the
  // spawned mark is the claim.
  if (trackerless(item)) return true
  const label = ctx.workspace.naming.labels.claim
  const repo = repoOf(item)
  const kind = itemKind(item)
  await ctx.gh.label(repo, kind, item.number, { add: [label] })
  return (await ctx.gh.labelsOf(repo, kind, item.number)).includes(label)
}

export async function unclaim(ctx: Ctx, item: WorkItem): Promise<void> {
  if (trackerless(item)) return
  await ctx.gh.label(repoOf(item), itemKind(item), item.number, {
    remove: [ctx.workspace.naming.labels.claim],
  })
}

export async function createWorktree(
  ctx: Ctx,
  p: Job,
  item: WorkItem,
  key: string,
): Promise<string> {
  if (!p.base) throw new Error(`job "${p.name}" has no base(), so it cannot spawn`)
  const repo = repoPath(ctx, p)
  const path = worktreePath(ctx.workspace.worktreeBase, p.name, key)
  const branch = branchName(p.name, key)
  const from = await p.base(ctx, item)
  const git = ctx.git(repo)

  // Both under the lock: two workspaces ticking the same minute against one
  // repo collide on .git/worktrees/* and index.lock, and a transient git lock
  // failure here would unclaim the item and count a strike against it.
  await withRepoLock(repo, ctx.lock, async () => {
    await git.fetch()
    await git.worktreeAdd(path, branch, from)
  })
  return path
}

export async function prepareWorktree(ctx: Ctx, p: Job, path: string): Promise<void> {
  const repo = repoPath(ctx, p)
  for (const rel of p.copyIntoWorktree ?? []) {
    const src = `${repo}/${rel}`
    // A local env file that does not exist on this box is not a reason to
    // fail the spawn and take the pipeline down with it.
    if (!existsSync(src)) continue
    const dst = `${path}/${rel}`
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    // Preserve the mode: these are usually secrets at 0600, and copyFileSync
    // applies the process umask instead.
    chmodSync(dst, statSync(src).mode & 0o777)
  }
  if (p.prepare) await p.prepare(ctx, path)
}

// tab create is the only verb that accepts --env, so this is the sole channel
// by which the router's account choice reaches a worker.
export const CONFIG_ENV_BY_PROVIDER: Record<string, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME", // unverified: set configEnv on the account before routing real work
}

export const PANE_RETRIES = 5
export const PANE_DELAY_MS = 1000

// The pane appears a moment after the tab, and its id is never cached: herdr
// ids are not stable, and the same logical worker has been seen at four
// different pane ids across four rounds.
export async function paneAt(ctx: Ctx, cwd: string): Promise<string> {
  for (let attempt = 1; attempt <= PANE_RETRIES; attempt++) {
    const panes = await ctx.herdr.panes()
    const pane = panes.find((x) => matchesCwd(x.cwd, cwd))
    if (pane) return pane.paneId
    if (attempt < PANE_RETRIES) await ctx.sleep(PANE_DELAY_MS)
  }
  throw new Error(`no pane appeared at ${cwd} after ${PANE_RETRIES} looks`)
}

export async function startTab(
  ctx: Ctx,
  p: Job,
  item: WorkItem,
  key: string,
  account: AccountConfig,
): Promise<void> {
  const label = ctx.workspace.herdrWorkspace
  // By label, every spawn. A cached id survives exactly until the herdr
  // server restarts, and then points at somebody else's workspace.
  const workspaces = await ctx.herdr.workspaces()
  const ws = workspaces.find((w) => w.label === label)
  if (!ws) throw new Error(`no herdr workspace labelled "${label}"`)

  const cwd = worktreePath(ctx.workspace.worktreeBase, p.name, key)
  const name = `${p.name}-${key}`
  const envVar = account.configEnv ?? CONFIG_ENV_BY_PROVIDER[account.provider] ?? "AGENT_CONFIG_DIR"

  await ctx.herdr.tabCreate({
    workspaceId: ws.id,
    cwd,
    label: name,
    env: { [envVar]: expandHome(account.configDir) },
  })

  await startWorker(ctx, {
    pane: await paneAt(ctx, cwd),
    kind: account.agentKind ?? account.provider,
    name,
    // The account's args say how a worker starts on this account; the job's
    // model says what it should be thinking with. Appended last so a job that
    // names one wins over an account that already passed --model.
    args: [...(account.startArgs ?? []), ...(p.model ? ["--model", p.model] : [])],
    brief: await p.brief(ctx, item),
  })
}

// One bad minute is infrastructure, not a verdict on the work; two on the same
// key is a pattern worth a human's attention.
export const STRIKE_MARK = "spawn-fail"

export async function rollback(ctx: Ctx, p: Job, item: WorkItem, key: string): Promise<void> {
  // Order matters: unclaim first, so a rollback that itself fails half way
  // still leaves the item free for the next tick rather than claimed forever.
  await unclaim(ctx, item)
  await preClean(ctx, p, key)
}

export async function applySpawn(
  ctx: Ctx,
  p: Job,
  item: WorkItem,
  key: string,
  account: AccountConfig,
): Promise<void> {
  // The reservation was taken in the router, before applySpawn ever runs, so
  // any throw from here on out - including a pre-clean that fails or a claim
  // that never sticks - must release it. Otherwise the row stays pending
  // forever and keeps counting against the daily cap with nothing to show
  // for it. A failed claim still means nothing was created, so it stays a
  // skip, not a strike: only the try block below marks strikes.
  try {
    await preClean(ctx, p, key)

    // A failed claim means nothing was created, so this is a skip, not a strike.
    if (!(await claim(ctx, p, item))) {
      throw new Error(`claim did not stick for ${p.name} ${key}, skipping this tick`)
    }
  } catch (err) {
    ctx.global.release(p.name, key, ctx.now)
    throw err
  }

  try {
    const path = await createWorktree(ctx, p, item, key)
    await prepareWorktree(ctx, p, path)
    await startTab(ctx, p, item, key, account)
  } catch (err) {
    await rollback(ctx, p, item, key).catch(() => {
      // A rollback that fails must not replace the original error, which is
      // the one that explains what actually went wrong.
    })
    try {
      ctx.global.release(p.name, key, ctx.now)
    } catch {
      // A release that fails must not replace the original error either, or
      // skip the strike bookkeeping below.
    }
    if (ctx.marks.has(p.name, key, STRIKE_MARK)) {
      const labels = ctx.workspace.naming.labels
      // A routine has no url and so no label to move: its second strike is the
      // mark being cleared and the error being reported, nothing more. And
      // like the rollback and the release above, a label that fails must not
      // replace the original error, which is the one explaining what broke.
      if (!trackerless(item)) {
        await ctx.gh
          .label(repoOf(item), itemKind(item), item.number, {
            add: [labels.failed],
            remove: [labels.claim],
          })
          .catch(() => {})
      }
      ctx.marks.clear(p.name, key, STRIKE_MARK)
    } else {
      ctx.marks.set(p.name, key, STRIKE_MARK)
    }
    throw err
  }

  // Last, and only now: confirming any earlier would attribute quota to a
  // worker that never started and skew the in-flight count for the day.
  ctx.global.confirm(p.name, key, ctx.now)
  ctx.marks.set(p.name, key, "spawned")
  ctx.marks.clear(p.name, key, STRIKE_MARK)
}
