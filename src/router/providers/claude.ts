import type { AccountConfig, AccountUsage, UsageReader, Window } from "../../types"
import { CLAUDE_WINDOW_MINUTES, checkWindows } from "../window"
import { expandHome } from "../../paths"
import { renameSync, writeFileSync, readFileSync, unlinkSync, statSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
export const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
// The public OAuth client id the CLI itself uses. Overridable per account via
// oauthClientId; verify it against a live refresh before trusting a fleet to it.
export const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
// Access tokens live 8 hours. Refresh inside the last 10 minutes so a tick never
// starts a read against a token that expires mid-flight.
export const REFRESH_MARGIN_MS = 10 * 60_000
// The usage endpoint answers about 5 calls per token per minute, and that
// budget is not ours alone: an interactive claude spends it on its status
// line, `c` spends it on its account table, and two workspaces tick in the
// same minute. So the answer is cached in the account's own config dir, in
// the format `c` reads and writes, and whoever asks first pays for everyone.
export const USAGE_TTL_MS = 60_000
// A 429 is that burst limit, not a quota. Asking again a minute later just
// draws from the same empty bucket, so hold off longer.
export const USAGE_429_TTL_MS = 5 * 60_000

export interface Creds {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshTokenExpiresAt?: number
}

export interface ClaudeDeps {
  readCreds(configDir: string): Promise<Creds | null>
  refresh(c: Creds, clientId: string, configDir: string): Promise<Creds>
  // configDir only so the live implementation can share its answer through
  // that account's cache. A reader that has its own source ignores it.
  getUsage(token: string, configDir: string): Promise<{ status: number; body: any }>
}

export interface CachedUsage {
  at: number
  status: number
  body: any
}

export const usageCachePath = (configDir: string): string =>
  `${expandHome(configDir)}/cache/usage.json`

export function readUsageCache(configDir: string, now: number): CachedUsage | null {
  let c: CachedUsage
  try {
    c = JSON.parse(readFileSync(usageCachePath(configDir), "utf8"))
  } catch {
    // Absent, or half-written by a reader that lost the race. Both mean ask.
    return null
  }
  if (!c?.at || typeof c.status !== "number") return null
  return now - c.at < (c.status === 429 ? USAGE_429_TTL_MS : USAGE_TTL_MS) ? c : null
}

// Body verbatim, because the readers of this file want different parts of it:
// `limits[]` here, `five_hour` in c. Neither has to know about the other.
export function writeUsageCache(configDir: string, entry: CachedUsage): void {
  const path = usageCachePath(configDir)
  // Unique per writer, for the reason spelled out in writeCreds.
  const tmp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // A cache we cannot write costs a call, not a tick.
    try { unlinkSync(tmp) } catch {}
  }
}

// Atomic: a torn credentials file locks the account out until a human logs in
// interactively. Written beside the target so the rename cannot cross devices,
// and merged into the existing document so unrelated keys survive.
export function writeCreds(configDir: string, creds: Creds): void {
  const path = `${expandHome(configDir)}/.credentials.json`
  const doc = JSON.parse(readFileSync(path, "utf8"))
  doc.claudeAiOauth = {
    ...doc.claudeAiOauth,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }
  // Unique per writer: two ticks can refresh the same account in the same
  // minute (accounts are global config, shared across workspaces). A shared
  // tmp name lets one process rename the other's still-empty file over
  // .credentials.json - the exact torn-file lockout this function exists to
  // prevent, and the rename makes it durable.
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: statSync(path).mode & 0o777 })
    renameSync(tmp, path)
  } catch (err) {
    // A leftover temp file here still carries a live access token.
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

const no = (reason: string): AccountUsage => ({ readable: false, reason })

// A window that has never started has nothing to reset, so a brand new login
// answers 200 with no window carrying a resets_at. That is an account with no
// usage yet, not a broken one, and the router admits one worker on it rather
// than skipping it forever: nothing else on the box will record the first
// window for it.
const fresh = (reason: string): AccountUsage => ({ readable: false, reason, fresh: true })

function resetsAtOf(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null
  const d = typeof raw === "number" ? new Date(raw * 1000) : new Date(String(raw))
  return Number.isNaN(d.getTime()) ? null : d
}

export function makeClaudeReader(d: ClaudeDeps): UsageReader {
  return async (a: AccountConfig, now: Date): Promise<AccountUsage> => {
    const clientId = a.oauthClientId ?? DEFAULT_CLIENT_ID
    const stored = await d.readCreds(a.configDir)
    if (!stored) return no(`no credentials in ${a.configDir}`)

    let creds = stored
    if (creds.expiresAt - now.getTime() <= REFRESH_MARGIN_MS) {
      try {
        creds = await d.refresh(creds, clientId, a.configDir)
      } catch (err) {
        // An account held in reserve for headroom is refreshed by nobody else,
        // so it goes blind within a day and the ranking inverts against the
        // router's own purpose. Report the reason rather than a bare failure.
        return no(`refresh failed: ${err}`)
      }
    }

    let res = await d.getUsage(creds.accessToken, a.configDir)
    if (res.status === 401) {
      try {
        creds = await d.refresh(creds, clientId, a.configDir)
      } catch (err) {
        return no(`refresh after 401 failed: ${err}`)
      }
      res = await d.getUsage(creds.accessToken, a.configDir)
      if (res.status === 401) return no("401 after refresh")
    }
    // Unreadable, and nothing stronger. A 429 here is the metering endpoint's
    // own burst budget, which anything else polling this account can spend on
    // our behalf, and it says nothing about quota: an account measured at 3%
    // of its session and 39% of its week answers 429 on the fifth call in a
    // minute. Real exhaustion arrives as a 200 with the windows at 100%.
    if (res.status === 429) return no("429 from the usage endpoint (burst limit, not quota)")
    if (res.status !== 200) return no(`usage endpoint ${res.status}`)

    const windows: Window[] = []
    for (const l of (res.body?.limits ?? []) as any[]) {
      const resetsAt = resetsAtOf(l.resets_at)
      if (!resetsAt) continue
      const windowMinutes = CLAUDE_WINDOW_MINUTES[l.kind]
      // Never let windowMinutes be undefined: it makes every arithmetic result
      // NaN, every comparison false, and the account permanently ineligible
      // while the log says STARVED forever.
      if (windowMinutes === undefined) {
        throw new Error(`unrecognized usage window kind "${l.kind}" for account "${a.id}"`)
      }
      const model = l.scope?.model
      if (model && a.model && model !== a.model) continue
      windows.push({
        kind: String(l.kind),
        group: String(l.group ?? l.kind),
        percent: Number(l.percent),
        resetsAt,
        windowMinutes,
        scope: l.scope,
        observedAt: now,
      })
    }

    if (windows.length === 0) return fresh("no usage windows yet, nothing has run on this account")
    const bad = checkWindows(windows, now)
    return bad ? no(bad) : { readable: true, windows }
  }
}

export function liveClaudeDeps(live = false): ClaudeDeps {
  return {
    async readCreds(configDir) {
      const f = Bun.file(`${expandHome(configDir)}/.credentials.json`)
      if (!(await f.exists())) return null
      const o = (await f.json())?.claudeAiOauth
      if (!o?.accessToken || !o?.refreshToken) return null
      return {
        accessToken: String(o.accessToken),
        refreshToken: String(o.refreshToken),
        expiresAt: Number(o.expiresAt ?? 0),
        refreshTokenExpiresAt: o.refreshTokenExpiresAt ? Number(o.refreshTokenExpiresAt) : undefined,
      }
    },
    async refresh(c, clientId, configDir) {
      const r = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: c.refreshToken,
          client_id: clientId,
        }),
      })
      if (!r.ok) throw new Error(`token endpoint ${r.status}`)
      const j: any = await r.json()
      const next = {
        accessToken: String(j.access_token),
        refreshToken: c.refreshToken,
        expiresAt: Date.now() + Number(j.expires_in ?? 0) * 1000,
        refreshTokenExpiresAt: c.refreshTokenExpiresAt,
      }
      // A dry run keeps the refreshed token in memory: refresh tokens are not
      // rotated, so the stored one keeps working and the file stays the live
      // agent's to own. A live run writes it back, because an account nobody
      // refreshes goes blind within a day.
      if (live) writeCreds(configDir, next)
      return next
    },
    async getUsage(token, configDir) {
      const hit = readUsageCache(configDir, Date.now())
      if (hit) return { status: hit.status, body: hit.body }

      const r = await fetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      })
      const entry: CachedUsage = {
        at: Date.now(),
        status: r.status,
        body: r.status === 200 ? await r.json() : null,
      }
      // Never cache a 401: it is a fact about this token, not about the
      // account, and the caller refreshes and retries immediately. A cached
      // one would answer that retry with the answer it just refreshed away.
      if (entry.status !== 401) writeUsageCache(configDir, entry)
      return { status: entry.status, body: entry.body }
    },
  }
}
