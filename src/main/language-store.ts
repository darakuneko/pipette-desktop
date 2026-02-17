import { app, net } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { IpcChannels } from '../shared/ipc/channels'
import type { LanguageManifestEntry, LanguageListEntry, LanguageDownloadStatus } from '../shared/types/language-store'
import manifest from '../shared/data/language-manifest.json'
import { log } from './logger'
import { secureHandle } from './ipc-guard'

const BUNDLED_LANGUAGES = new Set(['english'])

const MANIFEST_NAMES = new Set((manifest as LanguageManifestEntry[]).map((e) => e.name))

const DOWNLOAD_URL_BASE =
  'https://github.com/monkeytypegame/monkeytype/raw/refs/heads/master/frontend/static/languages'

function getLanguagesDir(): string {
  return join(app.getPath('userData'), 'local', 'downloads', 'languages')
}

function isSafeName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && !/[/\\]/.test(name)
}

function getLanguagePath(name: string): string {
  return join(getLanguagesDir(), `${name}.json`)
}

async function getDownloadedSet(): Promise<Set<string>> {
  try {
    const files = await readdir(getLanguagesDir())
    const names = files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
    return new Set(names)
  } catch {
    return new Set()
  }
}

function getStatus(name: string, downloadedSet: Set<string>): LanguageDownloadStatus {
  if (BUNDLED_LANGUAGES.has(name)) return 'bundled'
  if (downloadedSet.has(name)) return 'downloaded'
  return 'not-downloaded'
}

interface LanguageFileData {
  name: string
  words: string[]
  [key: string]: unknown
}

function validateLanguageData(data: unknown): data is LanguageFileData {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.name !== 'string') return false
  if (!Array.isArray(obj.words) || obj.words.length === 0) return false
  if (obj.words.some((w: unknown) => typeof w !== 'string')) return false
  return true
}

export function setupLanguageStore(): void {
  secureHandle(
    IpcChannels.LANG_LIST,
    async (): Promise<LanguageListEntry[]> => {
      const downloaded = await getDownloadedSet()
      return (manifest as LanguageManifestEntry[]).map((entry) => ({
        ...entry,
        status: getStatus(entry.name, downloaded),
      }))
    },
  )

  secureHandle(
    IpcChannels.LANG_GET,
    async (_event, name: string): Promise<LanguageFileData | null> => {
      if (!isSafeName(name)) return null
      if (BUNDLED_LANGUAGES.has(name)) return null
      try {
        const raw = await readFile(getLanguagePath(name), 'utf-8')
        const data: unknown = JSON.parse(raw)
        if (!validateLanguageData(data)) return null
        return data
      } catch {
        return null
      }
    },
  )

  secureHandle(
    IpcChannels.LANG_DOWNLOAD,
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      if (!isSafeName(name)) return { success: false, error: 'Invalid language name' }
      if (BUNDLED_LANGUAGES.has(name)) return { success: false, error: 'Language is bundled' }
      if (!MANIFEST_NAMES.has(name)) return { success: false, error: 'Unknown language' }

      const url = `${DOWNLOAD_URL_BASE}/${name}.json`
      try {
        const response = await net.fetch(url)
        if (!response.ok) {
          return { success: false, error: `HTTP ${response.status}` }
        }
        const text = await response.text()
        const data: unknown = JSON.parse(text)
        if (!validateLanguageData(data)) {
          return { success: false, error: 'Invalid language data' }
        }
        await mkdir(getLanguagesDir(), { recursive: true })
        await writeFile(getLanguagePath(name), text, 'utf-8')
        log('info', `Downloaded language: ${name}`)
        return { success: true }
      } catch (err) {
        log('warn', `Failed to download language ${name}: ${err}`)
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.LANG_DELETE,
    async (_event, name: string): Promise<{ success: boolean; error?: string }> => {
      if (!isSafeName(name)) return { success: false, error: 'Invalid language name' }
      if (BUNDLED_LANGUAGES.has(name)) return { success: false, error: 'Cannot delete bundled language' }
      try {
        await unlink(getLanguagePath(name))
        log('info', `Deleted language: ${name}`)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )
}
