import type { Job } from "../types"

// The field table, the kind contract, and the pure validation helpers around
// it. Split out of index.ts because every kind needs these while index.ts
// imports every kind to build the registry: entering the graph at a kind then
// hit that cycle and threw before the kind's own module body ran, which made
// its test file unrunnable on its own.
export type FieldType = "string" | "number" | "boolean" | "string[]" | "object"

export interface Field {
  name: string
  type: FieldType
  required?: boolean
  default?: unknown
  doc: string
}

// What the loader hands a kind: everything it validated itself, plus the
// options it did not look inside.
export interface JobSpec {
  name: string
  dir: string
  repo?: string
  // Engine-level, so the loader resolves and checks it and the kind only
  // renders it. `append` is already an absolute path by the time a kind sees it.
  brief?: { extends?: string; append?: string }
  options: Record<string, unknown>
}

export interface Kind {
  name: string
  workload: string
  fields: Field[]
  // Validation a field table cannot express: an enum, or the shape inside an
  // object option. Returns messages in validateOptions' vocabulary, which the
  // loader prefixes with the job file. A typo like "reserved" for "reserve"
  // parses clean and silently disarms whatever it configures, so a kind with an
  // enum or an object option owes the operator this.
  check?(spec: JobSpec): string[]
  build(spec: JobSpec): Job
}

function levenshtein(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) d[i]![0] = i
  for (let j = 0; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return d[a.length]![b.length]!
}

// A typo is worth a suggestion; a different word is not. The threshold keeps
// "did you mean" from firing on names that merely start with the same letter.
export function didYouMean(word: string, candidates: string[]): string {
  let best = ""
  let bestD = Infinity
  for (const c of candidates) {
    const d = levenshtein(word, c)
    if (d < bestD) { bestD = d; best = c }
  }
  // Two edits, not one: a transposition costs two, and "wbe" for "web" is the
  // most common typo there is. A floor of one makes the suggester blind to it
  // for every short word, which is most repo keys and kind names.
  return bestD <= Math.max(2, Math.floor(word.length * 0.4)) ? best : ""
}

// The unknown-key message, in the same shape validateOptions produces for an
// unknown option. A typo is the whole reason these checks exist, so a message
// that lists the known keys without pointing at the near miss is half a fix.
export function unknownKey(key: string, known: string[]): string {
  const near = didYouMean(key, known)
  return near
    ? `unknown key "${key}"; did you mean "${near}"?`
    : `unknown key "${key}"; known: ${known.join(", ")}`
}

export function oneOf(field: string, value: string, allowed: string[]): string[] {
  if (allowed.includes(value)) return []
  const near = didYouMean(value, allowed)
  return [
    near
      ? `options.${field} must be one of ${allowed.join(", ")}; did you mean "${near}"?`
      : `options.${field} must be one of ${allowed.join(", ")}`,
  ]
}

// Names the shape a value has, in the vocabulary the field table uses, so the
// error an operator reads is in the same words as the documentation.
function shapeOf(v: unknown): string {
  if (Array.isArray(v)) return "list"
  if (v === null) return "null"
  return typeof v
}

function typeOk(v: unknown, t: FieldType): boolean {
  switch (t) {
    case "string": return typeof v === "string"
    case "number": return typeof v === "number" && Number.isFinite(v)
    case "boolean": return typeof v === "boolean"
    case "string[]": return Array.isArray(v) && v.every((x) => typeof x === "string")
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v)
  }
}

export function validateOptions(
  kind: Kind,
  options: Record<string, unknown>,
): { errors: string[]; value: Record<string, unknown> } {
  const errors: string[] = []
  const known = kind.fields.map((f) => f.name)

  for (const key of Object.keys(options)) {
    if (known.includes(key)) continue
    const near = didYouMean(key, known)
    errors.push(
      near
        ? `unknown option "${key}"; did you mean "${near}"?`
        : `unknown option "${key}"; known: ${known.join(", ")}`,
    )
  }

  const value: Record<string, unknown> = {}
  for (const f of kind.fields) {
    const given = options[f.name]
    if (given === undefined || given === null) {
      if (f.required) errors.push(`options.${f.name} is required (${f.doc})`)
      else if (f.default !== undefined) value[f.name] = f.default
      continue
    }
    if (!typeOk(given, f.type)) {
      errors.push(
        f.type === "string[]"
          ? `options.${f.name} must be a list of strings`
          : `options.${f.name} must be a ${f.type}, found ${shapeOf(given)}`,
      )
      continue
    }
    value[f.name] = given
  }
  return { errors, value }
}

export function describeKind(k: Kind): string[] {
  const notes = k.fields.map((f) => (f.required ? "required" : `= ${JSON.stringify(f.default)}`))
  const width = Math.max(...k.fields.map((f) => f.name.length))
  const typeWidth = Math.max(...k.fields.map((f) => f.type.length))
  const noteWidth = Math.max(...notes.map((n) => n.length))
  const lines = [`${k.name} (workload: ${k.workload})`]
  k.fields.forEach((f, i) => {
    lines.push(
      `  ${f.name.padEnd(width)}  ${f.type.padEnd(typeWidth)}  ${notes[i]!.padEnd(noteWidth)}  ${f.doc}`,
    )
  })
  return lines
}

const JSON_TYPE: Record<FieldType, object> = {
  string: { type: "string" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  "string[]": { type: "array", items: { type: "string" } },
  object: { type: "object" },
}

export function kindSchema(k: Kind): object {
  const properties: Record<string, object> = {}
  for (const f of k.fields) {
    properties[f.name] = {
      ...JSON_TYPE[f.type],
      ...(f.default === undefined ? {} : { default: f.default }),
      description: f.doc,
    }
  }
  return {
    type: "object",
    properties,
    required: k.fields.filter((f) => f.required).map((f) => f.name),
    additionalProperties: false,
  }
}
