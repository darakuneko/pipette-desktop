// SPDX-License-Identifier: GPL-2.0-or-later
// The update manifests of the in-app update (src-tauri/src/updater.rs):
// building a release's `latest.json` from its signed update files, and the
// checks a release must pass before its `latest.json` becomes a channel's
// manifest (`<channel>.json` of the `updater-manifest` pre-release).
//
// Every platform must be in a manifest: the updater reads the whole
// `platforms` object, and a manifest it cannot read fails every user's
// check, not just one platform's.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySignature } from './minisign'
import { compareVersions, isPreRelease, parseVersion } from './version'

export const DOWNLOAD_BASE = 'https://github.com/darakuneko/pipette-desktop/releases/download/'

/** beta: what the pre-releases read; stable: what the releases read;
 *  staging: a manifest a release build reads only when told to, for
 *  trying an update before it reaches anyone. */
export const CHANNELS = ['beta', 'stable', 'staging'] as const

/** The update files of a release (each with `<file>.sig` beside it) and the
 *  manifest platforms each serves: the updater looks for
 *  `<os>-<arch>-<installer>` first, then `<os>-<arch>`. */
export const UPDATE_ASSETS: readonly { file: string; platforms: readonly string[] }[] = [
  { file: 'Pipette-linux-x86_64.AppImage', platforms: ['linux-x86_64-appimage', 'linux-x86_64'] },
  { file: 'Pipette-win-x64.exe', platforms: ['windows-x86_64-nsis', 'windows-x86_64'] },
  { file: 'Pipette-mac-arm64.app.tar.gz', platforms: ['darwin-aarch64-app', 'darwin-aarch64'] },
]

export const PUBKEY_PLACEHOLDER = 'UPDATER-PUBLIC-KEY-PLACEHOLDER'

export interface PlatformEntry {
  url: string
  signature: string
}

export interface UpdateManifest {
  version: string
  notes?: string
  pub_date: string
  platforms: Record<string, PlatformEntry>
}

/** The download address of `file` in the release of `tag`. */
export function releaseDownloadUrl(tag: string, file: string): string {
  return `${DOWNLOAD_BASE}${tag}/${file}`
}

/** src-tauri/tauri.conf.json, where the updater's public key is. */
export const TAURI_CONF = resolve(dirname(fileURLToPath(import.meta.url)), '../../src-tauri/tauri.conf.json')

/** The updater's public key in `confPath`; throws while it is the
 *  placeholder. */
export function readPubkey(confPath: string = TAURI_CONF): string {
  const config = JSON.parse(readFileSync(confPath, 'utf8')) as { plugins?: { updater?: { pubkey?: unknown } } }
  const pubkey = config.plugins?.updater?.pubkey
  if (typeof pubkey !== 'string' || pubkey.trim() === '' || pubkey === PUBKEY_PLACEHOLDER) {
    throw new Error(`${confPath} has no updater public key`)
  }
  return pubkey
}

export interface SignedFile {
  data: Buffer
  /** The `.sig` file's text. */
  signature: string
}

/**
 * The `latest.json` of version `version`: every update file, its signature
 * verified with `pubkey` and bound to `version`, under the release of tag
 * `v<version>`. Throws when a file is missing or does not verify.
 */
export function buildLatestJson(options: {
  version: string
  pubDate: string
  notes?: string
  files: ReadonlyMap<string, SignedFile>
  pubkey: string
}): UpdateManifest {
  parseVersion(options.version)
  const platforms: Record<string, PlatformEntry> = {}
  for (const { file, platforms: names } of UPDATE_ASSETS) {
    const signed = options.files.get(file)
    if (!signed) throw new Error(`${file} or its signature is missing`)
    const signature = signed.signature.trim()
    try {
      verifySignature(signed.data, signature, options.pubkey, options.version)
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`)
    }
    const url = releaseDownloadUrl(`v${options.version}`, file)
    for (const name of names) {
      platforms[name] = { url, signature }
    }
  }
  return {
    version: options.version,
    ...(options.notes === undefined ? {} : { notes: options.notes }),
    pub_date: options.pubDate,
    platforms,
  }
}

/** The release as `gh release view --json tagName,isDraft,isPrerelease,assets`
 *  describes it. */
export interface ReleaseInfo {
  tagName: string
  isDraft: boolean
  isPrerelease: boolean
  assets: { name: string }[]
}

export interface PromotionInput {
  tag: string
  channel: string
  release: ReleaseInfo
  /** The release's `latest.json`, parsed. */
  manifest: unknown
  /** The text of each `.sig` asset, by the file it signs. */
  signatures: Readonly<Record<string, string>>
  /** The channel's manifest now, parsed; null when there is none yet. */
  current: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function versionOf(manifest: unknown): string | undefined {
  return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : undefined
}

/**
 * The reasons the release's `latest.json` may not become the channel's
 * manifest; empty when it may. The signatures themselves are verified by
 * the caller, against the downloaded files.
 */
export function promotionProblems(input: PromotionInput): string[] {
  const problems: string[] = []
  const { tag, channel, release, manifest } = input
  if (!(CHANNELS as readonly string[]).includes(channel)) problems.push(`unknown channel ${channel}`)
  if (!/^v/.test(tag)) problems.push(`the tag ${tag} does not start with v`)
  if (release.tagName !== tag) problems.push(`the release is ${release.tagName}, not ${tag}`)
  if (release.isDraft) problems.push('the release is a draft: publish it first')

  const version = versionOf(manifest)
  if (version === undefined) {
    problems.push('latest.json has no version')
    return problems
  }
  try {
    parseVersion(version)
  } catch (err) {
    problems.push((err as Error).message)
    return problems
  }
  if (version !== tag.replace(/^v/, '')) problems.push(`latest.json is version ${version}, the tag ${tag}`)
  // promote-update.yml's job `if` makes the same call for a publish: keep the two in step.
  if ((isPreRelease(version) || release.isPrerelease) && channel === 'stable') {
    problems.push('a pre-release goes to beta or staging, never to stable')
  }

  const platforms = isRecord(manifest) && isRecord(manifest.platforms) ? manifest.platforms : {}
  const expected = UPDATE_ASSETS.flatMap(({ platforms: names }) => names)
  for (const name of Object.keys(platforms)) {
    if (!expected.includes(name)) problems.push(`latest.json has the unexpected platform ${name}`)
  }
  const assetNames = new Set(release.assets.map((asset) => asset.name))
  for (const { file, platforms: names } of UPDATE_ASSETS) {
    if (!assetNames.has(file)) problems.push(`the release has no ${file}`)
    if (!assetNames.has(`${file}.sig`)) problems.push(`the release has no ${file}.sig`)
    const signature = input.signatures[file]?.trim()
    const url = releaseDownloadUrl(tag, file)
    for (const name of names) {
      const entry = platforms[name]
      if (!isRecord(entry)) {
        problems.push(`latest.json has no ${name}`)
        continue
      }
      if (entry.url !== url) problems.push(`${name} points at ${String(entry.url)}, not ${url}`)
      if (signature === undefined || entry.signature !== signature) problems.push(`${name}'s signature is not the one of ${file}.sig`)
    }
  }
  const updateFiles = new Set(UPDATE_ASSETS.map(({ file }) => file))
  for (const name of assetNames) {
    if (name.endsWith('.sig') && !updateFiles.has(name.slice(0, -'.sig'.length))) {
      problems.push(`the release has the signature ${name} of a file no platform uses`)
    }
  }

  if (input.current !== null) {
    const current = versionOf(input.current)
    if (current === undefined) {
      problems.push(`the ${channel} manifest now has no version`)
    } else {
      try {
        if (compareVersions(version, current) <= 0) problems.push(`${version} is not newer than ${current}, the ${channel} manifest now`)
      } catch (err) {
        problems.push(`the ${channel} manifest now: ${(err as Error).message}`)
      }
    }
  }
  return problems
}
