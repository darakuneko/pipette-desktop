// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer entry for the Tauri build (tauri.html). A module evaluates its
// imports in order, each with its own imports first, so the shim has set
// window.vialAPI before ./index or any renderer module it imports runs.

import '../tauri-shim/install'
import './index'
