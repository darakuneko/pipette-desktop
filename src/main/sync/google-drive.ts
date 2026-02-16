// SPDX-License-Identifier: GPL-2.0-or-later
// Google Drive API client for appDataFolder

import { getAccessToken } from './google-auth'
import type { SyncEnvelope } from '../../shared/types/sync'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

export interface DriveFile {
  id: string
  name: string
  modifiedTime: string
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  if (!token) throw new Error('Not authenticated with Google Drive')
  return { Authorization: `Bearer ${token}` }
}

export async function listFiles(): Promise<DriveFile[]> {
  const headers = await authHeaders()
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'files(id, name, modifiedTime)',
    pageSize: '1000',
  })

  const response = await fetch(`${DRIVE_API}/files?${params}`, { headers })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Drive list failed: ${response.status} ${body}`)
  }

  const data = (await response.json()) as { files: DriveFile[] }
  return data.files ?? []
}

export async function downloadFile(fileId: string): Promise<SyncEnvelope> {
  const headers = await authHeaders()
  const params = new URLSearchParams({ alt: 'media' })

  const response = await fetch(`${DRIVE_API}/files/${fileId}?${params}`, { headers })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Drive download failed: ${response.status} ${body}`)
  }

  return (await response.json()) as SyncEnvelope
}

export async function uploadFile(
  name: string,
  envelope: SyncEnvelope,
  existingFileId?: string,
): Promise<string> {
  const headers = await authHeaders()
  const content = JSON.stringify(envelope)

  if (existingFileId) {
    // Update existing file
    const response = await fetch(
      `${UPLOAD_API}/files/${existingFileId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: content,
      },
    )
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Drive update failed: ${response.status} ${body}`)
    }
    const data = (await response.json()) as { id: string }
    return data.id
  }

  // Create new file with multipart upload
  const metadata = {
    name,
    parents: ['appDataFolder'],
  }

  const boundary = '---pipette-sync-boundary'
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n')

  const response = await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Drive upload failed: ${response.status} ${body}`)
  }

  const data = (await response.json()) as { id: string }
  return data.id
}

export async function deleteFile(fileId: string): Promise<void> {
  const headers = await authHeaders()
  const response = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method: 'DELETE',
    headers,
  })
  if (!response.ok && response.status !== 404) {
    const body = await response.text()
    throw new Error(`Drive delete failed: ${response.status} ${body}`)
  }
}

export async function deleteAllFiles(): Promise<void> {
  const files = await listFiles()
  for (const file of files) {
    await deleteFile(file.id)
  }
}

export function driveFileName(syncUnit: string): string {
  // "favorites/tapDance" -> "favorites_tapDance.enc"
  // "keyboards/0x1234/settings" -> "keyboards_0x1234_settings.enc"
  // "keyboards/0x1234/snapshots" -> "keyboards_0x1234_snapshots.enc"
  return syncUnit.replaceAll('/', '_') + '.enc'
}

export function syncUnitFromFileName(fileName: string): string | null {
  // "keyboards_0x1234_settings.enc" → "keyboards/0x1234/settings"
  // "keyboards_0x1234_snapshots.enc" → "keyboards/0x1234/snapshots"
  const kbMatch = fileName.match(/^keyboards_(.+?)_(settings|snapshots)\.enc$/)
  if (kbMatch) return `keyboards/${kbMatch[1]}/${kbMatch[2]}`

  // "favorites_tapDance.enc" → "favorites/tapDance"
  const favMatch = fileName.match(/^favorites_(.+)\.enc$/)
  if (favMatch) return `favorites/${favMatch[1]}`

  return null
}

export async function deleteFilesByPrefix(prefix: string): Promise<void> {
  const files = await listFiles()
  for (const file of files) {
    if (file.name.startsWith(prefix)) {
      await deleteFile(file.id)
    }
  }
}
