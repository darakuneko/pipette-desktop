# Pipette

Refining the way you interact with your Vial-powered keyboards.

Pipette is an independent, Electron-based keymap editor compatible with [Vial](https://get.vial.today/).
Communicates with VIA/Vial keyboards via node-hid to configure keymaps, macros, lighting, and more.

## Tech Stack

| Category | Technology |
|----------|-----------|
| Runtime | Electron 35+ |
| Language | TypeScript (strict mode) |
| Package Manager | pnpm |
| UI | React 19 + Tailwind CSS v4 |
| Build | electron-vite (Vite-based) |
| Test | Vitest |
| Lint | ESLint + Prettier |

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
pnpm dist:linux   # Linux (AppImage / deb)
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
Main Process        — node-hid transport, CSP, file I/O, window management
Preload (sandbox)   — IPC bridge, VIA/Vial protocol, Keyboard state
Renderer            — React UI (Tailwind CSS)
Shared              — Types, constants, IPC channels
```

## Features

- Keymap editor (layer switching, keycode palette, mask keys)
- Layout editor (VIA-compatible bit packing)
- Macro editor (v1/v2, text/tap/down/up/delay)
- RGB lighting configuration (QMK Backlight / RGBLight)
- Tap Dance / Combo / Key Override / Alt Repeat Key editors
- QMK Settings (dynamic field generation)
- Matrix tester (20ms polling)
- Unlock dialog
- .vil file save/restore
- Internationalization (English / Japanese)

## License

[GPL-2.0-or-later](LICENSE)
