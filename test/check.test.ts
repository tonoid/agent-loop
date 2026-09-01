import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname } from "node:path"
import { runCheck, type CheckDeps } from "../src/check"
import { TESTED_PROTOCOL } from "../src/adapters/herdr"
import type { Kind } from "../src/kinds"
import type { Job } from "../src/types"

const builder: Kind = {
  name: "builder",
  workload: "builder",
  fields: [{ name: "base", type: "string", default: "origin/main", doc: "base ref" }],
  build: (spec) => ({ name: spec.name, dir: spec.dir, workload: "builder" } as Job),
}

const deps = (o: Partial<CheckDeps> = {}): CheckDeps => ({
  which: () => "/usr/bin/x",
  ghAuth: async () => true,
  protocol: async () => TESTED_PROTOCOL,
  herdrWorkspaces: async () => ["acme"],
  readConfig: async () => null,
  ...o,
})

function tree(o: { cloned?: boolean } = {}): string {
  const root = mkdtempSync(`${tmpdir()}/al-check-`)
  const dir = `${root}/agent-loop`
  mkdirSync(`${dir}/build`, { recursive: true })
  if (o.cloned !== false) mkdirSync(`${root}/web/.git`, { recursive: true })
  writeFileSync(`${dir}/workspace.yml`, `
name: acme
herdrWorkspace: acme
worktreeBase: ..
repos: { web: ../web }
naming:
  labels: { claim: agent-wip, failed: agent-failed, park: needs-human, priority: [] }
  mergeMethod: squash
`)
  writeFileSync(`${dir}/build/job.yml`, "kind: builder\nrepo: web\n")
  return dir
}

test("a clean tree checks out and says what it found", async () => {
  const dir = tree()
  const { lines, ok } = await runCheck({
    configPath: "/nope",
    workspaceDir: dir,
    kinds: { builder },
    deps: deps(),
  })
  expect(ok).toBe(true)
  expect(lines).toContain("acme: 1 job (build)")
  expect(lines).toContain("skipped: account selectors (no config.yml in this form)")
})

test("a broken job.yml fails the check and names the file", async () => {
  const dir = tree()
  writeFileSync(`${dir}/build/job.yml`, "kind: buidler\nrepo: web\n")
  const { lines, ok } = await runCheck({
    configPath: "/nope",
    workspaceDir: dir,
    kinds: { builder },
    deps: deps(),
  })
  expect(ok).toBe(false)
  expect(lines.some((l) => l.includes('build/job.yml: unknown kind "buidler"'))).toBe(true)
})

test("a missing binary fails the check, because cron's PATH is nearly empty", async () => {
  const { lines, ok } = await runCheck({
    configPath: "/nope",
    workspaceDir: tree(),
    kinds: { builder },
    deps: deps({ which: (b) => (b === "herdr" ? null : "/usr/bin/x") }),
  })
  expect(ok).toBe(false)
  expect(lines).toContain("herdr: not on PATH")
})

test("a protocol mismatch warns without failing the check", async () => {
  const { lines, ok } = await runCheck({
    configPath: "/nope",
    workspaceDir: tree(),
    kinds: { builder },
    deps: deps({ protocol: async () => TESTED_PROTOCOL + 1 }),
  })
  expect(ok).toBe(true)
  expect(lines.some((l) => l.startsWith(`WARN herdr protocol ${TESTED_PROTOCOL + 1}, tested`))).toBe(true)
})

test("an unauthenticated gh fails the check", async () => {
  const { lines, ok } = await runCheck({
    configPath: "/nope",
    workspaceDir: tree(),
    kinds: { builder },
    deps: deps({ ghAuth: async () => false }),
  })
  expect(ok).toBe(false)
  expect(lines).toContain("gh: not authenticated")
})

test("without a workspace argument the machine config drives the check", async () => {
  const dir = tree()
  const { lines, ok } = await runCheck({
    configPath: "/x/config.yml",
    kinds: { builder },
    deps: deps({
      readConfig: async () => `accounts:\n  - { id: loop, provider: claude, configDir: ~/.a }\nworkspaces:\n  - ${dir}\n`,
    }),
  })
  expect(ok).toBe(true)
  expect(lines).toContain("acme: 1 job (build)")
})

test("a repos entry that was never cloned fails the check rather than erroring every tick", async () => {
  const dir = tree({ cloned: false })
  const { lines, ok } = await runCheck({
    configPath: "/x/config.yml",
    kinds: { builder },
    deps: deps({
      readConfig: async () => `accounts:\n  - { id: loop, provider: claude, configDir: ~/.a }\nworkspaces:\n  - ${dir}\n`,
    }),
  })
  expect(ok).toBe(false)
  expect(lines.some((l) => l.startsWith('acme: repo "web" at ') && l.endsWith("does not exist"))).toBe(true)
})

test("a repos entry that is not a git repository fails the check", async () => {
  const dir = tree({ cloned: false })
  mkdirSync(dir.replace(/agent-loop$/, "web"), { recursive: true })
  const { lines, ok } = await runCheck({
    configPath: "/x/config.yml",
    kinds: { builder },
    deps: deps({
      readConfig: async () => `accounts:\n  - { id: loop, provider: claude, configDir: ~/.a }\nworkspaces:\n  - ${dir}\n`,
    }),
  })
  expect(ok).toBe(false)
  expect(lines.some((l) => l.endsWith("is not a git repository"))).toBe(true)
})

test("an unchecked-out tree is not the one-folder form's business", async () => {
  // A service repository runs `agent-loop check .` in its own CI, where the
  // sibling repos are legitimately absent.
  const { ok } = await runCheck({
    configPath: "/nope",
    workspaceDir: tree({ cloned: false }),
    kinds: { builder },
    deps: deps(),
  })
  expect(ok).toBe(true)
})

test("a missing machine config fails with the path it looked at", async () => {
  const { lines, ok } = await runCheck({ configPath: "/x/config.yml", kinds: {}, deps: deps() })
  expect(ok).toBe(false)
  expect(lines).toContain("no config at /x/config.yml")
})

// The trust prompt cost three live spawns before it was found: an untrusted
// worktree base leaves every worker on that account idle behind a dialog.
const trustDeps = (dir: string, claudeJson: string | null): CheckDeps =>
  deps({
    readConfig: async (p) =>
      p.endsWith(".claude.json")
        ? claudeJson
        : `accounts:\n  - { id: loop, provider: claude, configDir: /acct }\nworkspaces:\n  - ${dir}\n`,
  })

test("an account that has not trusted the worktree base is warned about", async () => {
  const dir = tree()
  const { lines, ok } = await runCheck({
    configPath: "/x/config.yml",
    kinds: { builder },
    deps: trustDeps(dir, JSON.stringify({ projects: {} })),
  })
  expect(ok).toBe(true)
  expect(lines.some((l) => l.startsWith("WARN acme: account loop has not trusted "))).toBe(true)
})

test("trust of an ancestor counts, because the agent inherits it downwards", async () => {
  const dir = tree()
  const base = dirname(dir)
  const { lines } = await runCheck({
    configPath: "/x/config.yml",
    kinds: { builder },
    deps: trustDeps(dir, JSON.stringify({
      projects: { [dirname(base)]: { hasTrustDialogAccepted: true } },
    })),
  })
  expect(lines.some((l) => l.startsWith("WARN acme: account loop has not trusted"))).toBe(false)
})

test("an account with no .claude.json at all is warned about", async () => {
  const dir = tree()
  const { lines } = await runCheck({
    configPath: "/x/config.yml",
    kinds: { builder },
    deps: trustDeps(dir, null),
  })
  expect(lines.some((l) => l.startsWith("WARN acme: account loop has not trusted"))).toBe(true)
})

// Every spawn resolves the herdr workspace by label, so a label naming nothing
// throws once per due item forever and never once at configure time.
test("a herdrWorkspace label that herdr does not have fails the check", async () => {
  const dir = tree()
  const { lines, ok } = await runCheck({
    configPath: "/x/config.yml",
    kinds: { builder },
    deps: deps({
      herdrWorkspaces: async () => ["other"],
      readConfig: async () => `accounts:\n  - { id: loop, provider: claude, configDir: /acct }\nworkspaces:\n  - ${dir}\n`,
    }),
  })
  expect(ok).toBe(false)
  expect(lines).toContain('acme: no herdr workspace labelled "acme"; herdr has: other')
})

test("a herdr that cannot be asked is a warning, not a verdict on the label", async () => {
  const dir = tree()
  const { lines, ok } = await runCheck({
    configPath: "/x/config.yml",
    kinds: { builder },
    deps: deps({
      herdrWorkspaces: async () => { throw new Error("connection refused") },
      readConfig: async () => `accounts:\n  - { id: loop, provider: claude, configDir: /acct }\nworkspaces:\n  - ${dir}\n`,
    }),
  })
  expect(ok).toBe(true)
  expect(lines).toContain("WARN could not ask herdr for its workspaces")
})
