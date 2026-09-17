import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { parseConfig } from "./config"
import { discover, loadWorkspace } from "./discover"
import { TESTED_PROTOCOL } from "./adapters/herdr"
import type { Kind } from "./kinds"
import type { AccountConfig } from "./types"

// Injected so the suite can check every branch without a real gh or herdr.
export interface CheckDeps {
  which(bin: string): string | null
  ghAuth(): Promise<boolean>
  protocol(): Promise<number>
  herdrWorkspaces(): Promise<string[]>
  readConfig(path: string): Promise<string | null>
}

// A worker started in a path its agent has never seen opens on a trust prompt,
// reports itself idle behind it, and swallows the brief it is then sent, which
// looks from the log like an agent that simply did not start. Claude records
// trust per project directory and inherits it downwards, so one trusted
// ancestor of worktreeBase covers every worktree ever made under it, and a
// missing one costs every spawn on that account until somebody opens a session
// by hand. A warning rather than a failure: the file belongs to another tool
// and may yet record this differently.
async function trusts(deps: CheckDeps, account: AccountConfig, base: string): Promise<boolean> {
  if (account.provider !== "claude") return true
  const text = await deps.readConfig(`${account.configDir}/.claude.json`)
  if (text === null) return false
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }>
  try {
    projects = JSON.parse(text).projects ?? {}
  } catch {
    return true
  }
  for (let dir = base; ; dir = dirname(dir)) {
    if (projects[dir]?.hasTrustDialogAccepted) return true
    if (dirname(dir) === dir) return false
  }
}

// Two accounts on one Anthropic account is not two pools. The router prices
// every account from its own configDir, so a duplicate reads the same live
// usage twice, hands out two independent budgets, and the box runs both at
// once against one window: on 2026-09-12 simo and 2sync were the same uuid
// with reserves of 10 and 60 held over the same quota, and a `requires` list
// naming one of them fenced nothing, because work admitted to the other spent
// the same account. Silent when the file cannot be read or carries no uuid:
// that file belongs to another tool, and guessing is how the trust check above
// decided to warn rather than fail. A definite match is a definite
// misconfiguration, so it fails.
async function duplicateAccounts(deps: CheckDeps, accounts: AccountConfig[]): Promise<string[]> {
  const byUuid = new Map<string, string[]>()
  for (const account of accounts) {
    if (account.provider !== "claude") continue
    const text = await deps.readConfig(`${account.configDir}/.claude.json`)
    if (text === null) continue
    let uuid: unknown
    try {
      uuid = JSON.parse(text).oauthAccount?.accountUuid
    } catch {
      continue
    }
    if (typeof uuid !== "string" || !uuid) continue
    byUuid.set(uuid, [...(byUuid.get(uuid) ?? []), account.id])
  }
  return [...byUuid.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([uuid, ids]) => `accounts ${ids.join(" and ")} are the same Anthropic account (${uuid}); their budgets and reserves both price one window`)
}

export async function runCheck(o: {
  configPath: string
  workspaceDir?: string
  kinds: Record<string, Kind>
  deps: CheckDeps
}): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = []
  let ok = true
  const fail = (line: string) => { ok = false; lines.push(line) }

  // Cron's environment is nearly empty, and a setup that works in a login
  // shell failing at 2am on PATH is the classic way this breaks.
  for (const bin of ["gh", "git", "herdr"]) {
    if (o.deps.which(bin)) lines.push(`${bin}: ok`)
    else fail(`${bin}: not on PATH`)
  }
  if (await o.deps.ghAuth()) lines.push("gh: authenticated")
  else fail("gh: not authenticated")

  const protocol = await o.deps.protocol().catch(() => -1)
  if (protocol !== TESTED_PROTOCOL) {
    lines.push(`WARN herdr protocol ${protocol}, tested ${TESTED_PROTOCOL}`)
  } else {
    lines.push(`herdr protocol ${protocol}: ok`)
  }

  if (o.workspaceDir) {
    // The one-folder form runs in a service repository's own CI, where there
    // is no machine config and no accounts to check selectors against.
    const { ws, errors } = loadWorkspace(o.workspaceDir, {
      kinds: o.kinds,
      accounts: [],
      checkSelectors: false,
    })
    for (const e of errors) fail(e)
    if (ws) lines.push(`${ws.name}: ${ws.jobs.length} job${ws.jobs.length === 1 ? "" : "s"} (${ws.jobs.map((j) => j.name).join(", ")})`)
    lines.push("skipped: account selectors (no config.yml in this form)")
    return { lines, ok }
  }

  const text = await o.deps.readConfig(o.configPath)
  if (text === null) {
    fail(`no config at ${o.configPath}`)
    return { lines, ok }
  }
  const { config, errors: configErrors } = parseConfig(text)
  for (const e of configErrors) fail(e)
  if (configErrors.length) return { lines, ok }

  // Every spawn resolves the herdr workspace by label, so a label that names
  // nothing throws once per due item forever and never once at configure time.
  // Unreadable is not the same as absent: a herdr that is not running fails
  // every job below anyway, and guessing here would report the wrong one.
  const labels = await o.deps.herdrWorkspaces().then((l) => l, () => null)
  if (labels === null) lines.push("WARN could not ask herdr for its workspaces")

  lines.push(`${config.accounts.length} account${config.accounts.length === 1 ? "" : "s"}: ${config.accounts.map((a) => a.id).join(", ")}`)
  for (const dup of await duplicateAccounts(o.deps, config.accounts)) fail(dup)
  const { workspaces, errors } = discover(config, {
    kinds: o.kinds,
    accounts: config.accounts,
    checkSelectors: true,
  })
  for (const e of errors) fail(e)
  for (const ws of workspaces) {
    lines.push(`${ws.name}: ${ws.jobs.length} job${ws.jobs.length === 1 ? "" : "s"} (${ws.jobs.map((j) => j.name).join(", ")})`)
    // Spec 3.5: check resolves every path. A repos: entry pointing at a folder
    // that was never cloned otherwise passes with exit 0 and then produces an
    // ERROR ... sweep line every two minutes. Only in this form: the one-folder
    // form runs in a service repository's CI, where the sibling trees may
    // legitimately not be checked out.
    for (const [key, path] of Object.entries(ws.repos)) {
      if (!existsSync(path)) fail(`${ws.name}: repo "${key}" at ${path} does not exist`)
      else if (!existsSync(`${path}/.git`)) fail(`${ws.name}: repo "${key}" at ${path} is not a git repository`)
    }
    if (labels !== null && !labels.includes(ws.herdrWorkspace)) {
      fail(`${ws.name}: no herdr workspace labelled "${ws.herdrWorkspace}"${labels.length ? `; herdr has: ${labels.join(", ")}` : "; herdr has none"}`)
    }
    for (const account of config.accounts) {
      if (!(await trusts(o.deps, account, ws.worktreeBase))) {
        lines.push(`WARN ${ws.name}: account ${account.id} has not trusted ${ws.worktreeBase}; a worker there waits on the trust prompt and never reads its brief`)
      }
    }
  }
  return { lines, ok }
}
