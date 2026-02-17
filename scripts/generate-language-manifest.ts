// Fetches the monkeytype language list from GitHub and generates a manifest.
// Usage: pnpm run generate:language-manifest [commit-hash]
// When updating, set the same hash in src/main/language-store.ts LANG_SOURCE_COMMIT.

import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ManifestEntry {
  name: string
  wordCount: number
  rightToLeft: boolean
  fileSize: number
}

interface GithubContentEntry {
  name: string
  type: string
}

const COMMIT = process.argv[2] || 'master'
const REPO_CONTENTS_URL =
  `https://api.github.com/repos/monkeytypegame/monkeytype/contents/frontend/static/languages?ref=${COMMIT}`
const DOWNLOAD_URL_BASE =
  `https://github.com/monkeytypegame/monkeytype/raw/${COMMIT}/frontend/static/languages`
const CONCURRENCY = 8

const scriptDir = dirname(fileURLToPath(import.meta.url))
const OUTPUT = join(scriptDir, '../src/shared/data/language-manifest.json')

async function fetchLanguageNames(): Promise<string[]> {
  const res = await fetch(REPO_CONTENTS_URL, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  })
  if (!res.ok) throw new Error(`GitHub API error: HTTP ${res.status}`)
  const entries = (await res.json()) as GithubContentEntry[]
  return entries
    .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
    .map((e) => e.name.replace(/\.json$/, ''))
    .sort()
}

async function fetchLanguage(name: string): Promise<ManifestEntry | null> {
  const url = `${DOWNLOAD_URL_BASE}/${name}.json`
  const res = await fetch(url)
  if (!res.ok) {
    console.warn(`Skipping ${name}: HTTP ${res.status}`)
    return null
  }
  const text = await res.text()
  const data = JSON.parse(text) as { name?: string; words?: string[]; rightToLeft?: boolean }
  if (!data.name || !Array.isArray(data.words)) {
    console.warn(`Skipping ${name}: missing name or words`)
    return null
  }
  return {
    name: data.name,
    wordCount: data.words.length,
    rightToLeft: data.rightToLeft === true,
    fileSize: Buffer.byteLength(text, 'utf-8'),
  }
}

async function processInBatches(names: string[], concurrency: number): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = []
  for (let i = 0; i < names.length; i += concurrency) {
    const batch = names.slice(i, i + concurrency)
    const results = await Promise.all(batch.map(fetchLanguage))
    entries.push(...results.filter((e): e is ManifestEntry => e !== null))
    process.stdout.write(`\r  ${Math.min(i + concurrency, names.length)}/${names.length}`)
  }
  process.stdout.write('\n')
  return entries
}

async function main(): Promise<void> {
  console.log(`Fetching language list from GitHub (ref: ${COMMIT})...`)
  const names = await fetchLanguageNames()
  console.log(`Found ${names.length} languages. Fetching metadata...`)

  const entries = await processInBatches(names, CONCURRENCY)
  entries.sort((a, b) => a.name.localeCompare(b.name))

  await writeFile(OUTPUT, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
  console.log(`Generated manifest with ${entries.length} entries → ${OUTPUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
