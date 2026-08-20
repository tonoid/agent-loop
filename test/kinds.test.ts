import { test, expect } from "bun:test"
import { validateOptions, describeKind, kindSchema, didYouMean, oneOf, type Kind } from "../src/kinds"
import type { Job } from "../src/types"

const kind: Kind = {
  name: "builder",
  workload: "builder",
  fields: [
    { name: "base", type: "string", required: true, doc: "the ref new work branches from" },
    { name: "rounds", type: "number", default: 3, doc: "review rounds before parking" },
    { name: "deleteRemote", type: "boolean", default: false, doc: "delete the pushed branch on sweep" },
    { name: "copyIntoWorktree", type: "string[]", default: [], doc: "files copied into a fresh worktree" },
  ],
  build: (spec) =>
    ({
      name: spec.name,
      dir: spec.dir,
      workload: "builder",
      discover: async () => [],
      discoverClaimed: async () => [],
      key: async () => "",
      done: async () => false,
      brief: async () => "",
    }) as Job,
}

test("valid options pass and defaults are filled in", () => {
  const { errors, value } = validateOptions(kind, { base: "origin/develop" })
  expect(errors).toEqual([])
  expect(value).toEqual({
    base: "origin/develop",
    rounds: 3,
    deleteRemote: false,
    copyIntoWorktree: [],
  })
})

test("a missing required option is reported", () => {
  const { errors } = validateOptions(kind, {})
  expect(errors).toEqual(['options.base is required (the ref new work branches from)'])
})

test("an unknown option is reported with the nearest known one", () => {
  const { errors } = validateOptions(kind, { base: "main", round: 2 })
  expect(errors).toEqual(['unknown option "round"; did you mean "rounds"?'])
})

test("an unknown option with no near match lists what is known", () => {
  const { errors } = validateOptions(kind, { base: "main", zzz: 1 })
  expect(errors).toEqual([
    'unknown option "zzz"; known: base, rounds, deleteRemote, copyIntoWorktree',
  ])
})

test("a wrong type is reported with what was found", () => {
  const { errors } = validateOptions(kind, { base: 7 })
  expect(errors).toEqual(["options.base must be a string, found number"])
})

test("a list of the wrong element type is caught", () => {
  const { errors } = validateOptions(kind, { base: "main", copyIntoWorktree: [".env", 7] })
  expect(errors).toEqual(["options.copyIntoWorktree must be a list of strings"])
})

test("every option error is reported, not just the first", () => {
  const { errors } = validateOptions(kind, { rounds: "many", nope: 1 })
  expect(errors.length).toBe(3)
})

test("describeKind renders the field table as documentation", () => {
  expect(describeKind(kind)).toEqual([
    "builder (workload: builder)",
    "  base              string    required  the ref new work branches from",
    "  rounds            number    = 3       review rounds before parking",
    "  deleteRemote      boolean   = false   delete the pushed branch on sweep",
    "  copyIntoWorktree  string[]  = []      files copied into a fresh worktree",
  ])
})

test("describeKind's doc column stays aligned when a default is longer than \"required\"", () => {
  const longDefault: Kind = {
    name: "example",
    workload: "example",
    fields: [
      { name: "base", type: "string", required: true, doc: "the ref new work branches from" },
      {
        name: "note",
        type: "string",
        default: "a-fairly-long-default-value-here",
        doc: "a default longer than the word required",
      },
    ],
    build: (spec) =>
      ({
        name: spec.name,
        dir: spec.dir,
        workload: "example",
        discover: async () => [],
        discoverClaimed: async () => [],
        key: async () => "",
        done: async () => false,
        brief: async () => "",
      }) as Job,
  }
  const lines = describeKind(longDefault)
  expect(lines[2]!.indexOf("a default")).toBe(lines[1]!.indexOf("the ref"))
  expect(lines).toEqual([
    "example (workload: example)",
    '  base  string  required                              the ref new work branches from',
    '  note  string  = "a-fairly-long-default-value-here"  a default longer than the word required',
  ])
})

test("kindSchema emits JSON Schema for the same table", () => {
  const s = kindSchema(kind) as any
  expect(s.type).toBe("object")
  expect(s.required).toEqual(["base"])
  expect(s.additionalProperties).toBe(false)
  expect(s.properties.copyIntoWorktree).toEqual({
    type: "array",
    items: { type: "string" },
    default: [],
    description: "files copied into a fresh worktree",
  })
})

test("didYouMean suggests only a near miss", () => {
  expect(didYouMean("buidler", ["builder", "reviewer"])).toBe("builder")
  expect(didYouMean("wildly-different", ["builder", "reviewer"])).toBe("")
})

test("didYouMean catches a transposition in a short word", () => {
  expect(didYouMean("wbe", ["web", "api"])).toBe("web")
  expect(didYouMean("zzz", ["web", "api"])).toBe("")
})

test("a kind's check hook reports what the field table cannot", () => {
  const strict: Kind = {
    ...kind,
    check: (spec) => oneOf("identity", String(spec.options.identity ?? ""), ["pr", "closing-issue"]),
  }
  expect(strict.check!({ name: "r", dir: "/j/r", options: { identity: "pr" } })).toEqual([])
  expect(strict.check!({ name: "r", dir: "/j/r", options: { identity: "prr" } }))
    .toEqual(['options.identity must be one of pr, closing-issue; did you mean "pr"?'])
})
