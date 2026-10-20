// SPDX-License-Identifier: GPL-2.0-or-later
// The release scripts of the in-app update: the version order, latest.json
// and the checks before a release becomes a channel's manifest.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareVersions, isPreRelease } from './version'
import {
  UPDATE_ASSETS,
  buildLatestJson,
  promotionProblems,
  readPubkey,
  releaseDownloadUrl,
  type PromotionInput,
  type SignedFile,
} from './manifest'
import { TEST_ONLY_PUBKEY, testOnlySign } from '../fake-update/test-only-signer'

describe('versions', () => {
  it('orders as semver does', () => {
    const ordered = ['0.4.9', '0.5.0-alpha.1', '0.5.0-beta.2', '0.5.0-beta.10', '0.5.0-beta.10.1', '0.5.0-rc.1', '0.5.0', '0.5.1']
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i - 1], ordered[i])).toBe(-1)
      expect(compareVersions(ordered[i], ordered[i - 1])).toBe(1)
    }
    expect(compareVersions('v0.5.0+build.1', '0.5.0')).toBe(0)
    expect(isPreRelease('0.5.0-beta.2')).toBe(true)
    expect(isPreRelease('0.5.0')).toBe(false)
    expect(() => compareVersions('0.5', '0.5.0')).toThrow()
  })
})

function signedFiles(version: string, sign = (data: Buffer, file: string) => testOnlySign(data, { version, file })): Map<string, SignedFile> {
  return new Map(UPDATE_ASSETS.map(({ file }) => {
    const data = Buffer.from(`${file} ${version}`)
    return [file, { data, signature: sign(data, file) }]
  }))
}

describe('the release key', () => {
  it('is read from tauri.conf.json, and the placeholder is refused', () => {
    expect(readPubkey()).toMatch(/^[A-Za-z0-9+/]+=*$/)
    const dir = mkdtempSync(join(tmpdir(), 'pipette-pubkey-'))
    try {
      const conf = join(dir, 'tauri.conf.json')
      writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: 'UPDATER-PUBLIC-KEY-PLACEHOLDER' } } }))
      expect(() => readPubkey(conf)).toThrow('no updater public key')
      writeFileSync(conf, JSON.stringify({ plugins: {} }))
      expect(() => readPubkey(conf)).toThrow('no updater public key')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('latest.json', () => {
  it('lists every platform with the release URL and the verified signature', () => {
    const files = signedFiles('0.5.0-beta.3')
    const manifest = buildLatestJson({ version: '0.5.0-beta.3', pubDate: '2026-10-20T00:00:00.000Z', files, pubkey: TEST_ONLY_PUBKEY })
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'darwin-aarch64', 'darwin-aarch64-app', 'linux-x86_64', 'linux-x86_64-appimage', 'windows-x86_64', 'windows-x86_64-nsis',
    ])
    expect(manifest.platforms['windows-x86_64-nsis']).toEqual({
      url: 'https://github.com/darakuneko/pipette-desktop/releases/download/v0.5.0-beta.3/Pipette-win-x64.exe',
      signature: files.get('Pipette-win-x64.exe')?.signature,
    })
  })

  it('refuses a missing file, a bad signature and a signature for another version', () => {
    const missing = signedFiles('0.5.0-beta.3')
    missing.delete('Pipette-mac-arm64.app.tar.gz')
    const build = (files: Map<string, SignedFile>) =>
      buildLatestJson({ version: '0.5.0-beta.3', pubDate: 'x', files, pubkey: TEST_ONLY_PUBKEY })
    expect(() => build(missing)).toThrow('Pipette-mac-arm64.app.tar.gz')
    expect(() => build(signedFiles('0.5.0-beta.3', (_data, file) => testOnlySign(Buffer.from('x'), { version: '0.5.0-beta.3', file })))).toThrow('does not verify')
    expect(() => build(signedFiles('0.5.0-beta.2'))).toThrow('signed for version 0.5.0-beta.2')
  })
})

function promotion(overrides: Partial<PromotionInput> = {}, version = '0.5.0-beta.3'): PromotionInput {
  const tag = `v${version}`
  const files = signedFiles(version)
  return {
    tag,
    channel: 'beta',
    release: {
      tagName: tag,
      isDraft: false,
      isPrerelease: isPreRelease(version),
      assets: [
        { name: 'Pipette-mac-arm64.dmg' },
        { name: 'Pipette-linux-x86_64.AppImage.zsync' },
        { name: 'latest.json' },
        ...UPDATE_ASSETS.flatMap(({ file }) => [{ name: file }, { name: `${file}.sig` }]),
      ],
    },
    manifest: buildLatestJson({ version, pubDate: 'x', files, pubkey: TEST_ONLY_PUBKEY }),
    signatures: Object.fromEntries([...files].map(([file, { signature }]) => [file, signature])),
    current: { version: '0.5.0-beta.2' },
    ...overrides,
  }
}

describe('promotion', () => {
  it('lets a published newer release become the manifest', () => {
    expect(promotionProblems(promotion())).toEqual([])
    expect(promotionProblems(promotion({ channel: 'staging' }))).toEqual([])
    expect(promotionProblems(promotion({ current: null }))).toEqual([])
    expect(promotionProblems(promotion({ channel: 'stable', current: { version: '0.4.9' } }, '0.5.0'))).toEqual([])
    // A release goes to beta too: the betas read it there.
    expect(promotionProblems(promotion({ current: { version: '0.5.0-beta.9' } }, '0.5.0'))).toEqual([])
  })

  it('refuses a draft, another tag, a pre-release to stable and an unknown channel', () => {
    expect(promotionProblems(promotion({ release: { ...promotion().release, isDraft: true } }))).toEqual([
      'the release is a draft: publish it first',
    ])
    expect(promotionProblems(promotion({ tag: 'v0.5.0-beta.4' }))[0]).toContain('the release is v0.5.0-beta.3')
    expect(promotionProblems(promotion({ channel: 'stable' }))).toContain('a pre-release goes to beta or staging, never to stable')
    expect(promotionProblems(promotion({ channel: 'nightly' }))).toContain('unknown channel nightly')
  })

  it('refuses a version that is not newer than the channel', () => {
    expect(promotionProblems(promotion({ current: { version: '0.5.0-beta.3' } }))).toEqual([
      '0.5.0-beta.3 is not newer than 0.5.0-beta.3, the beta manifest now',
    ])
    expect(promotionProblems(promotion({ current: { version: '0.5.0' } }))).toHaveLength(1)
    expect(promotionProblems(promotion({ current: {} }))).toEqual(['the beta manifest now has no version'])
  })

  it('matches every platform 1:1 with the assets and their signatures', () => {
    const base = promotion()
    const manifest = base.manifest as { version: string; platforms: Record<string, { url: string; signature: string }> }
    const without = { ...manifest, platforms: { ...manifest.platforms } }
    delete without.platforms['darwin-aarch64']
    expect(promotionProblems({ ...base, manifest: without })).toEqual(['latest.json has no darwin-aarch64'])

    const moved = { ...manifest, platforms: { ...manifest.platforms, 'linux-x86_64': { ...manifest.platforms['linux-x86_64'], url: releaseDownloadUrl('v0.5.0-beta.2', 'Pipette-linux-x86_64.AppImage') } } }
    expect(promotionProblems({ ...base, manifest: moved })[0]).toContain('linux-x86_64 points at')

    const otherSig = { ...base.signatures, 'Pipette-win-x64.exe': testOnlySign(Buffer.from('x'), { version: '0.5.0-beta.3' }) }
    expect(promotionProblems({ ...base, signatures: otherSig })).toHaveLength(2)

    const extra = { ...manifest, platforms: { ...manifest.platforms, 'linux-aarch64': manifest.platforms['linux-x86_64'] } }
    expect(promotionProblems({ ...base, manifest: extra })).toEqual(['latest.json has the unexpected platform linux-aarch64'])

    const assets = base.release.assets.filter((asset) => asset.name !== 'Pipette-win-x64.exe.sig')
    expect(promotionProblems({ ...base, release: { ...base.release, assets } })).toEqual(['the release has no Pipette-win-x64.exe.sig'])
    const stray = [...base.release.assets, { name: 'Pipette-mac-arm64.dmg.sig' }]
    expect(promotionProblems({ ...base, release: { ...base.release, assets: stray } })).toEqual([
      'the release has the signature Pipette-mac-arm64.dmg.sig of a file no platform uses',
    ])
  })

  it('refuses a manifest whose version is not the tag', () => {
    const base = promotion()
    expect(promotionProblems({ ...base, manifest: { ...(base.manifest as object), version: '0.5.0-beta.9' } })[0]).toBe(
      'latest.json is version 0.5.0-beta.9, the tag v0.5.0-beta.3',
    )
    expect(promotionProblems({ ...base, manifest: {} })).toEqual(['latest.json has no version'])
  })
})
