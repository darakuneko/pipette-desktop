import { app, net } from 'electron'
import { dirname, join } from 'node:path'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { IpcChannels } from '../shared/ipc/channels'
import type { LanguageListEntry, LanguageDownloadStatus, TypingTestDataset } from '../shared/types/language-store'
import {
  DEFAULT_TYPING_TEST_PROVIDER,
  getProviderDefault,
} from '../shared/data/typing-test-providers'
import { fetchTypingDataset, fetchTypingDatasetVersion, isManifestEntry } from './hub/hub-typing-dataset'
import { log } from './logger'
import { secureHandle } from './ipc-guard'

// Downloaded language files are namespaced per provider so that two providers
// exposing the same language name (e.g. both monkeytype and tatoeba ship an
// 'english') never collide, and a version-change cleanup for one provider does
// not wipe another's downloads.
function getLanguagesDir(provider: string): string {
  return join(app.getPath('userData'), 'local', 'downloads', 'languages', provider)
}

/** Persisted Hub overrides keyed by provider. Absent / partial → bundled
 *  defaults are used. Lives under `local/` (machine-local, never synced). */
function getOverridePath(): string {
  return join(app.getPath('userData'), 'local', 'typing-test-dataset.json')
}

// In-memory cache of the override file so the hot LANG_LIST / LANG_DOWNLOAD
// paths don't re-read disk on every call. Reset whenever the file changes.
let overridesCache: Record<string, TypingTestDataset> | null = null

async function loadOverrides(): Promise<Record<string, TypingTestDataset>> {
  if (overridesCache) return overridesCache
  try {
    const parsed: unknown = JSON.parse(await readFile(getOverridePath(), 'utf-8'))
    overridesCache = (parsed && typeof parsed === 'object') ? (parsed as Record<string, TypingTestDataset>) : {}
  } catch {
    overridesCache = {}
  }
  return overridesCache
}

/** Effective dataset for a provider: the persisted Hub override if present
 *  and well-formed, otherwise the bundled default from the provider config. */
/** A persisted override is trusted only if it is fully well-formed — a
 *  corrupt local file must not poison LANG_LIST / LANG_DOWNLOAD, so we fall
 *  back to the bundled default instead. Mirrors the Hub-client validation. */
function isValidOverride(ov: unknown): ov is TypingTestDataset {
  if (typeof ov !== 'object' || ov === null) return false
  const d = ov as Record<string, unknown>
  return (
    typeof d.version === 'string' &&
    typeof d.downloadUrlBase === 'string' &&
    /^https:\/\//.test(d.downloadUrlBase) &&
    Array.isArray(d.languages) &&
    d.languages.every(isManifestEntry)
  )
}

async function getEffectiveDataset(provider: string): Promise<TypingTestDataset> {
  const def = getProviderDefault(provider)
  const overrides = await loadOverrides()
  const ov = overrides[provider]
  if (isValidOverride(ov)) return ov
  if (!def) throw new Error(`Unknown typing-test provider: ${provider}`)
  return { provider: def.provider, version: def.version, downloadUrlBase: def.downloadUrlBase, languages: def.languages }
}

function bundledSet(provider: string): Set<string> {
  return new Set(getProviderDefault(provider)?.bundledLanguages ?? [])
}

function isSafeName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && !/[/\\]/.test(name)
}

/** Resolve the provider arg from an IPC call, defaulting to the historical
 *  provider so pre-multi-provider callers keep working unchanged. */
function resolveProvider(provider?: string): string {
  return typeof provider === 'string' && provider ? provider : DEFAULT_TYPING_TEST_PROVIDER
}

function getLanguagePath(provider: string, name: string): string {
  return join(getLanguagesDir(provider), `${name}.json`)
}

async function getDownloadedSet(provider: string): Promise<Set<string>> {
  try {
    const files = await readdir(getLanguagesDir(provider))
    const names = files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
    return new Set(names)
  } catch {
    return new Set()
  }
}

/** Remove every downloaded language file for a provider. Called after a
 *  version change so stale files (fetched from the old version's URL, with a
 *  now-mismatched fileSize) are re-downloaded fresh on demand. */
async function clearDownloadedLanguages(provider: string): Promise<void> {
  const dir = getLanguagesDir(provider)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map((f) => unlink(join(dir, f)).catch(() => {})),
  )
}

function getStatus(name: string, downloadedSet: Set<string>, bundled: Set<string>): LanguageDownloadStatus {
  if (bundled.has(name)) return 'bundled'
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
    async (_event, provider?: string): Promise<LanguageListEntry[]> => {
      const p = resolveProvider(provider)
      const dataset = await getEffectiveDataset(p)
      const downloaded = await getDownloadedSet(p)
      const bundled = bundledSet(p)
      return dataset.languages.map((entry) => ({
        ...entry,
        status: getStatus(entry.name, downloaded, bundled),
      }))
    },
  )

  secureHandle(
    IpcChannels.LANG_GET,
    async (_event, name: string, provider?: string): Promise<LanguageFileData | null> => {
      if (!isSafeName(name)) return null
      const p = resolveProvider(provider)
      if (bundledSet(p).has(name)) return null
      try {
        const raw = await readFile(getLanguagePath(p, name), 'utf-8')
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
    async (_event, name: string, provider?: string): Promise<{ success: boolean; error?: string }> => {
      if (!isSafeName(name)) return { success: false, error: 'Invalid language name' }
      const p = resolveProvider(provider)
      if (bundledSet(p).has(name)) return { success: false, error: 'Language is bundled' }
      const dataset = await getEffectiveDataset(p)
      const entry = dataset.languages.find((e) => e.name === name)
      if (!entry) return { success: false, error: 'Unknown language' }

      const url = `${dataset.downloadUrlBase}/${name}.json`
      try {
        const response = await net.fetch(url)
        if (!response.ok) {
          return { success: false, error: `HTTP ${response.status}` }
        }
        const text = await response.text()
        const actualSize = Buffer.byteLength(text, 'utf-8')
        if (actualSize !== entry.fileSize) {
          const detail = `size mismatch (expected ${entry.fileSize}, got ${actualSize})`
          log('warn', `Language ${p}/${name}: ${detail}`)
          return { success: false, error: `Integrity check failed: ${detail}` }
        }
        const data: unknown = JSON.parse(text)
        if (!validateLanguageData(data)) {
          return { success: false, error: 'Invalid language data' }
        }
        await mkdir(getLanguagesDir(p), { recursive: true })
        await writeFile(getLanguagePath(p, name), text, 'utf-8')
        log('info', `Downloaded language: ${p}/${name}`)
        return { success: true }
      } catch (err) {
        log('warn', `Failed to download language ${p}/${name}: ${err}`)
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.LANG_DELETE,
    async (_event, name: string, provider?: string): Promise<{ success: boolean; error?: string }> => {
      if (!isSafeName(name)) return { success: false, error: 'Invalid language name' }
      const p = resolveProvider(provider)
      if (bundledSet(p).has(name)) return { success: false, error: 'Cannot delete bundled language' }
      try {
        await unlink(getLanguagePath(p, name))
        log('info', `Deleted language: ${p}/${name}`)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  // Check-only: is a newer dataset version available? (session-cached)
  secureHandle(
    IpcChannels.TYPING_DATASET_CHECK,
    async (_event, provider?: string): Promise<{ provider: string; updateAvailable: boolean }> => {
      return checkTypingDatasetUpdate(typeof provider === 'string' && provider ? provider : DEFAULT_TYPING_TEST_PROVIDER)
    },
  )

  // Manual update: download + apply the newer dataset (from the modal button).
  secureHandle(
    IpcChannels.TYPING_DATASET_UPDATE,
    async (_event, provider?: string): Promise<TypingDatasetSyncResult> => {
      return syncTypingDataset(typeof provider === 'string' && provider ? provider : DEFAULT_TYPING_TEST_PROVIDER)
    },
  )
}

export interface TypingDatasetSyncResult {
  provider: string
  changed: boolean
  fromVersion: string
  toVersion?: string
}

// "Update available?" result, remembered for the app session only (cleared on
// process restart). Lets the Mode modal check once per session and reuse the
// flag on reopen/tab-switch without re-hitting the Hub. An applied update or a
// restart re-checks.
const updateCheckCache = new Map<string, boolean>()

/** Check (without downloading) whether the Hub has a newer dataset version for
 *  the provider. The first call per session probes the Hub `/version`; later
 *  calls reuse the cached result. A Hub error is reported as "no update" and is
 *  NOT cached, so a later modal open can retry. */
export async function checkTypingDatasetUpdate(
  provider: string = DEFAULT_TYPING_TEST_PROVIDER,
): Promise<{ provider: string; updateAvailable: boolean }> {
  const cached = updateCheckCache.get(provider)
  if (cached !== undefined) return { provider, updateAvailable: cached }
  const current = await getEffectiveDataset(provider)
  const hubVersion = await fetchTypingDatasetVersion(provider)
  if (!hubVersion) return { provider, updateAvailable: false }
  const updateAvailable = hubVersion !== current.version
  updateCheckCache.set(provider, updateAvailable)
  return { provider, updateAvailable }
}

/**
 * Compare the effective dataset version against the Hub's and, on a
 * mismatch, pull the fresh dataset, persist it as the provider override,
 * and clear stale downloaded language files. Never throws — returns
 * `changed:false` on any network / shape error so the bundled defaults
 * keep working offline.
 */
export async function syncTypingDataset(
  provider: string = DEFAULT_TYPING_TEST_PROVIDER,
): Promise<TypingDatasetSyncResult> {
  const current = await getEffectiveDataset(provider)
  const hubVersion = await fetchTypingDatasetVersion(provider)
  if (!hubVersion || hubVersion === current.version) {
    return { provider, changed: false, fromVersion: current.version }
  }

  const fresh = await fetchTypingDataset(provider)
  if (!fresh || fresh.version === current.version) {
    return { provider, changed: false, fromVersion: current.version }
  }

  const overrides = await loadOverrides()
  const next = { ...overrides, [provider]: fresh }
  const path = getOverridePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next), 'utf-8')
  overridesCache = next

  // The new version's files live at a different URL and may differ in size,
  // so drop the old downloads; they re-fetch on demand against the new base.
  await clearDownloadedLanguages(provider)

  // The update is applied, so the session no longer has one pending.
  updateCheckCache.set(provider, false)

  log('info', `Typing dataset ${provider}: updated ${current.version} -> ${fresh.version}`)
  return { provider, changed: true, fromVersion: current.version, toVersion: fresh.version }
}
