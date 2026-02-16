// SPDX-License-Identifier: GPL-2.0-or-later
// Rotation logger for main process — writes to userData/logs/

import { app } from 'electron'
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  appendFileSync,
} from 'node:fs'

const LOG_FILE_PREFIX = 'pipette-'
const LOG_FILE_EXT = '.log'
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const MAX_GENERATIONS = 5 // pipette-0.log through pipette-4.log

let logDir = ''
let initialized = false

function getLogDir(): string {
  if (!logDir) {
    logDir = join(app.getPath('userData'), 'logs')
  }
  return logDir
}

function logFilePath(generation: number): string {
  return join(getLogDir(), `${LOG_FILE_PREFIX}${generation}${LOG_FILE_EXT}`)
}

function ensureLogDir(): void {
  const dir = getLogDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function rotate(): void {
  const oldest = logFilePath(MAX_GENERATIONS - 1)
  if (existsSync(oldest)) {
    unlinkSync(oldest)
  }
  for (let i = MAX_GENERATIONS - 2; i >= 0; i--) {
    const src = logFilePath(i)
    if (existsSync(src)) {
      renameSync(src, logFilePath(i + 1))
    }
  }
}

function shouldRotate(): boolean {
  const current = logFilePath(0)
  if (!existsSync(current)) return false
  try {
    const stats = statSync(current)
    return stats.size >= MAX_FILE_SIZE
  } catch {
    return false
  }
}

function formatTimestamp(): string {
  return new Date().toISOString()
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export function log(level: LogLevel, message: string): void {
  if (!initialized) {
    ensureLogDir()
    initialized = true
  }
  if (shouldRotate()) {
    rotate()
  }
  const line = `[${formatTimestamp()}] [${level.toUpperCase()}] ${message}\n`
  appendFileSync(logFilePath(0), line, 'utf-8')
}

export function logHidPacket(direction: 'TX' | 'RX', data: Uint8Array): void {
  if (!process.env.VIAL_DEBUG_HID) return
  const hex = Array.from(data)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
  log('debug', `HID ${direction}: ${hex}`)
}

export function getLogPath(): string {
  return getLogDir()
}
