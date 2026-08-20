import type { UsageReader } from "../../types"

// No usage signal exists: the billing record carries a period boundary and
// zeroed on-demand credits, and the session logs record spend, not remaining.
// Unreadable, and deliberately not exhausted, so allowWhenUnreadable can opt
// the account back in.
export const grokReader: UsageReader = async () => ({
  readable: false,
  reason: "no usage signal exists for this provider",
})
