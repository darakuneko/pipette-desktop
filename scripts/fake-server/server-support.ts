// SPDX-License-Identifier: GPL-2.0-or-later
// What the fake Drive (scripts/fake-drive) and the fake Hub
// (scripts/fake-hub) servers share: reading a request body, listening on
// loopback only, closing, and running as a stand-alone process.

import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'

/** The whole request body; throws when it is larger than `maxBytes`. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Listens on 127.0.0.1 (on `port`, or a free one) and returns the base URL
 *  and the function that closes the server and its connections. */
export async function listenOnLoopback(
  server: Server,
  port: number | undefined,
  name: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port ?? 0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  if (address.address !== '127.0.0.1') throw new Error(`the ${name} listens on ${address.address}`)
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** When `entryUrl` (the `import.meta.url` of a server module) is the script
 *  being run, starts the server on the port in argv[2], prints its URL and
 *  variables as JSON and serves until SIGTERM or SIGINT. */
export function runStandalone<T extends { url: string; close: () => Promise<void> }>(
  entryUrl: string,
  start: (options: { port: number }) => Promise<T>,
  env: (url: string) => Record<string, string>,
): void {
  if (process.argv[1] === undefined || entryUrl !== pathToFileURL(process.argv[1]).href) return
  const port = process.argv[2] === undefined ? 0 : Number(process.argv[2])
  start({ port }).then((server) => {
    console.log(JSON.stringify({ url: server.url, env: env(server.url) }))
    const stop = (): void => void server.close().then(() => process.exit(0))
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  }, (err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
