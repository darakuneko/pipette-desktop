// SPDX-License-Identifier: GPL-2.0-or-later
// The few X11 core requests the active-window fixture generator needs to put
// windows and properties on its private server (x-server.ts): InternAtom,
// CreateWindow (InputOnly, never mapped), DestroyWindow, ChangeProperty and
// DeleteProperty, with GetInputFocus as the round trip that surfaces errors.
// Little-endian, over the server's local socket, MIT-MAGIC-COOKIE-1 only.

import { createConnection, type Socket } from 'node:net'

const pad4 = (n: number): number => (4 - (n % 4)) % 4

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc(pad4(data.length))])
}

export interface XClient {
  root: number
  internAtom(name: string, onlyIfExists?: boolean): Promise<number>
  createWindow(): number
  destroyWindow(window: number): void
  changeProperty(window: number, property: number, type: number, format: 8 | 16 | 32, data: Buffer): void
  deleteProperty(window: number, property: number): void
  /** Waits until the server has handled every request sent so far; rejects
   *  with the first X error among them. */
  sync(): Promise<void>
  close(): void
}

interface Pending {
  resolve(reply: Buffer): void
  reject(err: Error): void
}

export async function connectX(display: string, cookie: Buffer): Promise<XClient> {
  const number = /^:(\d+)$/.exec(display)?.[1]
  if (number === undefined) throw new Error(`x client: unsupported display ${display}`)
  // As Xlib does: the abstract socket first (an X server run without root
  // may be unable to create /tmp/.X11-unix), then the socket file.
  let found: Socket | null = null
  for (const path of [`\0/tmp/.X11-unix/X${number}`, `/tmp/.X11-unix/X${number}`]) {
    const candidate = createConnection(path)
    const connected = await new Promise<boolean>((resolve) => {
      candidate.once('connect', () => resolve(true))
      candidate.once('error', () => resolve(false))
    })
    if (connected) {
      found = candidate
      break
    }
  }
  if (found === null) throw new Error(`x client: cannot connect to ${display}`)
  const socket = found

  let buffer = Buffer.alloc(0)
  let waiter: (() => void) | null = null
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    waiter?.()
  })
  const read = async (length: number): Promise<Buffer> => {
    while (buffer.length < length) {
      await new Promise<void>((resolve) => {
        waiter = resolve
      })
      waiter = null
    }
    const out = buffer.subarray(0, length)
    buffer = buffer.subarray(length)
    return out
  }

  const name = Buffer.from('MIT-MAGIC-COOKIE-1')
  const setup = Buffer.alloc(12)
  setup.write('l', 0, 'latin1')
  setup.writeUInt16LE(11, 2)
  setup.writeUInt16LE(0, 4)
  setup.writeUInt16LE(name.length, 6)
  setup.writeUInt16LE(cookie.length, 8)
  socket.write(Buffer.concat([setup, padded(name), padded(cookie)]))
  const head = await read(8)
  const body = await read(head.readUInt16LE(6) * 4)
  if (head[0] !== 1) throw new Error(`x client: connection refused: ${body.subarray(0, head[1]).toString('latin1')}`)
  const idBase = body.readUInt32LE(4)
  const vendorLength = body.readUInt16LE(16)
  const formats = body[21]
  const root = body.readUInt32LE(32 + vendorLength + pad4(vendorLength) + formats * 8)

  let sequence = 0
  let nextId = 0
  const replies = new Map<number, Pending>()
  let errors: string[] = []

  const send = (opcode: number, data: number, payload: Buffer): number => {
    const header = Buffer.alloc(4)
    header[0] = opcode
    header[1] = data
    header.writeUInt16LE((4 + payload.length) / 4, 2)
    socket.write(Buffer.concat([header, payload]))
    sequence = (sequence + 1) & 0xffff
    return sequence
  }

  void (async () => {
    for (;;) {
      const packet = await read(32)
      const seq = packet.readUInt16LE(2)
      if (packet[0] === 0) {
        errors.push(`X error ${packet[1]} (request ${packet[10]}, value ${packet.readUInt32LE(4)})`)
        const pending = replies.get(seq)
        if (pending) {
          replies.delete(seq)
          pending.reject(new Error(errors.join('; ')))
        }
      } else if (packet[0] === 1) {
        const extra = await read(packet.readUInt32LE(4) * 4)
        const pending = replies.get(seq)
        replies.delete(seq)
        pending?.resolve(Buffer.concat([packet, extra]))
      }
    }
  })().catch(() => undefined)

  const request = (opcode: number, data: number, payload: Buffer): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      replies.set(send(opcode, data, payload), { resolve, reject })
    })

  const u32 = (...values: number[]): Buffer => {
    const out = Buffer.alloc(values.length * 4)
    values.forEach((value, i) => out.writeUInt32LE(value >>> 0, i * 4))
    return out
  }

  return {
    root,
    internAtom: async (atomName, onlyIfExists = false) => {
      const bytes = Buffer.from(atomName, 'latin1')
      const head2 = Buffer.alloc(4)
      head2.writeUInt16LE(bytes.length, 0)
      const reply = await request(16, onlyIfExists ? 1 : 0, Buffer.concat([head2, padded(bytes)]))
      return reply.readUInt32LE(8)
    },
    createWindow: () => {
      const id = idBase | ++nextId
      const geometry = Buffer.alloc(12)
      geometry.writeInt16LE(0, 0)
      geometry.writeInt16LE(0, 2)
      geometry.writeUInt16LE(1, 4)
      geometry.writeUInt16LE(1, 6)
      geometry.writeUInt16LE(0, 8)
      geometry.writeUInt16LE(2, 10) // InputOnly
      send(1, 0, Buffer.concat([u32(id, root), geometry, u32(0, 0)]))
      return id
    },
    destroyWindow: (window) => {
      send(4, 0, u32(window))
    },
    changeProperty: (window, property, type, format, data) => {
      const head2 = Buffer.alloc(4)
      head2[0] = format
      send(18, 0, Buffer.concat([u32(window, property, type), head2, u32(data.length / (format / 8)), padded(data)]))
    },
    deleteProperty: (window, property) => {
      send(19, 0, u32(window, property))
    },
    sync: async () => {
      await request(43, 0, Buffer.alloc(0))
      if (errors.length > 0) {
        const message = errors.join('; ')
        errors = []
        throw new Error(message)
      }
    },
    close: () => {
      socket.destroy()
    },
  }
}
