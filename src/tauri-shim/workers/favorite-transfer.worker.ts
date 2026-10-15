// SPDX-License-Identifier: GPL-2.0-or-later
// The worker that converts the keycodes of the favorite export and import
// for the Tauri build. The keycode tables are module-global state; the
// renderer's copy follows the connected keyboard (custom keycodes, its
// tap dance count, its protocol), and a protocol switch rebuilds it. This
// worker loads its own copy, which stays at the defaults the Electron main
// process converts with, and never touches the renderer's.
//
// Messages: `{ id, request }` in, `{ id, result }` out
// (favorite-transfer-client.ts).

import { runFavoriteTransfer, type FavoriteTransferRequest } from './favorite-transfer-requests'

self.addEventListener('message', (event: MessageEvent<{ id: number; request: FavoriteTransferRequest }>) => {
  const { id, request } = event.data
  self.postMessage({ id, result: runFavoriteTransfer(request) })
})
