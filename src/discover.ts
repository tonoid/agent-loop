import { existsSync, readdirSync, readFileSync } from "node:fs"
import { agentLoopHome, resolveFrom } from "./paths"
import { selects } from "./config"
import { didYouMean, unknownKey, validateOptions, type Kind } from "./kinds"
import type { AccountConfig, Config, Job, NamingConfig, WorkspaceConfig } from "./types"

// A job name reaches branch names, worktree paths, and herdr tab labels, so it
// is checked here rather than discovered as a broken ref later.
export const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

// An unknown key is a typo, and every typo below used to parse clean:
// `naming.mergemethod: merge` left mergeMethod at squash and silently changed
// how PRs get merged, and `slot: 9` was simply ignored. Spec 3.5 makes `check`
// the thing that catches this at the commit that broke it.
const WORKSPACE_KEYS = ["name", "herdrWorkspace", "worktreeBase", "repos", "naming"]
const NAMING_KEYS = ["labels", "mergeMethod"]
const LABEL_KEYS = ["claim", "failed", "park", "priority"]
// `options` is opaque to the loader and validated by the kind; everything else
// here is engine-level and validated for every kind (spec 3.3).
const JOB_KEYS = ["kind", "repo", "slots", "order", "model", "requires", "prefer", "distinctFrom", "brief", "options"]

export interface LoadOpts {
  kinds: Record<string, Kind>
  accounts: AccountConfig[]
  // False for `check <path>` on a folder with no machine config: there are no
  // accounts to check selectors against, and reporting them all as broken
  // would be worse than saying they were not checked.
  checkSelectors: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function readYaml(path: string): { value: Record<string, unknown>; error?: string } {
  try {
    const parsed = Bun.YAML.parse(readFileSync(path, "utf8"))
    if (!isRecord(parsed)) return { value: {}, error: "must be a mapping" }
    return { value: parsed }
  } catch (e) {
    return { value: {}, error: `is not valid YAML: ${String(e)}` }
  }
}

function naming(raw: unknown, errs: string[]): NamingConfig {
  const n = isRecord(raw) ? raw : {}
  for (const key of Object.keys(n)) {
    if (!NAMING_KEYS.includes(key)) errs.push(`workspace.yml: naming: ${unknownKey(key, NAMING_KEYS)}`)
  }
  const labels = isRecord(n.labels) ? n.labels : {}
  for (const key of Object.keys(labels)) {
    if (!LABEL_KEYS.includes(key)) errs.push(`workspace.yml: naming.labels: ${unknownKey(key, LABEL_KEYS)}`)
  }
  for (const key of ["claim", "failed", "park"]) {
    // Empty is not "unset with a default": an empty claim label never sticks,
    // so the claim check fails forever and every tick logs "claim did not
    // stick" for every item.
    if (typeof labels[key] !== "string") errs.push(`workspace.yml: naming.labels.${key} is required`)
    else if (labels[key] === "") errs.push(`workspace.yml: naming.labels.${key} must not be empty`)
  }
  // A scalar here silently became [], dropping the builder's priority ordering.
  if (labels.priority !== undefined && labels.priority !== null
      && !(Array.isArray(labels.priority) && labels.priority.every((x) => typeof x === "string"))) {
    errs.push("workspace.yml: naming.labels.priority must be a list of strings")
  }
  const merge = n.mergeMethod ?? "squash"
  if (merge !== "merge" && merge !== "squash") {
    errs.push(`workspace.yml: naming.mergeMethod must be merge or squash`)
  }
  return {
    labels: {
      claim: String(labels.claim ?? ""),
      failed: String(labels.failed ?? ""),
      park: String(labels.park ?? ""),
      priority: Array.isArray(labels.priority) ? labels.priority.map(String) : [],
    },
    mergeMethod: merge === "merge" ? "merge" : "squash",
  }
}

function loadJob(
  dir: string,
  name: string,
  repos: Record<string, string>,
  o: LoadOpts,
  errs: string[],
): Job | null {
  const at = `${name}/job.yml`
  // Errors accumulate into the workspace's list, so this job's own success is
  // measured against where that list started, not whether it is empty.
  const before = errs.length
  if (!JOB_NAME.test(name)) {
    errs.push(`${name}: a job folder name must match ${JOB_NAME.source}, because it names branches and worktrees`)
    return null
  }
  const { value: raw, error } = readYaml(`${dir}/${name}/job.yml`)
  if (error) { errs.push(`${at} ${error}`); return null }

  for (const key of Object.keys(raw)) {
    if (!JOB_KEYS.includes(key)) errs.push(`${at}: ${unknownKey(key, JOB_KEYS)}`)
  }

  if (raw.kind === undefined || raw.kind === null || raw.kind === "") {
    errs.push(`${at}: kind is required, and must name a shipped kind`)
    return null
  }
  const kindName = String(raw.kind)
  const kind = o.kinds[kindName]
  if (!kind) {
    const known = Object.keys(o.kinds)
    const near = didYouMean(kindName, known)
    errs.push(
      near ? `${at}: unknown kind "${kindName}"; did you mean "${near}"?`
      : known.length ? `${at}: unknown kind "${kindName}"; known: ${known.join(", ")}`
      : `${at}: unknown kind "${kindName}"; no kinds are registered`,
    )
    return null
  }

  const repo = typeof raw.repo === "string" ? raw.repo : ""
  if (!repo) {
    errs.push(`${at}: repo is required, and must be a key of workspace.yml repos`)
  } else if (!(repo in repos)) {
    const near = didYouMean(repo, Object.keys(repos))
    errs.push(
      near
        ? `${at}: repo "${repo}" is not a key of repos; did you mean "${near}"?`
        : `${at}: repo "${repo}" is not a key of repos; known: ${Object.keys(repos).join(", ")}`,
    )
  }

  const selectors = (field: "requires" | "prefer"): string[] => {
    const v = raw[field]
    if (v === undefined) return []
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      errs.push(`${at}: ${field} must be a list of account selectors`)
      return []
    }
    if (o.checkSelectors) {
      for (const sel of v as string[]) {
        if (!o.accounts.some((a) => selects(a, sel))) {
          errs.push(`${at}: ${field} "${sel}", which matches no account`)
        }
      }
    }
    return v as string[]
  }
  const requires = selectors("requires")
  const prefer = selectors("prefer")

  // The brief config is engine-level: the loader resolves and checks it, the
  // kind renders it. `append` resolves against the job folder, so a versioned
  // folder carries its own prose and travels with it.
  let brief: { extends?: string; append?: string } | undefined
  if (raw.brief !== undefined) {
    if (!isRecord(raw.brief)) {
      errs.push(`${at}: brief must be a mapping of extends and append`)
    } else {
      brief = {}
      const ext = raw.brief.extends
      if (ext !== undefined) {
        if (typeof ext !== "string") errs.push(`${at}: brief.extends must be a name like default/build`)
        else brief.extends = ext
      }
      const append = raw.brief.append
      if (append !== undefined) {
        if (typeof append !== "string") {
          errs.push(`${at}: brief.append must be a path`)
        } else {
          const path = resolveFrom(`${dir}/${name}`, append)
          if (!existsSync(path)) errs.push(`${at}: brief.append "${append}" does not exist`)
          brief.append = path
        }
      }
    }
  }

  // Reported the way every other field here is: `slots: "4"` silently became
  // 1 and `order: "10"` silently became 100, and both are load-bearing.
  if (raw.slots !== undefined && typeof raw.slots !== "number") errs.push(`${at}: slots must be a number`)
  if (raw.order !== undefined && typeof raw.order !== "number") errs.push(`${at}: order must be a number`)
  if (raw.distinctFrom !== undefined && typeof raw.distinctFrom !== "boolean") {
    errs.push(`${at}: distinctFrom must be true or false`)
  }
  if (raw.model !== undefined && (typeof raw.model !== "string" || !raw.model)) {
    errs.push(`${at}: model must be the agent's own model name, like opus or sonnet`)
  }

  const options = isRecord(raw.options) ? raw.options : {}
  if (raw.options !== undefined && !isRecord(raw.options)) {
    errs.push(`${at}: options must be a mapping`)
  }
  const { errors: optionErrors, value } = validateOptions(kind, options)
  for (const e of optionErrors) errs.push(`${at}: ${e}`)
  // The kind's own checks run against the validated values, so a check never
  // sees a missing default or a wrong type it would have to re-test.
  if (kind.check && optionErrors.length === 0) {
    for (const e of kind.check({ name, dir: `${dir}/${name}`, repo, brief, options: value })) {
      errs.push(`${at}: ${e}`)
    }
  }

  if (errs.length > before) return null

  const jobDir = `${dir}/${name}`
  const built = kind.build({ name, dir: jobDir, repo, brief, options: value })
  // The engine-level fields are the loader's, whatever the kind returned for
  // them: they are validated here, so they are authoritative here.
  return {
    ...built,
    name,
    dir: jobDir,
    repo,
    slots: typeof raw.slots === "number" ? raw.slots : built.slots,
    order: typeof raw.order === "number" ? raw.order : 100,
    model: typeof raw.model === "string" && raw.model ? raw.model : built.model,
    requires: requires.length ? requires : undefined,
    prefer: prefer.length ? prefer : undefined,
    distinctFrom: raw.distinctFrom === true ? true : built.distinctFrom,
  }
}

export function loadWorkspace(dir: string, o: LoadOpts): { ws?: WorkspaceConfig; errors: string[] } {
  const errs: string[] = []
  if (!existsSync(`${dir}/workspace.yml`)) return { errors: [`${dir}: no workspace.yml`] }

  const { value: raw, error } = readYaml(`${dir}/workspace.yml`)
  if (error) return { errors: [`${dir}: workspace.yml ${error}`] }

  const name = String(raw.name ?? "")
  if (!JOB_NAME.test(name)) {
    errs.push(`workspace.yml: name "${name}" must match ${JOB_NAME.source}, because it names the state directory`)
  }
  if (typeof raw.herdrWorkspace !== "string" || !raw.herdrWorkspace) {
    errs.push("workspace.yml: herdrWorkspace is required")
  }
  if (typeof raw.worktreeBase !== "string" || !raw.worktreeBase) {
    errs.push("workspace.yml: worktreeBase is required")
  }
  const repos: Record<string, string> = {}
  if (!isRecord(raw.repos) || Object.keys(raw.repos).length === 0) {
    errs.push("workspace.yml: repos must name at least one repository")
  } else {
    for (const [key, path] of Object.entries(raw.repos)) {
      if (typeof path !== "string") errs.push(`workspace.yml: repos.${key} must be a path`)
      else repos[key] = resolveFrom(dir, path)
    }
  }
  const namingConfig = naming(raw.naming, errs)

  for (const key of Object.keys(raw)) {
    if (!WORKSPACE_KEYS.includes(key)) errs.push(`workspace.yml: ${unknownKey(key, WORKSPACE_KEYS)}`)
  }

  const jobs: Job[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!existsSync(`${dir}/${entry.name}/job.yml`)) continue
    const job = loadJob(dir, entry.name, repos, o, errs)
    if (job) jobs.push(job)
  }
  // Cross-job, so it belongs here rather than in a kind: a kind's own check
  // sees one job.yml and cannot know what else the workspace holds. Left to
  // run time, a typo here reaches filingBudget() only under --live, after the
  // item is claimed, and tombstones a real pull request with the failed label.
  const names = jobs.map((j) => j.name)
  for (const job of jobs) {
    const queue = job.filing?.queue
    if (!queue || names.includes(queue)) continue
    const near = didYouMean(queue, names)
    errs.push(
      near
        ? `${job.name}/job.yml: options.filing.queue "${queue}" names no job in this workspace; did you mean "${near}"?`
        : `${job.name}/job.yml: options.filing.queue "${queue}" names no job in this workspace; known: ${names.join(", ")}`,
    )
  }

  // Order carries meaning: reviewers before builders, so a merge in this tick
  // relieves the builder's review-debt throttle in the same tick.
  jobs.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name))

  if (errs.length) return { errors: errs }
  return {
    ws: {
      name,
      dir,
      herdrWorkspace: String(raw.herdrWorkspace),
      worktreeBase: resolveFrom(dir, String(raw.worktreeBase)),
      repos,
      naming: namingConfig,
      journalPath: `${agentLoopHome()}/${name}/journal.md`,
      jobs,
    },
    errors: [],
  }
}

export function discover(
  config: Config,
  o: LoadOpts,
): { workspaces: WorkspaceConfig[]; errors: string[] } {
  const errors: string[] = []
  const loaded: WorkspaceConfig[] = []

  for (const dir of config.workspaces) {
    // A workspace folder can be unreadable (mode 111, a dead mount, ELOOP, a
    // checkout owned by another uid) and a kind's build() can throw, and
    // neither may stop the rest of the box: only a bad config.yml aborts a
    // tick (spec 3.4). The reason is pushed into the errors the caller
    // reports every tick, so it is contained rather than silenced.
    try {
      const { ws, errors: errs } = loadWorkspace(dir, o)
      for (const e of errs) errors.push(e.startsWith(dir) ? e : `${dir}: ${e}`)
      if (ws) loaded.push(ws)
    } catch (e) {
      errors.push(`${dir}: ${String(e)}`)
    }
  }

  // A repo in two workspaces collides on .git/worktrees and index.lock, and a
  // duplicate name collides on the state directory. Neither claimant is
  // knowably the right one, so both stand down and say so.
  const bad = new Set<string>()
  const byName = new Map<string, string[]>()
  const byRepo = new Map<string, string[]>()
  for (const ws of loaded) {
    byName.set(ws.name, [...(byName.get(ws.name) ?? []), ws.dir])
    for (const repo of Object.values(ws.repos)) {
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), ws.dir])
    }
  }
  for (const [name, dirs] of byName) {
    if (dirs.length < 2) continue
    errors.push(`workspace name "${name}" is used by more than one folder: ${dirs.join(", ")}`)
    for (const d of dirs) bad.add(d)
  }
  for (const [repo, dirs] of byRepo) {
    if (dirs.length < 2) continue
    errors.push(`repo "${repo}" is claimed by more than one workspace: ${dirs.join(", ")}`)
    for (const d of dirs) bad.add(d)
  }

  return { workspaces: loaded.filter((w) => !bad.has(w.dir)), errors }
}
