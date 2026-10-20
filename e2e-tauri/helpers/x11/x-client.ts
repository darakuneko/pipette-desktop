// SPDX-License-Identifier: GPL-2.0-or-later
// A minimal X11 client for the e2e tests (../x11-window.ts): they read
// windows with QueryTree, GetWindowAttributes and GetProperty and ask one to
// close with SendEvent, with InternAtom for the atoms and GetInputFocus as
// the round trip that surfaces errors.
// Little-endian, over the server's local socket, MIT-MAGIC-COOKIE-1 or no
// authorization.

import { createConnection, type Socket } from 'node:net'

const pad4 = (n: number): number => (4 - (n % 4)) % 4

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc(pad4(data.length))])
}

export interface XClient {
  root: number
  internAtom(name: string, onlyIfExists?: boolean): Promise<number>
  /** The children of `window`, bottom to top. */
  queryTree(window: number): Promise<number[]>
  /** Whether `window` is viewable (mapped, and its ancestors too). */
  isViewable(window: number): Promise<boolean>
  /** The value of `property` on `window` (any type, at most 64 KiB), or
   *  null when the window does not have it. */
  getProperty(window: number, property: number): Promise<XProperty | null>
  /** Sends the 32-byte `event` to the client that created `destination`
   *  (SendEvent with an empty event mask). */
  sendEvent(destination: number, event: Buffer): void
  /** The process ids the X server itself knows for the client that created
   *  `window` (X-Resource's QueryClientIds with LocalClientPID): the server
   *  reads them from its local socket, so the client cannot set them. Empty
   *  when the server does not know one; throws without X-Resource. */
  clientPids(window: number): Promise<number[]>
  /** Waits until the server has handled every request sent so far; rejects
   *  with the first X error among them. */
  sync(): Promise<void>
  close(): void
}

export interface XProperty {
  type: number
  format: number
  value: Buffer
}

/** A ClientMessage event of format 32 for `window`: `type` and up to five
 *  32-bit values. */
export function clientMessage(window: number, type: number, data: number[]): Buffer {
  if (data.length > 5) throw new Error('x client: a ClientMessage carries at most five 32-bit values')
  const event = Buffer.alloc(32)
  event[0] = 33 // ClientMessage
  event[1] = 32 // format
  event.writeUInt32LE(window >>> 0, 4)
  event.writeUInt32LE(type >>> 0, 8)
  data.forEach((value, i) => event.writeUInt32LE(value >>> 0, 12 + i * 4))
  return event
}

interface Pending {
  resolve(reply: Buffer): void
  reject(err: Error): void
}

export interface ConnectOptions {
  /** When set, each connection attempt, the setup and each request with a
   *  reply fail after this many ms, and the connection is closed. */
  timeoutMs?: number
}

/** Connects to the local `display` (`:<n>`), authorized with the
 *  MIT-MAGIC-COOKIE-1 `cookie`, or with none when it is null. A request
 *  pending when the connection closes fails. */
export async function connectX(display: string, cookie: Buffer | null, options: ConnectOptions = {}): Promise<XClient> {
  const number = /^:(\d+)$/.exec(display)?.[1]
  if (number === undefined) throw new Error(`x client: unsupported display ${display}`)
  const { timeoutMs } = options
  // As Xlib does: the abstract socket first (an X server run without root
  // may be unable to create /tmp/.X11-unix), then the socket file.
  let found: Socket | null = null
  for (const path of [`\0/tmp/.X11-unix/X${number}`, `/tmp/.X11-unix/X${number}`]) {
    const candidate = createConnection(path)
    const connected = await new Promise<boolean>((resolve) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => resolve(false), timeoutMs)
      candidate.once('connect', () => { clearTimeout(timer); resolve(true) })
      candidate.once('error', () => { clearTimeout(timer); resolve(false) })
    })
    if (connected) {
      found = candidate
      break
    }
    candidate.destroy()
  }
  if (found === null) throw new Error(`x client: cannot connect to ${display}`)
  const socket = found

  let buffer = Buffer.alloc(0)
  let waiter: (() => void) | null = null
  /** Why the connection ended; set once it has. */
  let ended: Error | null = null
  const replies = new Map<number, Pending>()
  const end = (reason: Error): void => {
    if (ended) return
    ended = reason
    socket.destroy()
    for (const pending of replies.values()) pending.reject(reason)
    replies.clear()
    waiter?.()
  }
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    waiter?.()
  })
  socket.on('error', (err) => end(new Error(`x client: ${err.message}`)))
  socket.on('close', () => end(new Error('x client: the connection closed')))
  const read = async (length: number): Promise<Buffer> => {
    while (buffer.length < length) {
      if (ended) throw ended
      await new Promise<void>((resolve) => {
        waiter = resolve
      })
      waiter = null
    }
    const out = buffer.subarray(0, length)
    buffer = buffer.subarray(length)
    return out
  }

  const name = cookie === null ? Buffer.alloc(0) : Buffer.from('MIT-MAGIC-COOKIE-1')
  const data = cookie ?? Buffer.alloc(0)
  const setup = Buffer.alloc(12)
  setup.write('l', 0, 'latin1')
  setup.writeUInt16LE(11, 2)
  setup.writeUInt16LE(0, 4)
  setup.writeUInt16LE(name.length, 6)
  setup.writeUInt16LE(data.length, 8)
  socket.write(Buffer.concat([setup, padded(name), padded(data)]))
  const setupTimer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => end(new Error(`x client: no setup reply within ${timeoutMs} ms`)), timeoutMs)
  let head: Buffer
  let body: Buffer
  try {
    head = await read(8)
    body = await read(head.readUInt16LE(6) * 4)
  } finally {
    clearTimeout(setupTimer)
  }
  if (head[0] !== 1) {
    const reason = new Error(`x client: connection refused: ${body.subarray(0, head[1]).toString('latin1')}`)
    end(reason)
    throw reason
  }
  const vendorLength = body.readUInt16LE(16)
  const formats = body[21]
  const root = body.readUInt32LE(32 + vendorLength + pad4(vendorLength) + formats * 8)

  let sequence = 0
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
        const message = `X error ${packet[1]} (request ${packet[10]}, value ${packet.readUInt32LE(4)})`
        const pending = replies.get(seq)
        // The error of a request with a reply goes to its caller only; the
        // others wait for sync().
        if (pending) {
          replies.delete(seq)
          pending.reject(new Error([...errors, message].join('; ')))
        } else {
          errors.push(message)
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
      if (ended) {
        reject(ended)
        return
      }
      const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => end(new Error(`x client: no reply to request ${opcode} within ${timeoutMs} ms`)), timeoutMs)
      replies.set(send(opcode, data, payload), {
        resolve: (reply) => { clearTimeout(timer); resolve(reply) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
    })
  let xResOpcode: number | null = null

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
    queryTree: async (window) => {
      const reply = await request(15, 0, u32(window))
      const count = reply.readUInt16LE(16)
      return Array.from({ length: count }, (_, i) => reply.readUInt32LE(32 + i * 4))
    },
    isViewable: async (window) => {
      const reply = await request(3, 0, u32(window))
      return reply[26] === 2 // map-state Viewable
    },
    getProperty: async (window, property) => {
      // delete: false, type: AnyPropertyType, offset 0, 16384 32-bit units.
      const reply = await request(20, 0, u32(window, property, 0, 0, 16384))
      const type = reply.readUInt32LE(8)
      if (type === 0) return null
      const format = reply[1]
      const length = reply.readUInt32LE(16) * (format / 8)
      return { type, format, value: Buffer.from(reply.subarray(32, 32 + length)) }
    },
    sendEvent: (destination, event) => {
      if (event.length !== 32) throw new Error('x client: an event is 32 bytes')
      send(25, 0, Buffer.concat([u32(destination, 0), event]))
    },
    clientPids: async (window) => {
      if (xResOpcode === null) {
        const extension = Buffer.from('X-Resource', 'latin1')
        const head2 = Buffer.alloc(4)
        head2.writeUInt16LE(extension.length, 0)
        const reply = await request(98, 0, Buffer.concat([head2, padded(extension)])) // QueryExtension
        if (reply[8] !== 1) throw new Error('x client: the X server has no X-Resource extension')
        xResOpcode = reply[9]
        // QueryVersion 1.2, the version with QueryClientIds.
        await request(xResOpcode, 0, Buffer.from([1, 2, 0, 0]))
      }
      // QueryClientIds of one spec: the client of `window`, LocalClientPID.
      const reply = await request(xResOpcode, 4, u32(1, window, 2))
      const count = reply.readUInt32LE(8)
      const pids: number[] = []
      let offset = 32
      for (let i = 0; i < count; i += 1) {
        const mask = reply.readUInt32LE(offset + 4)
        const length = reply.readUInt32LE(offset + 8)
        if (mask === 2 && length >= 4) pids.push(reply.readUInt32LE(offset + 12))
        offset += 12 + length
      }
      return pids
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
      end(new Error('x client: closed'))
    },
  }
}
