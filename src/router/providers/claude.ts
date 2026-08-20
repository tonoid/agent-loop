import type { AccountConfig, AccountUsage, UsageReader, Window } from "../../types"
import { CLAUDE_WINDOW_MINUTES, checkWindows } from "../window"
import { expandHome } from "../../paths"
import { renameSync, writeFileSync, readFileSync, unlinkSync, statSync } from "node:fs"

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
export const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
// The public OAuth client id the CLI itself uses. Overridable per account via
// oauthClientId; verify it against a live refresh before trusting a fleet to it.
export const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
// Access tokens live 8 hours. Refresh inside the last 10 minutes so a tick never
// starts a read against a token that expires mid-flight.
export const REFRESH_MARGIN_MS = 10 * 60_000

export interface Creds {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshTokenExpiresAt?: number
}

export interface ClaudeDeps {
  readCreds(configDir: string): Promise<Creds | null>
  refresh(c: Creds, clientId: string, configDir: string): Promise<Creds>
  getUsage(token: string): Promise<{ status: number; body: any }>
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

const no = (reason: string, exhausted?: boolean): AccountUsage =>
  exhausted ? { readable: false, reason, exhausted } : { readable: false, reason }

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

    let res = await d.getUsage(creds.accessToken)
    if (res.status === 401) {
      try {
        creds = await d.refresh(creds, clientId, a.configDir)
      } catch (err) {
        return no(`refresh after 401 failed: ${err}`)
      }
      res = await d.getUsage(creds.accessToken)
      if (res.status === 401) return no("401 after refresh")
    }
    // Exhausted is strictly more information than unknown, and unlike every
    // other unreadable state allowWhenUnreadable must not resurrect it.
    if (res.status === 429) return no("429 from the usage endpoint", true)
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

    if (windows.length === 0) return no("no usable limit windows in the payload")
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
    async getUsage(token) {
      const r = await fetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      })
      return { status: r.status, body: r.status === 200 ? await r.json() : null }
    },
  }
}
