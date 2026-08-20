import type { AccountConfig, AccountUsage } from "./types"

export interface StatusInput {
  now: Date
  accounts: AccountConfig[]
  usageFor: (a: AccountConfig) => Promise<AccountUsage>
  // Null for a provider with no refresh token to expire.
  refreshExpiryFor: (a: AccountConfig) => Promise<Date | null>
  spawnsToday: number
  workspaces: { name: string; paused: string[] }[]
}

export async function renderStatus(o: StatusInput): Promise<string[]> {
  const lines: string[] = []
  for (const a of o.accounts) {
    const usage = await o.usageFor(a).catch((err): AccountUsage => ({ readable: false, reason: String(err) }))
    if (!usage.readable) {
      lines.push(`${a.id}: unreadable (${usage.reason})`)
    } else {
      const windows = usage.windows
        .map((w) => {
          const minutes = Math.max(0, Math.round((w.resetsAt.getTime() - o.now.getTime()) / 60000))
          return `${w.kind} ${w.percent.toFixed(1)}% resets in ${minutes}m`
        })
        .join(", ")
      lines.push(`${a.id}: ${windows}`)
    }
    const expiry = await o.refreshExpiryFor(a).catch(() => null)
    if (expiry) {
      // Refresh tokens are not rotated on refresh, so this ceiling is hard:
      // past it only an interactive login recovers the account.
      const days = Math.floor((expiry.getTime() - o.now.getTime()) / 86400_000)
      lines.push(`${a.id}: refresh token expires in ${days}d`)
    }
  }
  lines.push(`spawns today: ${o.spawnsToday}`)
  for (const w of o.workspaces) {
    lines.push(`${w.name}: paused ${w.paused.length ? w.paused.join(", ") : "nothing"}`)
  }
  return lines
}
