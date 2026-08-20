import type { Ctx, Job, Marks, WorkItem } from "./types"
import type { MarkRow } from "./state"

// A routine's key() falls back to the occurrence due right now when the item
// carries no key of its own, which is exactly the stamp a cutover imports.
const BLANK: WorkItem = { id: "", number: 0, title: "", state: "OPEN", labels: [] }

// The cutover's one import path (docs/cutover.md phase 2). A routine whose
// done-marker lived in a file re-runs on a fresh state directory, and for
// anything with outbound side effects that is not an acceptable cutover risk,
// so the stamp the loop would have written gets written by hand instead.
//
// The marks handle is passed rather than taken from the context because a
// context built without --live has a dryMarks overlay in ctx.marks, and this
// command's whole purpose is to write.
export async function adopt(
  ctx: Ctx,
  marks: Marks,
  job: Job,
  key?: string,
): Promise<{ key: string; already: boolean }> {
  const k = key ?? (await currentKey(ctx, job))
  const already = marks.has(job.name, k, "spawned")
  if (!already) marks.set(job.name, k, "spawned")
  return { key: k, already }
}

async function currentKey(ctx: Ctx, job: Job): Promise<string> {
  // Every other kind keys on an item, so there is no key it would use right
  // now. Guessing one would stamp a real issue or pull request as done.
  if (job.workload !== "routine") {
    throw new Error(
      `job "${job.name}" is a ${job.workload}, which keys on an item: name the key to adopt`,
    )
  }
  const k = await job.key(ctx, BLANK)
  if (!k) throw new Error(`job "${job.name}" has no occurrence due right now`)
  return k
}

export function renderMarks(rows: MarkRow[], now: Date): string[] {
  if (!rows.length) return ["no marks recorded"]
  return rows.map((r) => {
    const minutes = Math.max(0, Math.round((now.getTime() - r.at) / 60000))
    return `${r.job} ${r.key} ${r.mark} ${minutes}m ago`
  })
}
