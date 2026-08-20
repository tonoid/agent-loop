import { openSync, closeSync } from "node:fs"

export interface LockImpl {
  // Resolves once the lock is held; the returned function releases it.
  acquire(path: string): Promise<() => void>
}

export function lockPath(repo: string): string {
  return `${repo}/.git/agent-loop.lock`
}

export async function withRepoLock<T>(
  repo: string,
  impl: LockImpl,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await impl.acquire(lockPath(repo))
  try {
    return await fn()
  } finally {
    release()
  }
}

// In-process serialization, for tests and for a single tick's own passes.
export function memoryLock(): LockImpl {
  const chains = new Map<string, Promise<void>>()
  return {
    async acquire(path) {
      let release!: () => void
      const next = new Promise<void>((resolve) => { release = resolve })
      const previous = chains.get(path) ?? Promise.resolve()
      chains.set(path, previous.then(() => next))
      await previous
      return release
    },
  }
}

// An advisory whole-file lock through libc. Advisory and released by the
// kernel on process death, including SIGKILL, so no lock file is ever deleted
// by this program: an O_EXCL pidfile would deadlock permanently after a hard
// kill, and mtime staleness heuristics are worse.
export function fileLock(): LockImpl {
  // Known ceiling: flock here is synchronous with no LOCK_NB, so a contested
  // lock blocks the event loop. Upgrade path if that ever matters: LOCK_NB
  // plus a bounded poll.
  const LOCK_EX = 2
  return {
    async acquire(path) {
      const { dlopen, FFIType } = await import("bun:ffi")
      const { symbols } = dlopen("libc.so.6", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      })
      const fd = openSync(path, "a")
      if (symbols.flock(fd, LOCK_EX) !== 0) {
        closeSync(fd)
        throw new Error(`could not lock ${path}`)
      }
      return () => closeSync(fd) // closing the descriptor releases the lock
    },
  }
}
