import { test, expect } from "bun:test"
import { parseWorktrees, makeGit } from "../src/adapters/git"
import { makeGh } from "../src/adapters/gh"
import { makeHerdr } from "../src/adapters/herdr"
import { assertReadOnly } from "../src/adapters/run"

const PORCELAIN = `worktree /home/u/projects/acme/web
HEAD 1111111111111111111111111111111111111111
branch refs/heads/develop

worktree /home/u/projects/acme/wt-build-b80
HEAD 2222222222222222222222222222222222222222
branch refs/heads/build/b80

worktree /home/u/projects/acme/wt-review-r80
HEAD 3333333333333333333333333333333333333333
detached

`

test("porcelain worktrees parse to path and short branch", () => {
  expect(parseWorktrees(PORCELAIN)).toEqual([
    { path: "/home/u/projects/acme/web", branch: "develop" },
    { path: "/home/u/projects/acme/wt-build-b80", branch: "build/b80" },
    { path: "/home/u/projects/acme/wt-review-r80", branch: null },
  ])
})

test("gh prList requests only read verbs and maps to WorkItem", async () => {
  const calls: string[][] = []
  const gh = makeGh(async (argv: string[]) => {
    calls.push(argv)
    return [{ number: 265, title: "t", state: "OPEN", headRefName: "build/b80", labels: [{ name: "agent-wip" }], url: "u" }]
  }, async () => "")
  const items = await gh.prList({ repo: "acme/web", state: "all", limit: 100 })
  expect(calls[0]![0]).toBe("gh")
  expect(calls[0]![1]).toBe("pr")
  expect(calls[0]![2]).toBe("list")
  expect(calls[0]).toContain("--state")
  expect(calls[0]).toContain("all")
  expect(items).toEqual([
    { id: "pr:265", number: 265, title: "t", state: "OPEN", labels: ["agent-wip"], headRef: "build/b80", url: "u" },
  ])
})

test("gh list requests carry --limit even when the caller passes no limit", async () => {
  const calls: string[][] = []
  const gh = makeGh(async (argv: string[]) => {
    calls.push(argv)
    return []
  }, async () => "")
  await gh.issueList({ repo: "acme/web", state: "open" })
  expect(calls[0]).toContain("--limit")
  expect(calls[0]![calls[0]!.indexOf("--limit") + 1]).not.toBe("30")
})

test("herdr agents map status and treat an unknown status as missing", async () => {
  const herdr = makeHerdr(async () => ({
    result: {
      agents: [
        { cwd: "/w/wt-review-r80", agent_status: "working", pane_id: "w3X:p1" },
        { cwd: "/w/wt-build-b80", agent_status: "unknown", pane_id: "w30:p1" },
      ],
    },
  }))
  expect(await herdr.agents()).toEqual([
    { cwd: "/w/wt-review-r80", status: "working", paneId: "w3X:p1" },
    { cwd: "/w/wt-build-b80", status: "missing", paneId: "w30:p1" },
  ])
})

test("git lsRemote extracts full branch names past the first refs/heads/ prefix", async () => {
  const calls: string[][] = []
  const LS_REMOTE = [
    "1111111111111111111111111111111111111111\trefs/heads/build/b80",
    "2222222222222222222222222222222222222222\trefs/heads/feature/refs/heads/embedded",
    "3333333333333333333333333333333333333333\tHEAD",
    "",
  ].join("\n")
  const git = makeGit(async (argv: string[]) => {
    calls.push(argv)
    return LS_REMOTE
  }, "/repo/acme/web")
  const branches = await git.lsRemote("refs/heads/*")
  expect(branches).toEqual(["build/b80", "feature/refs/heads/embedded"])
  expect(calls[0]).toEqual([
    "git",
    "-C",
    "/repo/acme/web",
    "ls-remote",
    "--heads",
    "origin",
    "refs/heads/*",
  ])
})

test("label edits carry both lists in one call and skip an empty edit", async () => {
  const calls: string[][] = []
  // gh prints the item's URL on a successful edit, so the json runner stands in
  // for JSON.parse on that: if label() reaches for it, this test throws.
  const asJson = async () => { throw new SyntaxError('Unexpected identifier "https"') }
  const gh = makeGh(asJson, async (argv) => { calls.push(argv); return "" })
  await gh.label("acme/web", "pr", 80, { add: ["agent-wip"], remove: ["needs-human"] })
  await gh.label("acme/web", "issue", 7, {})
  expect(calls).toEqual([
    ["gh", "pr", "edit", "80", "--repo", "acme/web", "--add-label", "agent-wip", "--remove-label", "needs-human"],
  ])
})

test("remoteSlug parses ssh and https origins alike", async () => {
  const forUrl = (url: string) => makeGit(async () => url, "/r").remoteSlug()
  expect(await forUrl("git@example.test:acme/web.git\n")).toBe("acme/web")
  expect(await forUrl("https://example.test/acme/web.git\n")).toBe("acme/web")
  expect(await forUrl("https://example.test/acme/web\n")).toBe("acme/web")
  expect(forUrl("not-a-remote\n")).rejects.toThrow()
})

test("reading a remote url is a read", () => {
  expect(() => assertReadOnly(["git", "-C", "/r", "remote", "get-url", "origin"])).not.toThrow()
  expect(() => assertReadOnly(["git", "-C", "/r", "remote", "add", "x", "y"])).toThrow()
})

test("a comment body is passed as one argv element, never a shell string", async () => {
  const calls: string[][] = []
  const asJson = async () => { throw new SyntaxError('Unexpected identifier "https"') }
  const gh = makeGh(asJson, async (argv) => { calls.push(argv); return "" })
  await gh.comment("acme/web", "issue", 7, "line one\n`backtick` && rm -rf /")
  expect(calls[0]!.at(-1)).toBe("line one\n`backtick` && rm -rf /")
  expect(calls[0]!.slice(0, 6)).toEqual(["gh", "issue", "comment", "7", "--repo", "acme/web"])
})
