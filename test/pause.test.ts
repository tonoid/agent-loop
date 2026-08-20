// test/pause.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { pausedJobs } from "../src/cli-pause"

test("no marker files means nothing is paused", () => {
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-state-`)
  expect(pausedJobs(dir, ["build", "review"])).toEqual([])
})

test("a workspace-wide pause names every job", () => {
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-state-`)
  writeFileSync(`${dir}/pause`, "")
  expect(pausedJobs(dir, ["build", "review"])).toEqual(["build", "review"])
})

test("a per-job pause names only that job", () => {
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-state-`)
  writeFileSync(`${dir}/pause-review`, "")
  expect(pausedJobs(dir, ["build", "review"])).toEqual(["review"])
})

test("a job named all pauses only itself", () => {
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-state-`)
  writeFileSync(`${dir}/pause-all`, "")
  expect(pausedJobs(dir, ["all", "build"])).toEqual(["all"])
})
