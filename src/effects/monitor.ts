import type { Ctx, Job, WorkItem } from "../types"
import { worktreePath, matchesCwd } from "../engine/naming"
import { itemKind, repoOf, trackerless } from "../engine/item"
import { startWorker } from "../runtime/worker"
import { preClean } from "./spawn"

// The same write as the spawn rollback's. A finished item keeps its claim
// label otherwise, and discoverClaimed reads --state all, so the label would
// count against the job's slots forever.
export { unclaim as applyDone } from "./spawn"

// Panes are resolved by cwd on every use: herdr ids are not stable, and the
// same logical worker has been observed at four different pane ids across
// four review rounds.
export async function paneFor(ctx: Ctx, p: Job, key: string): Promise<string> {
  const wt = worktreePath(ctx.workspace.worktreeBase, p.name, key)
  const panes = await ctx.cache("engine:panes", () => ctx.herdr.panes())
  const pane = panes.find((x) => matchesCwd(x.cwd, wt))
  if (!pane) throw new Error(`no pane at ${wt}`)
  return pane.paneId
}

// The one moment a human is actually wanted: a worker sitting on a question
// nobody will answer. Gated by the "blocked" mark in the engine, so it is once
// per item and not once per tick, and it never throws: a missing notifier must
// not turn a supervised block into a failed pass.
export async function applyNotifyBlocked(
  ctx: Ctx,
  p: Job,
  item: WorkItem,
  key: string,
): Promise<void> {
  const where = item.url ?? `tab ${p.name}-${key}`
  await ctx.herdr
    .notify(
      `${p.name} is blocked`,
      `${p.name} ${key} is waiting on an answer nobody has given it. ${where}`,
    )
    .catch(() => {})
}

export async function applyNudge(ctx: Ctx, p: Job, item: WorkItem, key: string): Promise<void> {
  const text = p.nudge
    ? await p.nudge(ctx, item)
    : `You are still working ${key} and the loop sees no progress. Report where you are, then continue or stop.`
  await ctx.herdr.agentPrompt(await paneFor(ctx, p, key), text)
}

export async function applyEscalate(ctx: Ctx, p: Job, item: WorkItem, key: string): Promise<void> {
  const labels = ctx.workspace.naming.labels
  if (!p.escalate) {
    if (trackerless(item)) {
      // Nothing to park and no human to address, and the engine has already
      // logged the escalation and cleared the blocked mark, so returning here
      // would loop forever: blocked, wait the timeout, escalate nothing. The
      // verdict goes to the job's own onFail, which is what writes the journal.
      if (p.onFail) {
        await p.onFail(ctx, item, "the worker was blocked past the escalation timeout and there is nothing to park")
        return
      }
      // With no onFail either there is nowhere at all to put a verdict. This
      // does nothing, and says so rather than claiming another tier handles it.
      return
    }
    // Without a hook the agent cannot be asked to park itself, so the loop
    // parks the item directly. Freeing the slot is the point: a blocked worker
    // on a single-slot job otherwise means zero throughput until a human
    // wakes up.
    await ctx.gh.label(repoOf(item), itemKind(item), item.number, {
      add: [labels.park],
      remove: [labels.claim],
    })
    return
  }
  await ctx.herdr.agentPrompt(await paneFor(ctx, p, key), await p.escalate(ctx, item))
}

// Enough to carry a stack trace and the command that produced it. This tail is
// the only post-mortem the operator gets.
export const FAIL_TAIL_LINES = 60

function accountFor(ctx: Ctx, p: Job, key: string) {
  const id = ctx.global.accountFor(ctx.workspace.name, p.name, key)
  return ctx.config.accounts.find((a) => a.id === id) ?? null
}

export async function applyRestart(ctx: Ctx, p: Job, item: WorkItem, key: string): Promise<void> {
  const pane = await paneFor(ctx, p, key)
  const account = accountFor(ctx, p, key)
  // The tab's --env already points this pane at an account's config directory
  // and cannot be changed now, so the restart reuses that account's kind and
  // start args. With no spawns row there is nothing to reuse: guessing a kind
  // would start some other provider's agent against the box's default config,
  // outside the router's accounting entirely. Throwing hands the item to the
  // next tick's fail tier instead.
  if (!account) throw new Error(`no account for ${p.name} ${key}: refusing to guess a restart kind`)
  await startWorker(ctx, {
    pane,
    kind: account.agentKind ?? account.provider,
    name: `${p.name}-${key}`,
    args: account.startArgs ?? [],
    brief: await p.brief(ctx, item),
  })
}

export async function applyFail(ctx: Ctx, p: Job, item: WorkItem, key: string): Promise<void> {
  // Read the tail before anything else: closing in on the item can cost the
  // pane, and a post-mortem with no transcript is most of the value gone.
  let tail = ""
  try {
    tail = await ctx.herdr.agentRead(await paneFor(ctx, p, key), FAIL_TAIL_LINES)
  } catch {
    tail = "(no transcript: the pane was already gone)"
  }

  if (p.onFail) {
    await p.onFail(ctx, item, tail)
    // A tracked item's failure is terminal because the failed label takes it
    // out of discovery. A trackerless one has no label to apply: its worktree
    // is its claim, so the worktree is what has to go. Without this the monitor
    // finds the same finished-but-not-done worker on the next tick and fails it
    // again, once every tick until the occurrence rolls, each one a fresh
    // journal line about a run that ended hours ago.
    if (trackerless(item)) await preClean(ctx, p, key)
    return
  }

  if (trackerless(item)) {
    // A job whose items have no tracker representation owes an onFail; without
    // one there is nowhere to put a verdict, and silently labelling nothing
    // would look like success.
    throw new Error(`job "${p.name}" item ${item.id} has no tracker and no onFail to report to`)
  }

  const labels = ctx.workspace.naming.labels
  const repo = repoOf(item)
  const kind = itemKind(item)
  // The label comes first. Without it the item is re-picked and re-spawned
  // every tick forever, and a comment that fails to post must not leave the
  // item live.
  await ctx.gh.label(repo, kind, item.number, { add: [labels.failed], remove: [labels.claim] })
  await ctx.gh.comment(
    repo,
    kind,
    item.number,
    `The loop could not finish this item and has stopped working it.\n\nLast ${FAIL_TAIL_LINES} lines of the worker's transcript:\n\n\`\`\`\n${tail}\n\`\`\`\n\nRemove the \`${labels.failed}\` label to let the loop retry it.`,
  )
}
