import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

// Config paths are written with "~" because a human edits them.
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p
}

// A versioned project folder names its paths relative to itself, so the folder
// works on any box. Absolute and "~" paths still resolve, for the machine file
// and for the rare path that really is machine-specific.
export function resolveFrom(base: string, p: string): string {
  const expanded = expandHome(p)
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}

// Every database, marker, and journal lives here. Overridable so the suite
// never reads or writes the operator's real state.
export function agentLoopHome(): string {
  return process.env.AGENT_LOOP_HOME ?? `${homedir()}/.agent-loop`
}
