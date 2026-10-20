// SPDX-License-Identifier: GPL-2.0-or-later
// The minisign check of the release scripts and the fake update server,
// against a signature `tauri signer sign` 2.12.1 wrote with a throwaway key
// (fixtures/) and against the test-only signer.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodePublicKey, signedVersion, verifySignature } from './minisign'
import { TEST_ONLY_PUBKEY, testOnlySign } from '../fake-update/test-only-signer'

const FIXTURES = join(__dirname, 'fixtures')
const TAURI_CONF = join(__dirname, '../../src-tauri/tauri.conf.json')
const cliPayload = readFileSync(join(FIXTURES, 'cli-payload.bin'))
const cliSignature = readFileSync(join(FIXTURES, 'cli-payload.bin.sig'), 'utf8')
const cliPubkey = readFileSync(join(FIXTURES, 'cli-test-key.pub'), 'utf8')

describe('minisign', () => {
  it('verifies a signature of the Tauri CLI with the version it binds', () => {
    const comment = verifySignature(cliPayload, cliSignature, cliPubkey, '1.2.3')
    expect(signedVersion(comment)).toBe('1.2.3')
    expect(verifySignature(cliPayload, cliSignature, cliPubkey, 'v1.2.3')).toBe(comment)
  })

  it('refuses other bytes, another version, another key and a changed trusted comment', () => {
    expect(() => verifySignature(Buffer.from('hellO\n'), cliSignature, cliPubkey, '1.2.3')).toThrow('does not verify')
    expect(() => verifySignature(cliPayload, cliSignature, cliPubkey, '1.2.4')).toThrow('signed for version 1.2.3')
    expect(() => verifySignature(cliPayload, cliSignature, TEST_ONLY_PUBKEY, '1.2.3')).toThrow('signed with key')
    const file = Buffer.from(cliSignature, 'base64').toString('utf8').replace('version:1.2.3', 'version:9.9.9')
    expect(() => verifySignature(cliPayload, Buffer.from(file).toString('base64'), cliPubkey, '9.9.9')).toThrow('trusted comment')
  })

  it('verifies the test-only signer and refuses a signature without a version', () => {
    const data = Buffer.from('payload')
    verifySignature(data, testOnlySign(data, { version: '0.5.0-beta.3' }), TEST_ONLY_PUBKEY, '0.5.0-beta.3')
    expect(() => verifySignature(data, testOnlySign(data), TEST_ONLY_PUBKEY, '0.5.0-beta.3')).toThrow('binds no version')
  })

  it('reads the release key of tauri.conf.json, which is not the test key', () => {
    const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as { plugins: { updater: { pubkey: string } } }
    const release = decodePublicKey(conf.plugins.updater.pubkey)
    expect(release.keyId).toBe('EF45D93F7FED6391')
    expect(release.keyId).not.toBe(decodePublicKey(TEST_ONLY_PUBKEY).keyId)
  })
})
