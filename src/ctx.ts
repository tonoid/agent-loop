import type { Ctx, Config, WorkspaceConfig, Decision, Marks, AccountConfig, AccountUsage, UsageReader } from "./types"
import type { GlobalStore } from "./globalstate"
import type { Gh } from "./adapters/gh"
import type { Git } from "./adapters/git"
import type { HerdrRead } from "./adapters/herdr"
import type { LockImpl } from "./lock"
import { dryMarks } from "./state"

export interface CtxOpts {
  workspace: WorkspaceConfig
  // Every discovered workspace, this one included. Account-scoped facts (the
  // in-flight count, and so maxConcurrentPerAccount) are global by spec 7, and
  // one ctx per workspace would shard them: two workspaces would each count to
  // the same cap and the account would get double. Defaults to [workspace].
  workspaces?: WorkspaceConfig[]
  config: Config
  now: Date
  live: boolean
  sleep: (ms: number) => Promise<void>
  lock: LockImpl
  gh: Gh
  gitFor: (repo: string) => Git
  herdr: HerdrRead
  marks: Marks
  global: GlobalStore
  usageFor: UsageReader
  memAvailableMb: () => Promise<number>
  sink: (d: Decision) => void
}

export function makeCtx(o: CtxOpts): Ctx {
  const memo = new Map<string, Promise<unknown>>()
  const cache = <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    const hit = memo.get(key)
    if (hit) return hit as Promise<T>
    const p = fn()
    memo.set(key, p)
    return p
  }
  return {
    workspace: o.workspace,
    workspaces: o.workspaces ?? [o.workspace],
    config: o.config,
    now: o.now,
    live: o.live,
    sleep: o.sleep,
    lock: o.lock,
    gh: o.gh,
    git: o.gitFor,
    herdr: o.herdr,
    // Without --live the marks database is read-only too: see dryMarks. Every
    // entry point into the engine builds its context here, so this is the only
    // place the rule has to hold.
    marks: o.live ? o.marks : dryMarks(o.marks),
    global: o.global,
    // One read per account per tick. Several jobs route in one tick, and a
    // second read would also refresh the token a second time.
    usage: (a: AccountConfig): Promise<AccountUsage> =>
      cache(`engine:usage:${a.id}`, () => o.usageFor(a, o.now)),
    memAvailableMb: o.memAvailableMb,
    log: o.sink,
    cache,
  }
}
