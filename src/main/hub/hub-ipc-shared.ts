// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: input validators + small pure helpers shared across every
// hub-ipc-*.ts sibling. Split out of hub-ipc.ts to keep it under the
// project's 800-line Service/Util size ceiling.

import type { HubUploadPostParams } from '../../shared/types/hub'
import type { HubUploadFiles } from './hub-client'

export const POST_ID_RE = /^[a-zA-Z0-9_-]+$/

export function validatePostId(postId: string): void {
  if (!postId || !POST_ID_RE.test(postId)) {
    throw new Error('Invalid post ID')
  }
}

const DISPLAY_NAME_MAX_LENGTH = 50

export function validateDisplayName(displayName: unknown): string {
  if (displayName == null || typeof displayName !== 'string') throw new Error('Display name must not be empty')
  const trimmed = displayName.trim()
  if (trimmed.length === 0) throw new Error('Display name must not be empty')
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) throw new Error('Display name too long')
  return trimmed
}

const KEYBOARD_NAME_MAX_LENGTH = 100

export function validateKeyboardName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error('Missing keyboard name')
  const trimmed = name.trim()
  if (trimmed.length > KEYBOARD_NAME_MAX_LENGTH) throw new Error('Keyboard name too long')
  return trimmed
}

const TITLE_MAX_LENGTH = 200

export function validateTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('Title must not be empty')
  const trimmed = title.trim()
  if (trimmed.length > TITLE_MAX_LENGTH) throw new Error('Title too long')
  return trimmed
}

export function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null) return undefined
  const floored = Math.floor(value)
  if (!Number.isFinite(floored)) return undefined
  return Math.max(min, Math.min(max, floored))
}

export function sanitizeFilenameBase(productName: string, fallback: string): string {
  const source = (productName || fallback || 'analytics').replace(/[^a-zA-Z0-9_-]/g, '_')
  return source.length > 0 ? source : 'analytics'
}

export function computeTotalPages(total: number, perPage: number): number {
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0
  const safePerPage = Number.isFinite(perPage) && perPage > 0 ? perPage : 1
  return Math.max(1, Math.ceil(safeTotal / safePerPage))
}

export function extractError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

const MB = 1024 * 1024
const FILE_SIZE_LIMITS: Record<string, { max: number; label: string }> = {
  thumbnail: { max: 2 * MB, label: 'thumbnail' },
  vil: { max: 10 * MB, label: 'vil' },
  pipette: { max: 10 * MB, label: 'pipette' },
  c: { max: 10 * MB, label: 'keymap C' },
  pdf: { max: 10 * MB, label: 'PDF' },
}

function validateFileSize(files: HubUploadFiles): void {
  for (const [key, limit] of Object.entries(FILE_SIZE_LIMITS)) {
    const file = files[key as keyof HubUploadFiles]
    if (file.data.byteLength > limit.max) {
      throw new Error(`File too large: ${limit.label} exceeds ${limit.max / MB} MB limit`)
    }
  }
}

export function buildFiles(params: HubUploadPostParams): HubUploadFiles {
  const baseName = params.keyboardName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const files: HubUploadFiles = {
    vil: { name: `${baseName}.vil`, data: Buffer.from(params.vilJson, 'utf-8') },
    pipette: { name: `${baseName}.pipette`, data: Buffer.from(params.pipetteJson, 'utf-8') },
    c: { name: `${baseName}.c`, data: Buffer.from(params.keymapC, 'utf-8') },
    pdf: { name: `${baseName}.pdf`, data: Buffer.from(params.pdfBase64, 'base64') },
    thumbnail: { name: `${baseName}.jpg`, data: Buffer.from(params.thumbnailBase64, 'base64') },
  }
  validateFileSize(files)
  return files
}
