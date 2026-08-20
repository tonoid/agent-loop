import { test, expect } from "bun:test"
import { parseConfig, DEFAULTS, selects } from "../src/config"
import { homedir } from "node:os"

const good = `
accounts:
  - { id: loop, provider: claude, configDir: ~/.claude-loop, reserve: 0 }
  - { id: alt,  provider: codex,  configDir: ~/.codex,       reserve: 20 }
workspaces:
  - ~/projects/acme/agent-loop
`

test("a minimal config parses clean and expands account paths", () => {
  const { config, errors } = parseConfig(good)
  expect(errors).toEqual([])
  expect(config.accounts.map((a) => a.id)).toEqual(["loop", "alt"])
  expect(config.accounts[0]!.configDir).toBe(`${homedir()}/.claude-loop`)
  expect(config.workspaces).toEqual([`${homedir()}/projects/acme/agent-loop`])
})

test("the clamps default rather than being required of every operator", () => {
  const { config } = parseConfig(good)
  expect(config.maxSpawnsPerDay).toBe(DEFAULTS.maxSpawnsPerDay)
  expect(config.workerRateSeed).toBe(DEFAULTS.workerRateSeed)
})

test("an explicit clamp wins over its default", () => {
  const { config, errors } = parseConfig(`${good}\nmaxSpawnsPerDay: 12\n`)
  expect(errors).toEqual([])
  expect(config.maxSpawnsPerDay).toBe(12)
})

test("a config that is not a mapping is rejected", () => {
  expect(parseConfig("- a\n- b").errors).toEqual(["config must be a mapping of settings"])
})

test("unparseable YAML is reported as one error, not a crash", () => {
  const { errors } = parseConfig("accounts: [\n")
  expect(errors.length).toBe(1)
  expect(errors[0]).toStartWith("config is not valid YAML")
})

test("a config with no accounts is rejected", () => {
  expect(parseConfig("workspaces: [~/x]").errors).toEqual(["accounts must be a non-empty list"])
})

test("a config with no workspaces is rejected", () => {
  const { errors } = parseConfig("accounts:\n  - { id: loop, provider: claude, configDir: ~/.a }")
  expect(errors).toEqual(["workspaces must be a non-empty list of paths"])
})

test("a duplicate account id is rejected", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude, configDir: ~/.a }
  - { id: loop, provider: codex,  configDir: ~/.b }
workspaces: [~/x]
`)
  expect(errors).toContain('duplicate account id "loop"')
})

test("an unknown provider is rejected, with the known ones listed", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: clawd, configDir: ~/.a }
workspaces: [~/x]
`)
  expect(errors).toContain('account "loop": unknown provider "clawd"; known: claude, codex, grok')
})

test("a reserve outside 0..100 is rejected", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude, configDir: ~/.a, reserve: 140 }
workspaces: [~/x]
`)
  expect(errors).toContain('account "loop": reserve must be between 0 and 100')
})

test("an account missing its config directory is rejected", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude }
workspaces: [~/x]
`)
  expect(errors).toContain('account "loop": configDir is required')
})

test("a non-positive worker rate seed is rejected", () => {
  const { errors } = parseConfig(`${good}\nworkerRateSeed: 0\n`)
  expect(errors).toContain("workerRateSeed must be greater than 0")
})

test("a clamp that is not a number is rejected rather than coerced", () => {
  const { errors } = parseConfig(`${good}\nminFreeMb: lots\n`)
  expect(errors).toContain("minFreeMb must be a number")
})

test("a relative workspace path is rejected", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude, configDir: ~/.a }
workspaces:
  - acme/web
`)
  expect(errors).toContain('workspaces[0] "acme/web" must be an absolute path or start with ~')
})

test("a non-string workspace entry is rejected alongside a valid one", () => {
  const { config, errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude, configDir: ~/.a }
workspaces:
  - ~/x
  - 42
`)
  expect(errors).toContain("workspaces[1] must be a path")
  expect(config.workspaces).toEqual([`${homedir()}/x`])
})

test("a non-numeric maxConcurrent is rejected", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude, configDir: ~/.a, maxConcurrent: four }
workspaces: [~/x]
`)
  expect(errors).toContain('account "loop": maxConcurrent must be a number')
})

test("a non-list startArgs is rejected", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude, configDir: ~/.a, startArgs: --flag }
workspaces: [~/x]
`)
  expect(errors).toContain('account "loop": startArgs must be a list of strings')
})

test("a non-boolean allowWhenUnreadable is rejected", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude, configDir: ~/.a, allowWhenUnreadable: 1 }
workspaces: [~/x]
`)
  expect(errors).toContain('account "loop": allowWhenUnreadable must be true or false')
})

test("a non-string agentKind is rejected", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: claude, configDir: ~/.a, agentKind: 7 }
workspaces: [~/x]
`)
  expect(errors).toContain('account "loop": agentKind must be a string')
})

test("a fully populated account passes every optional field through unchanged", () => {
  const { config, errors } = parseConfig(`
accounts:
  - id: loop
    provider: claude
    configDir: ~/.claude-loop
    reserve: 10
    reservePerWeekday: 5
    weekendWeight: 0.5
    maxConcurrent: 2
    allowWhenUnreadable: true
    agentKind: coder
    startArgs: ["--flag", "value"]
    model: opus
    oauthClientId: client-123
    configEnv: CLAUDE_CONFIG_DIR
workspaces: [~/x]
`)
  expect(errors).toEqual([])
  expect(config.accounts[0]).toEqual({
    id: "loop",
    provider: "claude",
    configDir: `${homedir()}/.claude-loop`,
    reserve: 10,
    reservePerWeekday: 5,
    weekendWeight: 0.5,
    maxConcurrent: 2,
    allowWhenUnreadable: true,
    agentKind: "coder",
    startArgs: ["--flag", "value"],
    model: "opus",
    oauthClientId: "client-123",
    configEnv: "CLAUDE_CONFIG_DIR",
  })
})

test("every error is reported, not just the first", () => {
  const { errors } = parseConfig(`
accounts:
  - { id: loop, provider: clawd, configDir: ~/.a, reserve: 140 }
workspaces: []
`)
  expect(errors.length).toBe(3)
})

test("a selector matches an account by id or by provider", () => {
  const a = { id: "loop", provider: "claude", configDir: "/x", reserve: 0 } as const
  expect(selects(a, "loop")).toBe(true)
  expect(selects(a, "claude")).toBe(true)
  expect(selects(a, "codex")).toBe(false)
})

test("a typo'd account key is an error, not a silent default", () => {
  // `reserved: 40` used to parse clean, leaving reserve at 0: the one
  // mechanism that keeps the loop out of a human's quota, gone with nothing
  // said.
  const { errors } = parseConfig(`
accounts:
  - { id: main, provider: claude, configDir: ~/.claude, reserved: 40 }
workspaces:
  - ~/projects/acme/agent-loop
`)
  expect(errors).toEqual(['account "main": unknown key "reserved"; did you mean "reserve"?'])
})

test("a typo'd clamp is an error, not the default it silently left in place", () => {
  const { errors } = parseConfig(`${good}\nmaxSpawnsPerday: 5\n`)
  expect(errors).toEqual(['unknown key "maxSpawnsPerday"; did you mean "maxSpawnsPerDay"?'])
})

test("an unknown key with no near miss names the keys that exist", () => {
  const { errors } = parseConfig(`${good}\nquotaPolicy: aggressive\n`)
  expect(errors.length).toBe(1)
  expect(errors[0]).toStartWith('unknown key "quotaPolicy"; known: accounts, workspaces')
})
