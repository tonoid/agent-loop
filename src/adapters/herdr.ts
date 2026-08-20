import type { Runner } from "./run"
import type { AgentView, AgentStatus } from "../types"

export interface PaneView { cwd: string; paneId: string; tabId: string }
export interface WorkspaceView { id: string; label: string }

export interface TabCreateArgs {
  workspaceId: string
  cwd: string
  label: string
  env: Record<string, string>
}

export interface AgentStartArgs {
  pane: string
  kind: string
  name: string
  args: string[]
}

export interface Herdr {
  agents(): Promise<AgentView[]>
  panes(): Promise<PaneView[]>
  protocol(): Promise<number>
  workspaces(): Promise<WorkspaceView[]>
  tabCreate(o: TabCreateArgs): Promise<void>
  tabClose(tabId: string): Promise<void>
  agentStart(o: AgentStartArgs): Promise<void>
  agentPrompt(target: string, text: string, o?: { until?: string; timeoutMs?: number }): Promise<void>
  agentSendKeys(target: string, keys: string[]): Promise<void>
  agentRead(target: string, lines: number): Promise<string>
  agentStatus(target: string): Promise<AgentStatus>
  notify(title: string, body: string): Promise<void>
}

export type HerdrRead = Herdr

// The herdr protocol this project was built and tested against. Section 9 of
// the spec: check it, warn loudly on a mismatch, never refuse to run.
export const TESTED_PROTOCOL = 19

const KNOWN: AgentStatus[] = ["working", "blocked", "idle"]

function toStatus(s: unknown): AgentStatus {
  return KNOWN.includes(s as AgentStatus) ? (s as AgentStatus) : "missing"
}

export function makeHerdr(run: Runner): Herdr {
  return {
    async agents() {
      const r = await run(["herdr", "agent", "list"])
      return (r?.result?.agents ?? []).map((a: any) => ({
        cwd: a.cwd,
        status: toStatus(a.agent_status),
        paneId: a.pane_id,
      }))
    },
    async panes() {
      const r = await run(["herdr", "pane", "list"])
      return (r?.result?.panes ?? []).map((p: any) => ({
        cwd: p.cwd,
        paneId: p.pane_id,
        tabId: p.tab_id,
      }))
    },
    async protocol() {
      const r = await run(["herdr", "api", "schema", "--json"])
      return r?.protocol ?? r?.result?.protocol ?? -1
    },
    async workspaces() {
      const r = await run(["herdr", "workspace", "list"])
      return (r?.result?.workspaces ?? []).map((w: any) => ({
        id: w.workspace_id,
        label: w.label,
      }))
    },
    async tabCreate(o) {
      const argv = [
        "herdr", "tab", "create",
        "--workspace", o.workspaceId,
        "--cwd", o.cwd,
        "--label", o.label,
      ]
      // tab create is the only verb that accepts --env, and it is therefore
      // the sole channel by which the router's account choice reaches a worker.
      for (const [k, v] of Object.entries(o.env)) argv.push("--env", `${k}=${v}`)
      argv.push("--no-focus")
      await run(argv)
    },
    async tabClose(tabId) {
      await run(["herdr", "tab", "close", tabId])
    },
    async agentStart(o) {
      const argv = ["herdr", "agent", "start", o.name, "--kind", o.kind, "--pane", o.pane]
      if (o.args.length > 0) argv.push("--", ...o.args)
      await run(argv)
    },
    async agentPrompt(target, text, o) {
      const argv = ["herdr", "agent", "prompt", target, text]
      if (o?.until) argv.push("--wait", "--until", o.until)
      if (o?.timeoutMs !== undefined) argv.push("--timeout", String(o.timeoutMs))
      await run(argv)
    },
    async agentSendKeys(target, keys) {
      await run(["herdr", "agent", "send-keys", target, ...keys])
    },
    async agentRead(target, lines) {
      const r = await run([
        "herdr", "agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines),
      ])
      return String(r?.result?.output ?? "")
    },
    async agentStatus(target) {
      const r = await run(["herdr", "agent", "get", target])
      return toStatus(r?.result?.agent?.agent_status)
    },
    async notify(title, body) {
      await run(["herdr", "notification", "show", title, "--body", body, "--sound", "request"])
    },
  }
}
