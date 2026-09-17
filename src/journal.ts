import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
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

// Next to the journal that references it, under the same state directory, so
// the path an operator reads in a FAIL line needs no second convention to find.
// Appended rather than written, because one occurrence can fail more than once
// now that a failed routine retries, and attempt one's transcript is usually
// the one that explains attempt three.
export function writeFailTail(ctx: Ctx, job: string, key: string, tail: string): string {
  const path = join(dirname(ctx.workspace.journalPath), "fails", `${job}-${key}.log`)
  if (!ctx.live) return path
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `--- ${ctx.now.toISOString()} ${job} ${key}\n${tail}\n`)
  return path
}

// Cursor moves, colours, and the title-setting OSC sequences a TUI writes
// between the text an operator would actually read.
const ANSI = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)/g
// Box drawing and blocks, the geometric bullets Claude Code prints beside a
// tool call, the dingbat spinner glyphs, and the braille spinner. Replaced with
// a space rather than nothing so a border never welds two words together.
const DECOR = /[·⌀-⏿─-◿✀-➿⠀-⣿]/g

export function cleanLine(raw: string): string {
  return raw.replace(ANSI, "").replace(DECOR, " ").replace(/\s+/g, " ").trim()
}

// The input box and the status row under it, which is what a pane ends in
// whatever happened above. Every FAIL line the loop wrote before 2026-09-17
// took the last five lines of the tail and so recorded exactly this furniture.
const CHROME = [
  /^[^\w]*$/,                                  // a border or a bare spinner, nothing left after cleaning
  /\? for shortcuts/i,
  /esc to interrupt/i,
  /^>\s*$/,                                   // the empty prompt row; "> FATAL: ..." is output, not chrome
  /\b\d+s\b.*\btokens\b/i,                     // the spinner's elapsed time and token counter
  /\b(accept edits|plan mode|bypass permissions)\b.*\bon\b/i,
]

const isChrome = (line: string) => CHROME.some((re) => re.test(line))

// Strong means the line is the failure. Weak means it is next to one: a stack
// frame, or a summary that counts errors it does not describe. Quota wording
// ranks strong because that is what the failures actually are: on 2026-09-12 a
// pair of runs died within minutes of each other, both against an account at
// 100% of its worst window, and neither said anything more specific.
const STRONG = /(traceback|error:|exception|panic:|fatal|segmentation fault|rate.?limit|quota|\b429\b|usage limit|exit(?:ed)? (?:with )?(?:code |status )?[1-9])/i
const WEAK = /(\berrors?\b|\bfail(?:ed|ure|s)?\b|^at .+:\d+|^file ".+", line \d+)/i

const score = (line: string) => (STRONG.test(line) ? 2 : WEAK.test(line) ? 1 : 0)

// Two lines at most, and one line of output: a journal entry a human scans is
// worth more than a stack trace nobody can read sideways. The whole tail is on
// disk for the trace.
const MAX_CHARS = 300
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}...` : s)

// One line for journal.md, taken from anywhere in the tail rather than its end.
// Ties break towards the earliest line because the first error in a transcript
// is usually the cause and the ones under it are its consequences.
export function failSummary(tail: string): string {
  const lines = tail.split("\n").map(cleanLine).filter((l) => l && !isChrome(l))
  const hits = lines
    .map((text, i) => ({ text, i, score: score(text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i)
  if (hits.length) return clip(hits.map((h) => h.text).join(" | "))

  // Saying so matters: a FAIL line quoting an ordinary line of output reads as
  // a diagnosis, and the operator stops looking at the file that has the rest.
  const last = lines[lines.length - 1]
  return last
    ? clip(`no error-shaped line found, last output was "${last}"`)
    : "no error-shaped line found and nothing readable in the tail"
}
