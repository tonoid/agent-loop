export type Runner = (argv: string[]) => Promise<any>

// Every read the loop performs, as an argv prefix. Git's "-C <repo>" is
// stripped before matching, so only the verb matters here. Anything absent
// from this list is a mutation as far as a dry run is concerned, including
// commands nobody has thought of yet: refusing the unknown is what makes the
// read-only claim hold when a later plan adds a verb and forgets this file.
const READS: string[][] = [
  ["gh", "auth", "status"],
  ["gh", "issue", "list"],
  ["gh", "pr", "list"],
  ["gh", "pr", "view"],
  ["gh", "issue", "view"],
  ["gh", "api"],
  ["git", "worktree", "list"],
  ["git", "for-each-ref"],
  ["git", "ls-remote"],
  ["git", "remote", "get-url"],
  ["herdr", "agent", "list"],
  ["herdr", "agent", "read"],
  ["herdr", "agent", "get"],
  ["herdr", "pane", "list"],
  ["herdr", "workspace", "list"],
  ["herdr", "api", "schema"],
]

// `gh api` defaults to GET but switches to implicit POST when request parameters
// are added via -f / -F / --input. Any explicit method flag also makes it a write.
// The flag set covers both explicit methods and parameter flags that trigger POST.
const GH_API_WRITE = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "--input"])

function normalize(argv: string[]): string[] {
  if (argv[0] === "git" && argv[1] === "-C") return ["git", ...argv.slice(3)]
  return argv
}

export function assertReadOnly(argv: string[]): void {
  const a = normalize(argv)
  const allowed = READS.some((prefix) => prefix.every((word, i) => a[i] === word))
  const ghApiWrite = a[0] === "gh" && a[1] === "api" && a.some((w) => GH_API_WRITE.has(w))
  if (!allowed || ghApiWrite) {
    throw new Error(`refusing to run "${argv.join(" ")}" without --live`)
  }
}

async function spawnText(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${err.trim()}`)
  return out
}

export function makeRunners(live: boolean) {
  const runText = async (argv: string[]): Promise<string> => {
    if (!live) assertReadOnly(argv)
    return spawnText(argv)
  }
  const runJson = async <T,>(argv: string[]): Promise<T> => JSON.parse(await runText(argv)) as T
  return { runText, runJson }
}
