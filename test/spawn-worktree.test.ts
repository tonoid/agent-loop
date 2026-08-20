import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, statSync, readFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { createWorktree, prepareWorktree } from "../src/effects/spawn"
import { memoryLock } from "../src/lock"
import type { Ctx, Job, WorkItem } from "../src/types"

const item: WorkItem = {
  id: "issue:7", number: 7, title: "t", state: "OPEN", labels: [],
  url: "https://example.test/acme/web/issues/7",
}

function ctxWith(repo: string, base = "/b") {
  const calls: any[][] = []
  const git = {
    fetch: async () => { calls.push(["fetch"]) },
    worktreeAdd: async (p: string, b: string, from: string) => { calls.push(["worktreeAdd", p, b, from]) },
  }
  const ctx = {
    workspace: { worktreeBase: base, repos: { web: repo } },
    live: true,
    lock: memoryLock(),
    git: () => git,
    cache: <T,>(_k: string, fn: () => Promise<T>) => fn(),
  } as unknown as Ctx
  return { ctx, calls }
}

const job = (o: Partial<Job> = {}): Job =>
  ({ name: "build", workload: "builder", repo: "web", brief: async () => "go", ...o }) as Job

test("the worktree is created on the job's base, after a fetch", async () => {
  const { ctx, calls } = ctxWith("/r")
  const path = await createWorktree(ctx, job({ base: async () => "origin/develop" }), item, "b7")
  expect(path).toBe("/b/wt-build-b7")
  expect(calls).toEqual([
    ["fetch"],
    ["worktreeAdd", "/b/wt-build-b7", "build/b7", "origin/develop"],
  ])
})

test("a job with no base cannot spawn, and says so", async () => {
  const { ctx } = ctxWith("/r")
  await expect(createWorktree(ctx, job(), item, "b7")).rejects.toThrow(/no base\(\)/)
})

test("copied files land in the worktree with their mode, and missing ones are ignored", async () => {
  const repo = mkdtempSync(`${tmpdir()}/agent-loop-repo-`)
  const wt = mkdtempSync(`${tmpdir()}/agent-loop-wt-`)
  writeFileSync(`${repo}/.env`, "SECRET=1")
  chmodSync(`${repo}/.env`, 0o600)
  mkdirSync(`${repo}/nested`, { recursive: true })
  writeFileSync(`${repo}/nested/local.json`, "{}")

  const { ctx } = ctxWith(repo)
  await prepareWorktree(ctx, job({ copyIntoWorktree: [".env", "nested/local.json", "absent"] }), wt)

  expect(readFileSync(`${wt}/.env`, "utf8")).toBe("SECRET=1")
  expect(statSync(`${wt}/.env`).mode & 0o777).toBe(0o600)
  expect(existsSync(`${wt}/nested/local.json`)).toBe(true)
  expect(existsSync(`${wt}/absent`)).toBe(false)
})

test("the job's own prepare hook runs after the copies", async () => {
  const repo = mkdtempSync(`${tmpdir()}/agent-loop-repo-`)
  const wt = mkdtempSync(`${tmpdir()}/agent-loop-wt-`)
  writeFileSync(`${repo}/.env`, "X=1")
  const seen: string[] = []
  const { ctx } = ctxWith(repo)
  await prepareWorktree(ctx, job({
    copyIntoWorktree: [".env"],
    prepare: async (_c, path) => { seen.push(existsSync(`${path}/.env`) ? "after copies" : "before copies") },
  }), wt)
  expect(seen).toEqual(["after copies"])
})
