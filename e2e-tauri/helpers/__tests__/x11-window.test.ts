// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest'
import { clientMessage } from '../../../scripts/resident-fixtures/x11/x-client'
import { xauthCookie } from '../x11-window'

/** One Xauthority entry: family, address, display number, name, data. */
function entry(family: number, address: string, number: string, name: string, data: Buffer): Buffer {
  const field = (value: Buffer): Buffer => {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(value.length)
    return Buffer.concat([length, value])
  }
  const head = Buffer.alloc(2)
  head.writeUInt16BE(family)
  return Buffer.concat([head, field(Buffer.from(address)), field(Buffer.from(number)), field(Buffer.from(name)), field(data)])
}

const COOKIE = 'MIT-MAGIC-COOKIE-1'
const LOCAL = 256
const WILD = 0xffff

describe('xauthCookie', () => {
  it("takes the cookie of the display's number", () => {
    const file = Buffer.concat([
      entry(LOCAL, 'host', '98', COOKIE, Buffer.from([1, 2])),
      entry(LOCAL, 'host', '99', COOKIE, Buffer.from([3, 4])),
    ])
    expect(xauthCookie(file, '99')).toEqual(Buffer.from([3, 4]))
  })

  it('falls back to an entry for any number, and skips other kinds of authorization', () => {
    const file = Buffer.concat([
      entry(LOCAL, 'host', '99', 'XDM-AUTHORIZATION-1', Buffer.from([9])),
      entry(WILD, '', '', COOKIE, Buffer.from([5, 6])),
      entry(LOCAL, 'host', '7', COOKIE, Buffer.from([7])),
    ])
    expect(xauthCookie(file, '99')).toEqual(Buffer.from([5, 6]))
  })

  it('prefers the exact number over an earlier entry for any number', () => {
    const file = Buffer.concat([entry(WILD, '', '', COOKIE, Buffer.from([1])), entry(LOCAL, 'h', '3', COOKIE, Buffer.from([2]))])
    expect(xauthCookie(file, '3')).toEqual(Buffer.from([2]))
  })

  it('answers null when no entry fits', () => {
    expect(xauthCookie(Buffer.alloc(0), '1')).toBeNull()
    expect(xauthCookie(entry(LOCAL, 'h', '2', COOKIE, Buffer.from([1])), '1')).toBeNull()
  })

  it('refuses a file that ends inside an entry', () => {
    const file = entry(LOCAL, 'host', '1', COOKIE, Buffer.from([1, 2, 3]))
    expect(() => xauthCookie(file.subarray(0, file.length - 1), '1')).toThrow(/ends inside an entry/)
  })
})

describe('clientMessage', () => {
  it('lays out a ClientMessage of format 32', () => {
    const event = clientMessage(0x1234, 77, [88, 0])
    expect(event.length).toBe(32)
    expect(event[0]).toBe(33)
    expect(event[1]).toBe(32)
    expect(event.readUInt32LE(4)).toBe(0x1234)
    expect(event.readUInt32LE(8)).toBe(77)
    expect(event.readUInt32LE(12)).toBe(88)
    expect(event.subarray(16)).toEqual(Buffer.alloc(16))
  })

  it('carries at most five values', () => {
    expect(() => clientMessage(1, 2, [1, 2, 3, 4, 5, 6])).toThrow(/at most five/)
  })
})
