import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { discover, loadWorkspace, type LoadOpts } from "../src/discover"
import type { Job, Config, AccountConfig } from "../src/types"
import type { Kind } from "../src/kinds"
import { reviewer } from "../src/kinds/reviewer"

const accounts: AccountConfig[] = [
  { id: "loop", provider: "claude", configDir: "/c", reserve: 0 },
]

const builder: Kind = {
  name: "builder",
  workload: "builder",
  fields: [{ name: "base", type: "string", default: "origin/main", doc: "base ref" }],
  build: (spec) => ({
    name: spec.name,
    dir: spec.dir,
    workload: "builder",
    discover: async () => [],
    discoverClaimed: async () => [],
    key: async () => "k",
    done: async () => true,
    brief: async () => String(spec.options.base),
  } as unknown as Job),
}

const opts = (): LoadOpts => ({ kinds: { builder, reviewer }, accounts, checkSelectors: true })

const WS = `
name: acme
herdrWorkspace: acme
worktreeBase: ..
repos:
  web: ../web
naming:
  labels: { claim: agent-wip, failed: agent-failed, park: needs-human, priority: [build-now] }
  mergeMethod: squash
`

function tree(jobs: Record<string, string>, ws = WS): string {
  const root = mkdtempSync(`${tmpdir()}/al-ws-`)
  const dir = `${root}/agent-loop`
  mkdirSync(dir)
  writeFileSync(`${dir}/workspace.yml`, ws)
  for (const [name, yml] of Object.entries(jobs)) {
    mkdirSync(`${dir}/${name}`)
    writeFileSync(`${dir}/${name}/job.yml`, yml)
  }
  return dir
}

test("a valid tree loads, resolving paths against the workspace folder", () => {
  const dir = tree({ build: "kind: builder\nrepo: web\n" })
  const { ws, errors } = loadWorkspace(dir, opts())
  expect(errors).toEqual([])
  expect(ws!.name).toBe("acme")
  expect(ws!.worktreeBase).toBe(dir.replace(/\/agent-loop$/, ""))
  expect(ws!.repos.web).toBe(dir.replace(/\/agent-loop$/, "/web"))
  expect(ws!.jobs.map((j) => j.name)).toEqual(["build"])
})

test("the journal is derived from the workspace name, never configured", () => {
  process.env.AGENT_LOOP_HOME = "/tmp/al-home"
  const { ws } = loadWorkspace(tree({ build: "kind: builder\nrepo: web\n" }), opts())
  expect(ws!.journalPath).toBe("/tmp/al-home/acme/journal.md")
  delete process.env.AGENT_LOOP_HOME
})

test("the folder name is the job name and reaches the built job", () => {
  const { ws } = loadWorkspace(tree({ "night-build": "kind: builder\nrepo: web\n" }), opts())
  expect(ws!.jobs[0]!.name).toBe("night-build")
  expect(ws!.jobs[0]!.dir.endsWith("/night-build")).toBe(true)
})

test("kind options reach the kind, with its defaults applied", async () => {
  const { ws } = loadWorkspace(tree({ build: "kind: builder\nrepo: web\n" }), opts())
  expect(await ws!.jobs[0]!.brief({} as any, {} as any)).toBe("origin/main")
  const { ws: ws2 } = loadWorkspace(
    tree({ build: "kind: builder\nrepo: web\noptions: { base: origin/develop }\n" }),
    opts(),
  )
  expect(await ws2!.jobs[0]!.brief({} as any, {} as any)).toBe("origin/develop")
})

test("jobs sort by order, then by name", () => {
  const { ws } = loadWorkspace(
    tree({
      build: "kind: builder\nrepo: web\norder: 20\n",
      review: "kind: builder\nrepo: web\norder: 10\n",
      audit: "kind: builder\nrepo: web\n",
      zeta: "kind: builder\nrepo: web\n",
    }),
    opts(),
  )
  expect(ws!.jobs.map((j) => j.name)).toEqual(["review", "build", "audit", "zeta"])
})

test("a brief path resolves against the job folder", () => {
  const dir = tree({ build: "kind: builder\nrepo: web\nbrief: { extends: default/build, append: ./brief.md }\n" })
  writeFileSync(`${dir}/build/brief.md`, "repo prose")
  const { ws, errors } = loadWorkspace(dir, opts())
  expect(errors).toEqual([])
  expect(ws!.jobs[0]!.dir.endsWith("/build")).toBe(true)
})

test("a brief append that does not exist is reported, not discovered at spawn time", () => {
  const dir = tree({ build: "kind: builder\nrepo: web\nbrief: { append: ./brief.md }\n" })
  const { errors } = loadWorkspace(dir, opts())
  expect(errors).toEqual(['build/job.yml: brief.append "./brief.md" does not exist'])
})

// filing.queue is cross-job, so no kind's own check can see it. Left to run
// time it throws out of filingBudget only under --live, after the item is
// claimed, and the rollback's two-strike rule tombstones a live pull request.
test("a filing.queue naming no job fails the load and says which job it meant", () => {
  const dir = tree({
    build: "kind: builder\nrepo: web\n",
    review: "kind: reviewer\nrepo: web\noptions:\n  filing: { queue: bulid, maxOpen: 40, perRound: 2 }\n",
  })
  const { ws, errors } = loadWorkspace(dir, opts())
  expect(errors).toEqual([
    'review/job.yml: options.filing.queue "bulid" names no job in this workspace; did you mean "build"?',
  ])
  expect(ws).toBeUndefined()
})

test("a filing.queue naming a job that exists loads clean", () => {
  const dir = tree({
    build: "kind: builder\nrepo: web\n",
    review: "kind: reviewer\nrepo: web\noptions:\n  filing: { queue: build, maxOpen: 40, perRound: 2 }\n",
  })
  const { ws, errors } = loadWorkspace(dir, opts())
  expect(errors).toEqual([])
  expect(ws!.jobs.map((j) => j.name)).toEqual(["build", "review"])
})

test("a subfolder with no job.yml is not a job", () => {
  const dir = tree({ build: "kind: builder\nrepo: web\n" })
  mkdirSync(`${dir}/briefs`)
  writeFileSync(`${dir}/briefs/build.md`, "prose")
  const { ws, errors } = loadWorkspace(dir, opts())
  expect(errors).toEqual([])
  expect(ws!.jobs.map((j) => j.name)).toEqual(["build"])
})

test("a folder with no workspace.yml is reported", () => {
  const root = mkdtempSync(`${tmpdir()}/al-ws-`)
  expect(loadWorkspace(root, opts()).errors).toEqual([`${root}: no workspace.yml`])
})

test("an unknown kind names the kinds that exist", () => {
  const { ws, errors } = loadWorkspace(tree({ build: "kind: buidler\nrepo: web\n" }), opts())
  expect(ws).toBeUndefined()
  expect(errors).toEqual(['build/job.yml: unknown kind "buidler"; did you mean "builder"?'])
})

test("a repo that is not a key of repos is reported with a suggestion", () => {
  const { errors } = loadWorkspace(tree({ build: "kind: builder\nrepo: wbe\n" }), opts())
  expect(errors).toEqual(['build/job.yml: repo "wbe" is not a key of repos; did you mean "web"?'])
})

test("an illegal job folder name is rejected before it reaches a branch name", () => {
  const { errors } = loadWorkspace(tree({ "Build Now": "kind: builder\nrepo: web\n" }), opts())
  expect(errors).toEqual([
    'Build Now: a job folder name must match ^[a-z0-9][a-z0-9-]{0,31}$, because it names branches and worktrees',
  ])
})

test("a selector matching no account is a hard error", () => {
  const { errors } = loadWorkspace(
    tree({ build: "kind: builder\nrepo: web\nrequires: [codex]\n" }),
    opts(),
  )
  expect(errors).toEqual(['build/job.yml: requires "codex", which matches no account'])
})

test("selector checks are skipped when there is no machine config to check against", () => {
  const { errors } = loadWorkspace(
    tree({ build: "kind: builder\nrepo: web\nrequires: [codex]\n" }),
    { kinds: { builder }, accounts: [], checkSelectors: false },
  )
  expect(errors).toEqual([])
})

test("one invalid job.yml skips the workspace, not just the job", () => {
  const { ws, errors } = loadWorkspace(
    tree({ build: "kind: builder\nrepo: web\n", broken: "kind: nope\nrepo: web\n" }),
    opts(),
  )
  expect(ws).toBeUndefined()
  expect(errors.length).toBe(1)
})

test("an invalid workspace.yml is reported field by field", () => {
  const { errors } = loadWorkspace(tree({}, "name: acme\n"), opts())
  expect(errors).toContain("workspace.yml: herdrWorkspace is required")
  expect(errors).toContain("workspace.yml: worktreeBase is required")
  expect(errors).toContain("workspace.yml: repos must name at least one repository")
  expect(errors).toContain("workspace.yml: naming.labels.claim is required")
})

test("a workspace name that could not be a directory or a mark key is rejected", () => {
  const { errors } = loadWorkspace(tree({}, `${WS.replace("name: acme", "name: ../evil")}`), opts())
  expect(errors).toContain(
    'workspace.yml: name "../evil" must match ^[a-z0-9][a-z0-9-]{0,31}$, because it names the state directory',
  )
})

test("a missing workspace path is reported every tick rather than skipped quietly", () => {
  const config = { accounts, workspaces: ["/nope/agent-loop"] } as Config
  const { workspaces, errors } = discover(config, opts())
  expect(workspaces).toEqual([])
  expect(errors).toEqual(["/nope/agent-loop: no workspace.yml"])
})

test("one broken workspace does not stop the others", () => {
  const good = tree({ build: "kind: builder\nrepo: web\n" })
  const bad = tree({ build: "kind: nope\nrepo: web\n" }, WS.replace("acme", "other"))
  const config = { accounts, workspaces: [good, bad] } as Config
  const { workspaces, errors } = discover(config, opts())
  expect(workspaces.map((w) => w.name)).toEqual(["acme"])
  expect(errors.length).toBe(1)
  expect(errors[0]).toStartWith(bad)
})

test("two workspaces claiming one repo skip both, since neither is knowably right", () => {
  const a = tree({ build: "kind: builder\nrepo: web\n" })
  const b = tree({ build: "kind: builder\nrepo: web\n" }, WS.replace("name: acme", "name: other"))
  const shared = `repos:\n  web: ${a.replace(/agent-loop$/, "web")}\n`
  writeFileSync(`${b}/workspace.yml`, WS.replace("name: acme", "name: other").replace("repos:\n  web: ../web\n", shared))
  const { workspaces, errors } = discover({ accounts, workspaces: [a, b] } as Config, opts())
  expect(workspaces).toEqual([])
  expect(errors.some((e) => e.includes("is claimed by more than one workspace"))).toBe(true)
})

test("two workspaces with the same name skip both", () => {
  const a = tree({ build: "kind: builder\nrepo: web\n" })
  const b = tree({ build: "kind: builder\nrepo: web\n" })
  const { workspaces, errors } = discover({ accounts, workspaces: [a, b] } as Config, opts())
  expect(workspaces).toEqual([])
  expect(errors.some((e) => e.includes('workspace name "acme" is used by more than one folder'))).toBe(true)
})

test("an unreadable workspace folder is reported, not thrown out of the tick", () => {
  const good = tree({ build: "kind: builder\nrepo: web\n" })
  const bad = tree({ build: "kind: builder\nrepo: web\n" }, WS.replace("acme", "other"))
  // Execute but not read: workspace.yml still opens by name, readdirSync does
  // not. This is the mode a checkout owned by another uid presents.
  chmodSync(bad, 0o111)
  try {
    const { workspaces, errors } = discover({ accounts, workspaces: [good, bad] } as Config, opts())
    expect(workspaces.map((w) => w.name)).toEqual(["acme"])
    expect(errors.length).toBe(1)
    expect(errors[0]).toStartWith(bad)
    expect(errors[0]).toContain("EACCES")
  } finally {
    chmodSync(bad, 0o755)
  }
})

test("a kind whose build throws is contained to its own workspace", () => {
  const boom: Kind = { ...builder, build: () => { throw new Error("kind exploded") } }
  const good = tree({ build: "kind: builder\nrepo: web\n" })
  const bad = tree({ build: "kind: boom\nrepo: web\n" }, WS.replace("acme", "other"))
  const { workspaces, errors } = discover(
    { accounts, workspaces: [good, bad] } as Config,
    { kinds: { builder, boom }, accounts, checkSelectors: true },
  )
  expect(workspaces.map((w) => w.name)).toEqual(["acme"])
  expect(errors.length).toBe(1)
  expect(errors[0]).toContain("kind exploded")
})

test("a typo'd job key is an error, not an ignored line", () => {
  const { ws, errors } = loadWorkspace(tree({ build: "kind: builder\nrepo: web\nslot: 9\n" }), opts())
  expect(ws).toBeUndefined()
  expect(errors).toEqual(['build/job.yml: unknown key "slot"; did you mean "slots"?'])
})

test("a wrong-typed engine field is reported the way every other field is", () => {
  // "4" silently became 1 and "10" silently became 100, and both are
  // load-bearing: slots is the job's concurrency and order is the spawn walk.
  const { errors } = loadWorkspace(
    tree({ build: 'kind: builder\nrepo: web\nslots: "4"\norder: "10"\ndistinctFrom: "yes"\n' }),
    opts(),
  )
  expect(errors).toEqual([
    "build/job.yml: slots must be a number",
    "build/job.yml: order must be a number",
    "build/job.yml: distinctFrom must be true or false",
  ])
})

test("a job.yml with no kind says so, rather than reporting an unknown empty kind", () => {
  const { errors } = loadWorkspace(tree({ build: "repo: web\n" }), opts())
  expect(errors).toEqual(["build/job.yml: kind is required, and must name a shipped kind"])
})

test("a typo'd workspace key is an error", () => {
  const { errors } = loadWorkspace(tree({}, `${WS}worktreebase: ..\n`), opts())
  expect(errors).toContain('workspace.yml: unknown key "worktreebase"; did you mean "worktreeBase"?')
})

test("a typo'd naming key is an error, not a merge method silently left at squash", () => {
  const { errors } = loadWorkspace(
    tree({}, WS.replace("  mergeMethod: squash", "  mergemethod: merge")),
    opts(),
  )
  expect(errors).toContain('workspace.yml: naming: unknown key "mergemethod"; did you mean "mergeMethod"?')
})

test("a typo'd label key is an error", () => {
  const { errors } = loadWorkspace(tree({}, WS.replace("park:", "parked:")), opts())
  expect(errors).toContain('workspace.yml: naming.labels: unknown key "parked"; did you mean "park"?')
  expect(errors).toContain("workspace.yml: naming.labels.park is required")
})

test("a scalar priority is an error, not an empty ordering", () => {
  const { errors } = loadWorkspace(tree({}, WS.replace("priority: [build-now]", "priority: bug")), opts())
  expect(errors).toEqual(["workspace.yml: naming.labels.priority must be a list of strings"])
})

test("an empty label is rejected, because an empty claim label never sticks", () => {
  const { errors } = loadWorkspace(tree({}, WS.replace("claim: agent-wip", 'claim: ""')), opts())
  expect(errors).toEqual(["workspace.yml: naming.labels.claim must not be empty"])
})

test("a kind's check hook errors are reported against the job file", () => {
  const strict: Kind = {
    ...builder,
    check: (spec) => (spec.options.base === "origin/nope" ? ["options.base names no branch here"] : []),
  }
  const dir = tree({ build: "kind: builder\nrepo: web\noptions:\n  base: origin/nope\n" })
  const { ws, errors } = loadWorkspace(dir, { kinds: { builder: strict }, accounts, checkSelectors: true })
  expect(ws).toBeUndefined()
  expect(errors).toEqual(["build/job.yml: options.base names no branch here"])
})
