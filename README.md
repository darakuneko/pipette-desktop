# Pipette

Refining the way you interact with your Vial-powered keyboards.

Pipette is an independent, Electron-based keymap editor compatible with [Vial](https://get.vial.today/).  \
Communicates with VIA/Vial keyboards via USB HID to configure keymaps, macros, lighting, and more.

## Features

### Keyboard Configuration

- **Keymap Editor** — Layer-based key assignment with drag & drop, auto-advance, and a searchable keycode palette
- **Layout Editor** — Physical layout switching (split backspace, bottom row variants, etc.)
- **Tap Dance** — Multi-tap key behaviors (tap, hold, double-tap, tap+hold, custom tapping term)
- **Combo** — Simultaneous key-press to trigger output keys
- **Key Override** — Replace key output when specific modifiers are held
- **Alternate Repeat Key** — Context-aware alternate repeat key bindings
- **Macro Editor** — Create and record macros with text, tap, hold, release, and delay actions (v1/v2 protocol)
- **RGB Lighting** — QMK Backlight, RGBLight, and VialRGB configuration
- **QMK Settings** — Dynamic firmware settings with boolean/integer fields
- **Matrix Tester** — Real-time key switch verification (20 ms polling)

### Firmware

- **Firmware Flasher** — Flash `.vfw` firmware via Vial Bootloader with optional layout restore

### Data Management

- **Snapshots** — Save and restore complete keyboard states (keymap, macros, dynamic entries, QMK settings)
- **Favorites** — Save reusable tap dance, macro, combo, key override, and alternate repeat key configurations across keyboards
- **Export** — Download keymap as `.vil`, `.pipette`, `keymap.c`, or PDF cheat sheet
- **Import** — Load `.vil` files to restore keyboard state

### Layer Names

Pipette allows you to assign custom names to each layer. Layer names are stored per-keyboard and synced across devices.  \
These names are Pipette-specific — they are not written to the keyboard firmware and are not visible in Vial or other keymap editors.

| Default Name | Common Example |
|-------------|----------------|
| Layer 0 | Base layer (QWERTY, Dvorak, etc.) |
| Layer 1 | Symbol / number layer |
| Layer 2 | Navigation / function keys |
| Layer 3 | Media / adjustment layer |

You can rename layers freely in the editor settings to match your workflow.

### Cloud Sync (Google Drive appDataFolder)

Sync your snapshots, favorites, and per-keyboard settings across devices via [Google Drive appDataFolder](https://developers.google.com/workspace/drive/api/guides/appdata).  \
The appDataFolder is **not** regular Google Drive storage — it is a hidden, app-specific folder that only Pipette can access. Your personal Drive files are never touched.

See [Data Guide](docs/Data.md) for details on what is synced and how your data is protected.

### Pipette Hub

Upload and share your keymaps on [Pipette Hub](https://pipette-hub-worker.keymaps.workers.dev), a community keymap gallery.

See [Data Guide](docs/Data.md) for details on how Hub authentication works.

### Utilities

- **Typing Test** — Built-in typing test with WPM/accuracy tracking, downloadable language packs, and per-keyboard history
- **Light / Dark / System theme**
- **Keyboard layout override** (QWERTY, Dvorak, etc.) for correct label display
- **Configurable panel side** (left / right)
- **Auto-lock timer**

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev          # Start Electron dev server
pnpm build        # Production build
pnpm test         # Run tests
pnpm test:watch   # Tests (watch mode)
pnpm lint         # ESLint
pnpm format       # Prettier
```

## Build & Distribution

```bash
pnpm dist         # Package for all platforms
pnpm dist:linux   # Linux (AppImage)
pnpm dist:win     # Windows (NSIS installer)
pnpm dist:mac     # macOS (dmg)
```

### Linux: udev Rules

udev rules are required to access keyboards:

```bash
sudo cp scripts/99-vial.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

## Architecture

Raw HID I/O runs in the **main process** via `node-hid`. Protocol logic runs in the **preload** layer and delegates HID I/O through IPC.

```
Main Process        — node-hid transport, CSP, file I/O, window management,
                      cloud sync, Hub API, snapshot/favorite stores
Preload (sandbox)   — IPC bridge, VIA/Vial protocol, Keyboard state
Renderer            — React UI (Tailwind CSS)
Shared              — Types, constants, IPC channels
```

## Built With

[![Electron](https://img.shields.io/badge/Electron-47848F?style=flat&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?style=flat&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_v4-06B6D4?style=flat&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat&logo=vitest&logoColor=white)](https://vitest.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)](https://playwright.dev/)
[![pnpm](https://img.shields.io/badge/pnpm-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/)

## Data & Privacy

See the [Data Guide](docs/Data.md) for a complete guide on what data Pipette stores, how cloud sync works, and the security measures in place for external services.

## Donate

A cup of coffee keeps the commits coming ☕

[Amazon Wishlist](https://www.amazon.co.jp/hz/wishlist/ls/66VQJTRHISQT) | [Ko-fi](https://ko-fi.com/darakuneko)

## License

[GPL-3.0-or-later](LICENSE)
