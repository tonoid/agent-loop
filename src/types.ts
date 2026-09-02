export type Provider = "claude" | "codex" | "grok"

export interface AccountConfig {
  id: string
  provider: Provider
  configDir: string
  reserve: number
  // Held back per weekday the human still has before the window resets, on top
  // of the flat reserve, which stays the floor. A weekly quota resetting on
  // Sunday is one working day away, not three.
  reservePerWeekday?: number
  // True when loop workers are the only thing spending this account, which is
  // the one condition under which its usage deltas measure a worker. Nothing
  // else implies it: reserve is about protecting quota, not about who spends it.
  soleConsumer?: boolean
  // What an hour of a Saturday or Sunday is worth against an hour of a weekday,
  // so a weekend keeps a small assignment rather than none. 0.25 by default.
  weekendWeight?: number
  maxConcurrent?: number
  allowWhenUnreadable?: boolean
  // The herdr agent kind this account's workers start. Spelled out rather than
  // `kind`, which names a job's behavior in job.yml.
  agentKind?: string
  startArgs?: string[]
  // The model this account's workers run. Model-scoped usage windows that name
  // a different model are skipped. Unset keeps every scoped window, which is
  // the conservative direction: an extra constraint can only lower concurrency.
  model?: string
  // Overrides the built-in OAuth client id used to refresh this account.
  oauthClientId?: string
  // The environment variable this provider reads its config directory from.
  // Defaults per provider; set it explicitly for a provider whose variable
  // the loop has not verified.
  configEnv?: string
}

export interface NamingConfig {
  labels: { claim: string; failed: string; park: string; priority: string[] }
  mergeMethod: "merge" | "squash"
}

export interface WorkspaceConfig {
  // The state directory key. Explicit rather than derived from the folder,
  // which is called agent-loop in every project.
  name: string
  // The folder holding workspace.yml. Every relative path resolves from here.
  dir: string
  herdrWorkspace: string
  worktreeBase: string
  repos: Record<string, string>
  naming: NamingConfig
  // ~/.agent-loop/<name>/journal.md. Machine-local, so it is derived rather
  // than configured: a path to it in a versioned file would not travel.
  journalPath: string
  jobs: Job[]
}

export interface Config {
  accounts: AccountConfig[]
  // Absolute paths, one per workspace folder. The definitions live at those
  // paths and are read fresh on every tick; see src/discover.ts.
  workspaces: string[]
  maxConcurrentPerAccount: number
  minFreeMb: number
  usageMax: number
  releaseBefore: number
  maxSpawnsPerDay: number
  blockedTimeoutMin: number
  // A hold this old has one notification sent about it. 0 turns it off.
  holdTimeoutMin: number
  // Percentage points per minute per worker, used for a provider/window pair
  // with no measured EWMA yet. Must be > 0.
  workerRateSeed: number
}

export type ItemState = "OPEN" | "CLOSED" | "MERGED"

export interface WorkItem {
  id: string
  number: number
  title: string
  state: ItemState
  labels: string[]
  headRef?: string
  url?: string
  // ISO 8601, as the forge reports it. The filing audit needs a time bound and
  // nothing else in the engine reads it.
  createdAt?: string
}

// herdr's own enum is idle, working, blocked, done, unknown. "done" is herdr
// saying the agent finished and is not coming back on its own, which is a fact
// worth acting on; "unknown" and anything herdr adds later map to "missing",
// which every consumer here treats as no information and holds on.
export type AgentStatus = "working" | "blocked" | "idle" | "done" | "missing"

export interface AgentView {
  cwd: string
  status: AgentStatus
  paneId: string
}

export interface Marks {
  has(job: string, key: string, mark: string): boolean
  age(job: string, key: string, mark: string): number | null
  set(job: string, key: string, mark: string): void
  clear(job: string, key: string, mark: string): void
  gc(olderThanDays: number): number
}

export interface Ctx {
  workspace: WorkspaceConfig
  // Every workspace this process is ticking, so account-scoped facts are
  // counted across the box rather than per workspace (spec 7).
  workspaces: WorkspaceConfig[]
  config: Config
  now: Date
  // Whether this tick may mutate anything at all: the outside world, and
  // agent-loop's own marks. The same flag arms the refusal in adapters/run.ts,
  // so a false here and a mutation attempted anyway is a thrown error, not a
  // silent write. The global database is the exception and records usage
  // samples either way: measuring a quota is not a mutation, and it is what
  // warms the router's rate estimate during a shadow week.
  live: boolean
  // Injected so the worker start dance's retries do not make the suite wait.
  sleep(ms: number): Promise<void>
  lock: import("./lock").LockImpl
  gh: import("./adapters/gh").Gh
  git(repo: string): import("./adapters/git").Git
  herdr: import("./adapters/herdr").HerdrRead
  marks: Marks
  global: import("./globalstate").GlobalStore
  usage(a: AccountConfig): Promise<AccountUsage>
  memAvailableMb(): Promise<number>
  log(d: Decision): void
  cache<T>(key: string, fn: () => Promise<T>): Promise<T>
}

// Backpressure, spec 5.2. Every job that creates work for another declares it,
// and the engine derives the budget from the consumer's depth rather than from
// a constant, so it closes on its own when the pipeline backs up.
export interface FilingConfig {
  // The consumer job whose queue this one feeds.
  queue: string
  maxOpen: number
  perRound: number
  dedupeBy: string
}

export interface Job {
  name: string
  // The job folder. Brief paths resolve from here.
  dir: string
  // Spawn walk order, ties broken by name. Reviewers before builders, so a
  // merge in this tick relieves the builder's review-debt throttle in the
  // same tick.
  order?: number
  workload: string
  slots?: number
  repo?: string
  // The model this job's workers run, as the agent's own alias or full id.
  // A job-level knob rather than an account one because the router picks the
  // account by headroom: the same job must run the same model wherever it lands.
  model?: string
  sweepIgnoresWorking?: boolean
  // Exempt from maxSpawnsPerDay. The cap is a runaway-loop breaker sized for
  // whichever workspace on the box actually loops, and a scheduled job that
  // spawns a handful of times a day is not what it is aimed at: on 2026-09-02 a
  // builder re-picking one issue every tick spent all 60 by 03:52 and the
  // 04:15 content run never started. Spawns still count, so an exempt job is
  // visible in the day's total and shortens the capped jobs' budget.
  ignoresSpawnCap?: boolean
  deleteRemote?: boolean
  // Selectors: each matches an account by id or by provider.
  requires?: string[]
  prefer?: string[]
  // Demote the account recorded as "built-by:" in this item's PR body.
  distinctFrom?: boolean
  filing?: FilingConfig
  admit?(ctx: Ctx): Promise<string | null>
  discover(ctx: Ctx): Promise<WorkItem[]>
  discoverClaimed(ctx: Ctx): Promise<WorkItem[]>
  key(ctx: Ctx, item: WorkItem): Promise<string>
  attempt?(ctx: Ctx, item: WorkItem): Promise<number>
  guard?(ctx: Ctx, item: WorkItem): Promise<boolean>
  done(ctx: Ctx, item: WorkItem): Promise<boolean>
  sweepOk?(ctx: Ctx, rawKey: string): Promise<boolean>
  // Files copied into a fresh worktree before the worker starts; missing
  // files are ignored and mode is preserved.
  copyIntoWorktree?: string[]
  base?(ctx: Ctx, item: WorkItem): Promise<string>
  prepare?(ctx: Ctx, worktree: string): Promise<void>
  // The brief is the product: what the worker is told to do. Plan 4 ships the
  // default briefs; this plan only delivers whatever the job returns.
  brief(ctx: Ctx, item: WorkItem): Promise<string>
  nudge?(ctx: Ctx, item: WorkItem): Promise<string>
  escalate?(ctx: Ctx, item: WorkItem): Promise<string>
  onFail?(ctx: Ctx, item: WorkItem, transcriptTail: string): Promise<void>
}

export type Decision =
  | { pass: "gc"; removed: number }
  | { pass: "sweep"; job: string; worktree: string; branch: string; action: "clean" | "hold" | "overdue"; reason: string }
  | { pass: "monitor"; job: string; key: string; action: MonitorAction; reason: string }
  | { pass: "spawn"; job: string; key: string; action: "spawn" | "skip"; account?: string; reason: string }
  // The workspace this tick pass covered, or "total" for the whole process:
  // one cron line covers every workspace on the box, and the cadence rule in
  // spec 4.2 has to be read against the sum, not one workspace's share.
  | { pass: "tick"; workspace: string; ms: number }
  | { pass: "error"; job: string; where: "sweep" | "monitor" | "spawn"; reason: string }
  | { pass: "error"; where: "workspace"; workspace: string; reason: string }
  // The filing audit, at sweep time. Advisory in the brief, audited here.
  | { pass: "audit"; job: string; key: string; filed: number; budget: number }
  // Anything a job wants an operator to see that is not a decision about an
  // item: an identity that could not be resolved, a constraint ignored.
  | { pass: "warn"; job: string; reason: string }

export type MonitorAction =
  | "done" | "external" | "busy" | "blocked" | "escalate"
  | "restart" | "nudge" | "fail" | "hold" | "overdue"

export interface Window {
  kind: string          // 'session' | 'weekly_all' | 'w300' | ...
  group: string
  percent: number
  resetsAt: Date
  windowMinutes: number
  scope?: { model?: string }
  observedAt: Date
}

// Unreadable is one state, not two. There was once an `exhausted` variant for
// a 429, on the theory that it proved the account was spent; it proves only
// that the usage endpoint's own burst budget is spent, which anything else
// polling the same account can do on our behalf. An account with no budget
// left says so in a 200, with its windows at 100%. `fresh` is the other
// direction: no window has started, so there is no usage to read rather than
// too much of it, and the account needs one worker before it can be read.
export type AccountUsage =
  | { readable: true; windows: Window[] }
  // `transient` marks a failure of the metering endpoint rather than of the
  // account: the endpoint was busy or briefly broken, and the account itself is
  // fine. Only those may be priced on an older reading, because a stale usage
  // number cannot rescue an account a worker cannot authenticate to. Opt-in on
  // purpose: a new failure mode that forgets to set it costs a skipped tick,
  // and the other default costs a spawned worker that cannot work.
  | { readable: false; reason: string; fresh?: boolean; transient?: boolean }

export type UsageReader = (a: AccountConfig, now: Date) => Promise<AccountUsage>
