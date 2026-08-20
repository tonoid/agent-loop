import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const CLI = `${import.meta.dir}/../src/cli.ts`

function run(args: string[], home: string) {
  return Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, AGENT_LOOP_HOME: home },
  })
}

function workspaceTree(jobs: Record<string, string> = {}): string {
  const root = mkdtempSync(`${tmpdir()}/al-cli-`)
  const dir = `${root}/agent-loop`
  mkdirSync(dir, { recursive: true })
  mkdirSync(`${root}/web`, { recursive: true })
  writeFileSync(`${dir}/workspace.yml`, `
name: acme
herdrWorkspace: acme
worktreeBase: ..
repos: { web: ../web }
naming:
  labels: { claim: agent-wip, failed: agent-failed, park: needs-human, priority: [] }
  mergeMethod: squash
`)
  for (const [name, yml] of Object.entries(jobs)) {
    mkdirSync(`${dir}/${name}`, { recursive: true })
    writeFileSync(`${dir}/${name}/job.yml`, yml)
  }
  return dir
}

// Spec 3.5: check performs no writes. The README sells `agent-loop check .` as
// a service repository's CI check, so a writable home is not a given, and
// opening the global store above the branch both created state.db for a
// read-only command and died with a raw EACCES stack trace on a read-only home
// before validating anything.
test("check writes nothing under the state home", () => {
  const home = `${mkdtempSync(`${tmpdir()}/al-home-`)}/state`
  run(["check", workspaceTree()], home)
  expect(existsSync(home)).toBe(false)
})

test("kinds writes nothing under the state home", () => {
  const home = `${mkdtempSync(`${tmpdir()}/al-home-`)}/state`
  const p = run(["kinds"], home)
  expect(p.exitCode).toBe(0)
  expect(existsSync(home)).toBe(false)
})

// One cron line covers the whole box, so the operator's cadence rule needs a
// duration for the process, not one anonymous line per workspace.
test("a tick logs a named line per workspace and one total for the process", () => {
  const home = mkdtempSync(`${tmpdir()}/al-home-`)
  const dir = workspaceTree()
  const config = `${home}/config.yml`
  writeFileSync(config, `accounts:\n  - { id: loop, provider: claude, configDir: ~/.claude-loop }\nworkspaces:\n  - ${dir}\n`)
  const p = run(["tick", "--config", config], home)
  const out = p.stdout.toString()
  expect(out).toMatch(/TICK acme \d+ms/)
  expect(out).toMatch(/TICK total \d+ms/)
})

const ROUTINE = "kind: routine\nrepo: web\norder: 5\noptions:\n  at: ['09:10']\n"

function configured(home: string, jobs: Record<string, string>): string {
  const dir = workspaceTree(jobs)
  const config = `${home}/config.yml`
  writeFileSync(config, `accounts:\n  - { id: loop, provider: claude, configDir: ~/.claude-loop }\nworkspaces:\n  - ${dir}\n`)
  return config
}

// Appendix A phase 2: the stamp has to be importable before the first live
// tick, and the command that writes it is not a tick, so it writes without
// --live.
test("adopt records a routine occurrence, once, and lists it back", () => {
  const home = mkdtempSync(`${tmpdir()}/al-home-`)
  const config = configured(home, { digest: ROUTINE })

  const first = run(["adopt", "digest", "--workspace", "acme", "--config", config], home)
  expect(first.exitCode).toBe(0)
  expect(first.stdout.toString()).toMatch(/^adopted digest \d{8}-0910$/m)

  const again = run(["adopt", "digest", "--workspace", "acme", "--config", config], home)
  expect(again.stdout.toString()).toMatch(/was already recorded/)

  const listed = run(["adopt", "--list", "--workspace", "acme", "--config", config], home)
  expect(listed.stdout.toString()).toMatch(/^digest \d{8}-0910 spawned \d+m ago$/m)
})

test("adopt refuses a job name that is not in the workspace", () => {
  const home = mkdtempSync(`${tmpdir()}/al-home-`)
  const config = configured(home, { digest: ROUTINE })
  const p = run(["adopt", "digets", "--workspace", "acme", "--config", config], home)
  expect(p.exitCode).toBe(2)
  expect(p.stderr.toString()).toMatch(/unknown job "digets"/)
})
