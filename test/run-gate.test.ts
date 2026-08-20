import { test, expect } from "bun:test"
import { assertReadOnly } from "../src/adapters/run"

const ok = (argv: string[]) => expect(() => assertReadOnly(argv)).not.toThrow()
const no = (argv: string[]) => expect(() => assertReadOnly(argv)).toThrow(/without --live/)

test("the reads every pass depends on are allowed", () => {
  ok(["gh", "issue", "list", "--repo", "acme/web", "--state", "open"])
  ok(["gh", "pr", "list", "--repo", "acme/web", "--state", "all"])
  ok(["gh", "pr", "view", "80", "--repo", "acme/web", "--json", "body"])
  ok(["gh", "issue", "view", "7", "--repo", "acme/web", "--json", "labels"])
  ok(["gh", "api", "repos/acme/web/issues"])
  ok(["git", "-C", "/r", "worktree", "list", "--porcelain"])
  ok(["git", "-C", "/r", "for-each-ref", "refs/heads/review/"])
  ok(["git", "-C", "/r", "ls-remote", "--heads", "origin", "review/*"])
  ok(["herdr", "agent", "list"])
  ok(["herdr", "pane", "list"])
  ok(["herdr", "workspace", "list"])
  ok(["herdr", "api", "schema", "--json"])
  ok(["herdr", "agent", "read", "p1", "--source", "recent-unwrapped", "--lines", "60"])
  ok(["herdr", "agent", "get", "p1"])
})

test("gh auth status is a read", () => {
  expect(() => assertReadOnly(["gh", "auth", "status"])).not.toThrow()
})

test("every mutation this plan adds is refused", () => {
  no(["gh", "issue", "edit", "7", "--repo", "acme/web", "--add-label", "agent-wip"])
  no(["gh", "pr", "edit", "80", "--repo", "acme/web", "--remove-label", "agent-wip"])
  no(["gh", "issue", "comment", "7", "--repo", "acme/web", "--body", "hi"])
  no(["git", "-C", "/r", "fetch", "origin", "--prune"])
  no(["git", "-C", "/r", "worktree", "add", "-b", "build/b7", "/b/wt-build-b7", "origin/main"])
  no(["git", "-C", "/r", "worktree", "remove", "--force", "/b/wt-build-b7"])
  no(["git", "-C", "/r", "branch", "-D", "build/b7"])
  no(["git", "-C", "/r", "push", "origin", "--delete", "build/b7"])
  no(["herdr", "tab", "create", "--workspace", "w6", "--cwd", "/b/wt-build-b7"])
  no(["herdr", "tab", "close", "w6:t2"])
  no(["herdr", "agent", "start", "build-b7", "--kind", "claude", "--pane", "p1"])
  no(["herdr", "agent", "prompt", "p1", "go"])
  no(["herdr", "agent", "send-keys", "p1", "Enter"])
})

test("an unknown command is refused rather than assumed harmless", () => {
  no(["rm", "-rf", "/"])
  no(["gh", "repo", "delete", "acme/web"])
  no(["git", "-C", "/r", "reset", "--hard"])
  no(["herdr", "server", "stop"])
})

test("a write verb hidden behind a read prefix is still refused", () => {
  // "gh api" is allowed for GET only; a method flag makes it a write.
  no(["gh", "api", "-X", "POST", "repos/acme/web/issues"])
  no(["gh", "api", "--method", "DELETE", "repos/acme/web/issues/7"])
  // Parameter flags trigger implicit POST and are writes.
  no(["gh", "api", "repos/acme/web/issues", "-f", "title=x"])
  no(["gh", "api", "repos/acme/web/issues", "--raw-field", "body=y"])
  no(["gh", "api", "repos/acme/web/issues", "-F", "data=z"])
  no(["gh", "api", "repos/acme/web/issues", "--field", "name=v"])
  no(["gh", "api", "repos/acme/web/issues", "--input", "-"])
})
