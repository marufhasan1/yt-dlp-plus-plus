import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

/**
 * Stops a process and everything it started. yt-dlp's standalone builds are
 * self-extracting launchers that run the real program as a child, and yt-dlp
 * in turn starts FFmpeg and Deno — killing only the top process would leave
 * those running.
 *
 * Unix: the process must have been spawned with `detached: true` so it leads
 * its own process group; the whole group gets SIGTERM, then SIGKILL.
 * Windows: `taskkill /T /F` ends the tree.
 */
export function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(forceTimer)
      resolve()
    }
    child.once('exit', done)
    const forceTimer = setTimeout(() => {
      try {
        if (platform !== 'win32') process.kill(-pid, 'SIGKILL')
        else child.kill()
      } catch {
        // Already gone.
      }
      // Do not wait forever if the exit event never arrives.
      setTimeout(resolve, 1000)
    }, 5000)

    try {
      if (platform === 'win32') {
        const taskkill = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe')
        spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('error', () =>
          child.kill()
        )
      } else {
        process.kill(-pid, 'SIGTERM')
      }
    } catch {
      child.kill()
    }
  })
}
