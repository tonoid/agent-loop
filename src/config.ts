import type { AccountConfig, Config, Provider } from "./types"
import { expandHome } from "./paths"
import { unknownKey } from "./kinds"
import { isAbsolute } from "node:path"

const KNOWN_PROVIDERS: Provider[] = ["claude", "codex", "grok"]

// An unknown key is a typo, and a typo here is silent: `reserved: 40` leaves
// the reserve at 0, so the one mechanism keeping the loop out of a human's
// quota disappears with nothing said, and `maxSpawnsPerday: 5` leaves the
// runaway circuit breaker at 200. Rejecting it is what makes `check` catch
// this at the commit that broke it (spec 3.5).
const CONFIG_KEYS = [
  "accounts", "workspaces", "maxConcurrentPerAccount", "minFreeMb", "usageMax",
  "releaseBefore", "maxSpawnsPerDay", "blockedTimeoutMin", "workerRateSeed",
]
const ACCOUNT_KEYS = [
  "id", "provider", "configDir", "reserve", "reservePerWeekday", "weekendWeight", "soleConsumer", "maxConcurrent", "allowWhenUnreadable",
  "agentKind", "startArgs", "model", "oauthClientId", "configEnv",
]

// Clamps have defaults so a working config.yml is accounts plus workspaces.
// Every value here is the one the spec's example carries.
export const DEFAULTS = {
  maxConcurrentPerAccount: 4,
  minFreeMb: 3000,
  usageMax: 90,
  releaseBefore: 120,
  maxSpawnsPerDay: 200,
  blockedTimeoutMin: 180,
  workerRateSeed: 0.35,
} as const

// A selector names an account directly or names every account of a provider.
export function selects(a: AccountConfig, selector: string): boolean {
  return selector === a.id || selector === a.provider
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function num(v: unknown, name: string, dflt: number, errs: string[]): number {
  if (v === undefined || v === null) return dflt
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errs.push(`${name} must be a number`)
    return dflt
  }
  return v
}

function account(raw: unknown, i: number, errs: string[]): AccountConfig | null {
  if (!isRecord(raw)) {
    errs.push(`accounts[${i}] must be a mapping`)
    return null
  }
  const id = typeof raw.id === "string" ? raw.id : ""
  if (!id) {
    errs.push(`accounts[${i}]: id is required`)
    return null
  }
  for (const key of Object.keys(raw)) {
    if (!ACCOUNT_KEYS.includes(key)) errs.push(`account "${id}": ${unknownKey(key, ACCOUNT_KEYS)}`)
  }

  const provider = raw.provider as Provider
  if (!KNOWN_PROVIDERS.includes(provider)) {
    errs.push(
      `account "${id}": unknown provider "${String(raw.provider)}"; known: ${KNOWN_PROVIDERS.join(", ")}`,
    )
  }
  if (typeof raw.configDir !== "string" || !raw.configDir) {
    errs.push(`account "${id}": configDir is required`)
  }
  const reserve = num(raw.reserve, `account "${id}": reserve`, 0, errs)
  if (reserve < 0 || reserve > 100) {
    errs.push(`account "${id}": reserve must be between 0 and 100`)
  }
  const reservePerWeekday = num(raw.reservePerWeekday, `account "${id}": reservePerWeekday`, 0, errs)
  if (reservePerWeekday < 0 || reservePerWeekday > 100) {
    errs.push(`account "${id}": reservePerWeekday must be between 0 and 100`)
  }
  const weekendWeight = num(raw.weekendWeight, `account "${id}": weekendWeight`, 0.25, errs)
  if (weekendWeight < 0 || weekendWeight > 1) {
    errs.push(`account "${id}": weekendWeight must be between 0 and 1`)
  }

  const str = (v: unknown, field: string): string | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== "string") { errs.push(`account "${id}": ${field} must be a string`); return undefined }
    return v
  }

  let allowWhenUnreadable: boolean | undefined
  if (raw.allowWhenUnreadable !== undefined && raw.allowWhenUnreadable !== null) {
    if (typeof raw.allowWhenUnreadable !== "boolean") {
      errs.push(`account "${id}": allowWhenUnreadable must be true or false`)
    } else {
      allowWhenUnreadable = raw.allowWhenUnreadable
    }
  }

  let startArgs: string[] | undefined
  if (raw.startArgs !== undefined && raw.startArgs !== null) {
    if (!Array.isArray(raw.startArgs) || !raw.startArgs.every((s) => typeof s === "string")) {
      errs.push(`account "${id}": startArgs must be a list of strings`)
    } else {
      startArgs = raw.startArgs
    }
  }

  // maxConcurrent stays undefined rather than defaulted: the code downstream
  // distinguishes "unset" from an explicit value, including an invalid one.
  const maxConcurrentNum = num(raw.maxConcurrent, `account "${id}": maxConcurrent`, Number.NaN, errs)
  const maxConcurrent = Number.isNaN(maxConcurrentNum) ? undefined : maxConcurrentNum

  return {
    id,
    provider,
    configDir: expandHome(typeof raw.configDir === "string" ? raw.configDir : ""),
    reserve,
    reservePerWeekday,
    weekendWeight,
    soleConsumer: raw.soleConsumer === true ? true : undefined,
    maxConcurrent,
    allowWhenUnreadable,
    agentKind: str(raw.agentKind, "agentKind"),
    startArgs,
    model: str(raw.model, "model"),
    oauthClientId: str(raw.oauthClientId, "oauthClientId"),
    configEnv: str(raw.configEnv, "configEnv"),
  }
}

// Returns every error rather than throwing at the first, because `check` prints
// them all and an operator fixing one at a time is the slowest possible loop.
export function parseConfig(text: string): { config: Config; errors: string[] } {
  const errs: string[] = []
  let raw: unknown
  try {
    raw = Bun.YAML.parse(text)
  } catch (e) {
    return { config: empty(), errors: [`config is not valid YAML: ${String(e)}`] }
  }
  if (!isRecord(raw)) return { config: empty(), errors: ["config must be a mapping of settings"] }

  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) errs.push(unknownKey(key, CONFIG_KEYS))
  }

  const accounts: AccountConfig[] = []
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    errs.push("accounts must be a non-empty list")
  } else {
    const seen = new Set<string>()
    raw.accounts.forEach((a, i) => {
      const parsed = account(a, i, errs)
      if (!parsed) return
      if (seen.has(parsed.id)) errs.push(`duplicate account id "${parsed.id}"`)
      seen.add(parsed.id)
      accounts.push(parsed)
    })
  }

  const workspaces: string[] = []
  if (!Array.isArray(raw.workspaces) || raw.workspaces.length === 0) {
    errs.push("workspaces must be a non-empty list of paths")
  } else {
    raw.workspaces.forEach((p, i) => {
      if (typeof p !== "string") errs.push(`workspaces[${i}] must be a path`)
      else {
        const expanded = expandHome(p)
        // The path is used as given, from whatever directory cron started the
        // tick in, so a relative one is silently a different folder depending
        // on how the binary was invoked.
        if (!isAbsolute(expanded)) errs.push(`workspaces[${i}] "${p}" must be an absolute path or start with ~`)
        else workspaces.push(expanded)
      }
    })
  }

  const workerRateSeed = num(raw.workerRateSeed, "workerRateSeed", DEFAULTS.workerRateSeed, errs)
  if (!(workerRateSeed > 0)) errs.push("workerRateSeed must be greater than 0")

  return {
    config: {
      accounts,
      workspaces,
      maxConcurrentPerAccount: num(raw.maxConcurrentPerAccount, "maxConcurrentPerAccount", DEFAULTS.maxConcurrentPerAccount, errs),
      minFreeMb: num(raw.minFreeMb, "minFreeMb", DEFAULTS.minFreeMb, errs),
      usageMax: num(raw.usageMax, "usageMax", DEFAULTS.usageMax, errs),
      releaseBefore: num(raw.releaseBefore, "releaseBefore", DEFAULTS.releaseBefore, errs),
      maxSpawnsPerDay: num(raw.maxSpawnsPerDay, "maxSpawnsPerDay", DEFAULTS.maxSpawnsPerDay, errs),
      blockedTimeoutMin: num(raw.blockedTimeoutMin, "blockedTimeoutMin", DEFAULTS.blockedTimeoutMin, errs),
      workerRateSeed,
    },
    errors: errs,
  }
}

function empty(): Config {
  return { accounts: [], workspaces: [], ...DEFAULTS }
}

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`no config at ${path}`)
  const { config, errors } = parseConfig(await file.text())
  if (errors.length) throw new Error(`invalid config at ${path}:\n  ${errors.join("\n  ")}`)
  return config
}
