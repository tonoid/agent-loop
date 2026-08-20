// test/claude-writeback.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { writeCreds } from "../src/router/providers/claude"

test("the credentials file is replaced atomically and keeps its other keys", () => {
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-creds-`)
  writeFileSync(
    `${dir}/.credentials.json`,
    JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "rt", expiresAt: 1 }, other: { keep: true } }),
  )
  writeCreds(dir, { accessToken: "new", refreshToken: "rt", expiresAt: 999 })
  const after = JSON.parse(readFileSync(`${dir}/.credentials.json`, "utf8"))
  expect(after.claudeAiOauth.accessToken).toBe("new")
  expect(after.claudeAiOauth.expiresAt).toBe(999)
  expect(after.other).toEqual({ keep: true })
  // No temp file is left behind for the next reader to trip over.
  expect(readdirSync(dir)).toEqual([".credentials.json"])
})

test("the write replaces the file rather than writing into it in place", () => {
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-creds-`)
  const path = `${dir}/.credentials.json`
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "rt", expiresAt: 1 } }))
  // An in-place write (open the target, truncate, write) fails with EACCES
  // here; a rename into a writable directory succeeds regardless of the
  // target file's own permissions. This is what proves the write is atomic
  // rather than merely correct.
  chmodSync(path, 0o444)
  writeCreds(dir, { accessToken: "new", refreshToken: "rt", expiresAt: 999 })
  const after = JSON.parse(readFileSync(path, "utf8"))
  expect(after.claudeAiOauth.accessToken).toBe("new")
})
