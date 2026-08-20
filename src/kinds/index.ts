import type { Kind } from "./validate"
import { builder } from "./builder"
import { reviewer } from "./reviewer"
import { routine } from "./routine"

// The shipped kinds, and the whole registry. Nothing under a project folder is
// imported, so this is a contract between the engine and these three rather
// than an extension point (spec 5).
export const KINDS: Record<string, Kind> = { builder, reviewer, routine }

// The public surface of "./kinds" is unchanged: every existing importer, the
// loader included, still reads the field table and the helpers from here.
export * from "./validate"
