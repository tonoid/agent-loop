import { test, expect } from "bun:test"
import { homedir } from "node:os"
import { expandHome, resolveFrom, agentLoopHome } from "../src/paths"

test("expandHome expands a leading tilde and leaves everything else alone", () => {
  expect(expandHome("~/x")).toBe(`${homedir()}/x`)
  expect(expandHome("~")).toBe(homedir())
  expect(expandHome("/abs")).toBe("/abs")
  expect(expandHome("~notauser/x")).toBe("~notauser/x")
})

test("a relative path resolves against the file's own directory", () => {
  expect(resolveFrom("/p/acme/agent-loop", "../web")).toBe("/p/acme/web")
  expect(resolveFrom("/p/acme/agent-loop", ".")).toBe("/p/acme/agent-loop")
})

test("an absolute path and a tilde path ignore the base", () => {
  expect(resolveFrom("/p/acme/agent-loop", "/elsewhere")).toBe("/elsewhere")
  expect(resolveFrom("/p/acme/agent-loop", "~/x")).toBe(`${homedir()}/x`)
})

test("the state home is overridable, so tests never touch the real one", () => {
  const saved = process.env.AGENT_LOOP_HOME
  process.env.AGENT_LOOP_HOME = "/tmp/al-test"
  expect(agentLoopHome()).toBe("/tmp/al-test")
  if (saved === undefined) delete process.env.AGENT_LOOP_HOME
  else process.env.AGENT_LOOP_HOME = saved
  expect(agentLoopHome()).toBe(`${homedir()}/.agent-loop`)
})
