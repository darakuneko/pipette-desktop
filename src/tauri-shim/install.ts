// SPDX-License-Identifier: GPL-2.0-or-later
// Installs window.vialAPI for the Tauri build. Loaded as a separate module
// script ahead of the renderer entry, so it runs before any renderer module
// reads window.vialAPI.

import { createVialApi } from './stub-proxy'
import { startupApi } from './startup-api'

window.vialAPI = createVialApi({
  ...startupApi,
})
