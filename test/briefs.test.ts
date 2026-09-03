import { test, expect } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { loadBrief, render, unresolved, BRIEFS_DIR } from "../src/brief"

// Every variable the contract in spec 8 defines, so a brief that uses one the
// engine does not supply fails here rather than reaching a worker as literal
// "{{filingBudget}}".
const VARS = {
  item: "#80", number: 80, title: "t", itemUrl: "u", key: "r80",
  worktree: "/b/wt-review-r80", branch: "review/r80", headRef: "build/b12",
  base: "origin/build/b12", attempt: 1, attemptCap: 3, repoSlug: "acme/web",
  journal: "/j/journal.md", mergeMethod: "squash", assetBranch: "assets",
  "labels.claim": "agent-wip", "labels.failed": "agent-failed",
  "labels.park": "needs-human", filingBudget: 2, openQueue: 7, account: "loop",
  commentPrefix: "Review round", passLabel: "reviewed", dedupeBy: "path",
  mergeInstruction: "Merge with `squash`",
}

const ROLES = ["default/build", "default/review", "default/routine"]
const OPTIONALS = ["journal", "subagents", "screenshots"]

test("every shipped brief renders with no unresolved variable", () => {
  for (const role of ROLES) {
    const text = render(loadBrief({ extends: role, optional: OPTIONALS }), VARS)
    expect({ role, left: unresolved(text) }).toEqual({ role, left: [] })
  }
})

// Every fence core.md states, not a sample of them: a role or an optional
// section that contradicts one is the failure this canary exists to catch, and
// the push fence is the one a screenshots section reads as permission.
const FENCES = [
  "Never leave your worktree",
  "Never push any ref but your own branch",
  "Never force-push",
  "Never merge, close, or reopen anything by hand",
  "Never touch CI configuration",
  "Never rewrite history",
]

test("the fences survive in every role, with every optional section loaded", () => {
  for (const role of ROLES) {
    const text = loadBrief({ extends: role, optional: OPTIONALS })
    for (const fence of FENCES) expect({ role, fence, kept: text.includes(fence) }).toEqual({ role, fence, kept: true })
    expect(text).toContain("{{labels.park}}")
  }
})

// The example lines are the whole point of the section, and a {{worktree}} that
// renders as a literal would teach every worker the wrong path. It reaches all
// three roles because a blocked worker costs the same whatever it was doing.
test("every role tells the worker to write absolute paths, with a worked example", () => {
  for (const role of ROLES) {
    const raw = loadBrief({ extends: role, optional: OPTIONALS })
    expect({ role, said: raw.includes("Never open a command\nwith `cd`") }).toEqual({ role, said: true })
    const text = render(raw, VARS)
    expect(text).toContain(`grep -n "thing" -A 20 ${VARS.worktree}/apps/web/lib/x.ts`)
  }
})

test("the push fence and the screenshots section name the same exception", () => {
  const core = loadBrief({})
  expect(core).toContain("{{assetBranch}}` is an exception only where a section below grants it")
  const withShots = loadBrief({ extends: "default/review", optional: ["screenshots"] })
  expect(withShots).toContain("documented exception to the push fence")
})

test("the review brief carries the three filing rules", () => {
  const text = loadBrief({ extends: "default/review" })
  expect(text).toContain("{{filingBudget}}")
  expect(text).toContain("{{openQueue}}")
  // Rule 3 of spec 8.1: the cluster key is the cited path, not the title.
  expect(text.toLowerCase()).toContain("cited")
})

// The dashes are written as escapes so this file is not itself a place they
// live. \u2014 is the em dash, \u2013 the en dash.
test("no brief contains an em dash or an en dash", () => {
  for (const file of readdirSync(`${BRIEFS_DIR}/default`)) {
    const text = readFileSync(`${BRIEFS_DIR}/default/${file}`, "utf8")
    expect({ file, bad: text.includes("\u2014") || text.includes("\u2013") }).toEqual({ file, bad: false })
  }
})
