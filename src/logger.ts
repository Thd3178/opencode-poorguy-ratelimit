import { appendFileSync, existsSync, statSync, truncateSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

export const LOG_FILE = join(homedir(), '.config', 'opencode', 'opencode-poorguy-ratelimit.log')

let logEnabled = true
export function setLogEnabled(v: boolean): void { logEnabled = v }

export function fileLog(level: string, msg: string): void {
  if (!logEnabled) return
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      truncateSync(LOG_FILE, 0)
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`)
  } catch {}
}
