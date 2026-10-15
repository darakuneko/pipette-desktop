// SPDX-License-Identifier: GPL-2.0-or-later
// Installs window.vialAPI for the Tauri build, and the right-click
// behavior of the Electron build. Imported first by the Tauri renderer entry
// (src/renderer/tauri-main.ts), so it runs before any renderer module reads
// window.vialAPI.

import { installContextMenuPolicy } from './context-menu'
import { createVialApi } from './create-vial-api'
import { implemented } from './implemented'

window.vialAPI = createVialApi(implemented)
installContextMenuPolicy(window)
