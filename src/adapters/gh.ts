import type { Runner } from "./run"
import type { WorkItem, ItemState } from "../types"

export interface ListArgs { repo: string; state: "open" | "all"; limit?: number; label?: string }
export interface Gh {
  issueList(a: ListArgs): Promise<WorkItem[]>
  prList(a: ListArgs): Promise<WorkItem[]>
  prView(repo: string, ref: string, fields: string[]): Promise<any>
  label(repo: string, kind: "issue" | "pr", number: number, o: { add?: string[]; remove?: string[] }): Promise<void>
  comment(repo: string, kind: "issue" | "pr", number: number, body: string): Promise<void>
  labelsOf(repo: string, kind: "issue" | "pr", number: number): Promise<string[]>
}

// `gh issue list` rejects headRefName, so the two field sets differ.
const PR_FIELDS = "number,title,state,headRefName,labels,url,createdAt"
const ISSUE_FIELDS = "number,title,state,labels,url,createdAt"

// `gh` defaults --limit to 30 and truncates silently past it, with no error
// and no marker in the output. A caller that omits limit still needs every
// claimed item, so we send a high explicit default rather than gh's default.
const DEFAULT_LIMIT = 1000

function toItem(prefix: "pr" | "issue", raw: any): WorkItem {
  return {
    id: `${prefix}:${raw.number}`,
    number: raw.number,
    title: raw.title ?? "",
    state: (raw.state ?? "OPEN") as ItemState,
    labels: (raw.labels ?? []).map((l: any) => l.name),
    headRef: raw.headRefName,
    url: raw.url,
    createdAt: raw.createdAt,
  }
}

// Two runners, not one. The read verbs take --json and are parsed; the write
// verbs print the item's URL on success, so parsing their output as JSON
// throws AFTER the write has already landed. That failure mode is the worst
// available: the label is applied, the caller sees an error, and the item is
// left claimed by a spawn that then rolls back.
export function makeGh(run: Runner, runText: (argv: string[]) => Promise<string>): Gh {
  const listArgv = (kind: "pr" | "issue", a: ListArgs) => {
    const fields = kind === "pr" ? PR_FIELDS : ISSUE_FIELDS
    const argv = ["gh", kind, "list", "--repo", a.repo, "--state", a.state, "--json", fields]
    argv.push("--limit", String(a.limit ?? DEFAULT_LIMIT))
    if (a.label) argv.push("--label", a.label)
    return argv
  }
  return {
    async issueList(a) {
      const raw = await run(listArgv("issue", a))
      return (raw as any[]).map((r) => toItem("issue", r))
    },
    async prList(a) {
      const raw = await run(listArgv("pr", a))
      return (raw as any[]).map((r) => toItem("pr", r))
    },
    async prView(repo, ref, fields) {
      return run(["gh", "pr", "view", ref, "--repo", repo, "--json", fields.join(",")])
    },
    async label(repo, kind, number, o) {
      const argv = [kind, "edit", String(number), "--repo", repo]
      if (o.add?.length) argv.push("--add-label", o.add.join(","))
      if (o.remove?.length) argv.push("--remove-label", o.remove.join(","))
      // Nothing to change is not an error, and an edit with neither flag is.
      if (argv.length === 5) return
      await runText(["gh", ...argv])
    },
    async comment(repo, kind, number, body) {
      await runText(["gh", kind, "comment", String(number), "--repo", repo, "--body", body])
    },
    async labelsOf(repo, kind, number) {
      const r = await run(["gh", kind, "view", String(number), "--repo", repo, "--json", "labels"])
      return ((r as any)?.labels ?? []).map((l: any) => l.name)
    },
  }
}
