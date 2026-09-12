import type { UsageReader } from "../../types"

// The gateway owns the account choice, so there is no account here to price.
// A worker on this provider reaches Anthropic through CLIProxyAPI, which picks
// a credential per request from its own priority chain and cooldown state; the
// directory this account names carries Claude Code's own state and no longer
// says which Anthropic account pays. Reading that directory's usage would
// price one account while the gateway spends another, which is worse than
// reading nothing. Unreadable, so it runs only where allowWhenUnreadable opts
// it back in, and maxConcurrent is what limits it.
export const cpaReader: UsageReader = async () => ({
  readable: false,
  reason: "the gateway routes this account and no local usage describes it",
})
