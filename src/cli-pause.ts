import { existsSync } from "node:fs"

// Pause blocks spawn only. Sweep and monitor always run: the monitor is what
// removes a claim label from a merged PR, so a pause that froze it would
// manufacture lying claims.
export function pausedJobs(stateDir: string, jobs: string[]): string[] {
  // Only `pause`, which is what pauseMarker writes for the workspace-wide
  // form. A `pause-all` alias would make a job named "all", a legal job name,
  // pause the whole workspace.
  if (existsSync(`${stateDir}/pause`)) return [...jobs]
  return jobs.filter((name) => existsSync(`${stateDir}/pause-${name}`))
}

export function pauseMarker(stateDir: string, job?: string): string {
  return job ? `${stateDir}/pause-${job}` : `${stateDir}/pause`
}
