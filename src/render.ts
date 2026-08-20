import type { Decision } from "./types"
import { IDLE_REASON } from "./engine/spawn"

const WOULD = new Set(["nudge", "escalate", "restart", "fail"])

// A live tick really did the thing, and this line is the only view the operator
// has of the loop: "WOULD sweep" for a worktree that is already gone reads as a
// dry run. Verbs stay uppercase either way, matching DONE and EXTERNAL.
export function renderDecision(d: Decision, live = false): string {
  const would = (verb: string) => (live ? verb.toUpperCase() : `WOULD ${verb}`)
  switch (d.pass) {
    case "gc":
      return `GC ${d.removed} marks`
    case "tick":
      return `TICK ${d.workspace} ${d.ms}ms`
    case "sweep":
      return d.action === "clean"
        ? `${would("sweep")} ${d.job} ${d.worktree} (${d.reason})`
        : `HOLD ${d.job} ${d.worktree} (${d.reason})`
    case "monitor":
      if (d.action === "busy") return `BUSY ${d.job} ${d.key} (${d.reason})`
      if (d.action === "hold") return `HOLD ${d.job} ${d.key} (${d.reason})`
      if (d.action === "blocked") return `BLOCKED ${d.job} ${d.key} (${d.reason})`
      return WOULD.has(d.action)
        ? `${would(d.action)} ${d.job} ${d.key} (${d.reason})`
        : `${d.action.toUpperCase()} ${d.job} ${d.key} (${d.reason})`
    case "spawn":
      if (d.action === "spawn") {
        const on = d.account ? ` on ${d.account}` : ""
        return `${would("spawn")} ${d.job} ${d.key}${on} (${d.reason})`
      }
      return d.reason === IDLE_REASON ? `IDLE ${d.job}` : `SKIP ${d.job} (${d.reason})`
    case "error":
      return d.where === "workspace"
        ? `ERROR workspace ${d.workspace} (${d.reason})`
        : `ERROR ${d.job} ${d.where} (${d.reason})`
    case "audit":
      return `OVERFILED ${d.job} ${d.key} ${d.filed - d.budget} over budget (filed ${d.filed}, perRound ${d.budget})`
    case "warn":
      return `WARN ${d.job} (${d.reason})`
  }
}
