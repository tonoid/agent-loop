import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Ctx } from "./types"

// The journal is markdown at ~/.agent-loop/<workspace>/journal.md, the one file
// the fences let a worker write outside its worktree (spec 8). The engine
// appends to the same file, so the operator reads one story.
export function appendJournal(ctx: Ctx, line: string): void {
  if (!ctx.live) return
  const path = ctx.workspace.journalPath
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${ctx.now.toISOString()} ${line}\n`)
}
