# Data Guide

This document describes what data Pipette stores, where it lives, and how external services are used.

---

## Table of Contents

- [Local Data](#local-data)
  - [App Settings](#app-settings)
  - [Per-Keyboard Settings](#per-keyboard-settings)
  - [Typing Analytics](#typing-analytics)
  - [Snapshots](#snapshots)
  - [Favorites](#favorites)
  - [Key Labels](#key-labels)
  - [Typing Test Language Packs](#typing-test-language-packs)
  - [Logs](#logs)
  - [Authentication Credentials](#authentication-credentials)
- [Keyboard-Side Data](#keyboard-side-data)
- [Cloud Sync (Google Drive appDataFolder)](#cloud-sync-google-drive-appdatafolder)
  - [How It Works](#how-it-works)
  - [What Is Synced](#what-is-synced)
  - [Security & Privacy](#security--privacy)
  - [Google OAuth Scopes](#google-oauth-scopes)
- [Pipette Hub](#pipette-hub)
  - [What Is It](#what-is-it)
  - [How It Works](#how-it-works-1)
  - [What Is Uploaded](#what-is-uploaded)
  - [Security & Privacy](#security--privacy-1)
- [Export Formats](#export-formats)
- [Reset Operations](#reset-operations)

---

## Local Data

All local data is stored under the OS user data directory:

| OS | Path |
|----|------|
| Linux | `~/.config/Pipette/` |
| macOS | `~/Library/Application Support/Pipette/` |
| Windows | `%APPDATA%/Pipette/` |

### App Settings

General preferences that apply across all keyboards.

| Item | Description |
|------|-------------|
| Theme | Light, Dark, or System |
| Language | UI language (English / Japanese) |
| Auto-lock timer | 10 - 60 minutes |
| Default keyboard layout | QWERTY, Dvorak, etc. |
| Default auto-advance | Move to next key after assignment |
| Default layer panel open | Initial state of the layer list panel for new keyboards |
| Default basic view type | Default Basic tab view (ANSI / ISO / JIS / List) |
| Default split key mode | Default split-key display mode (split or flat) |
| Default quick select | Default quick-select mode for the keycode popover |
| Max keymap history | Maximum number of keymap changes kept in edit history |
| Auto sync | Enable/disable cloud sync |
| Hub enabled | Enable/disable Pipette Hub integration |
| Window position & size | Restored on next launch |
| Typing recording consent | Whether the typing-analytics recording consent dialog has been accepted (gates the REC tab Start button) |
| Typing-view heatmap window | Window length (minutes) for the typing-view real-time heatmap overlay |
| Monitor App enabled | Whether to capture the active application name during typing-analytics recording. Required for the App filter and By App tab in Analyze |

### Per-Keyboard Settings

Settings tied to a specific keyboard, identified by its unique ID.

| Item | Description |
|------|-------------|
| Keyboard layout override | Display labels using a specific layout |
| Auto-advance | Per-keyboard override |
| Layer names | Custom names for each layer (Pipette-only; not written to firmware or visible in other apps) |
| Layer panel open | Whether the layer list panel is expanded |
| Basic view type | Basic tab view (ANSI / ISO / JIS / List) |
| Split key mode | How split-key tiles are displayed (split or flat) |
| Quick select | Quick-select mode for the keycode popover |
| Keymap scale | Keymap zoom level |
| View mode | Last active view (Editor / Typing Test / Typing View) — auto-restored on reconnect |
| Typing test history | WPM/accuracy records (up to 500 entries) |
| Typing test config | Mode, word count, and other test preferences |
| Typing test language | Selected language pack |
| Typing view preferences | Compact window size and always-on-top setting |
| Record enabled | User-chosen state of the REC toggle in the typing view; recording is gated additionally on Typing View being open |
| Typing view menu tab | Last active menu pane tab in Typing View (Window / REC) |
| Typing sync span | How many days of typing-analytics history to sync (per-device JSONL) |
| Analyze finger assignments | Manual `row,col → finger` overrides for the Ergonomics tab |
| Analyze goal | Daily keystroke goal, target consecutive days, and goal-edit history for the Streak / Goal cards |
| Analyze filters | Per-tab filter state (device scope, app scope, view modes, ranking limits, snapshot selection) for the Analyze dashboard |
| Analyze compare filters | Same shape as Analyze filters, bound to the secondary pane in the Analyze split-view |

### Typing Analytics

Per-keyboard typing history that feeds the Analyze page (see OPERATION-GUIDE §1.4). Recorded while you are in Typing View and the Record toggle in the typing-test pane is set to Start; typing-test results flow into the same stream.

| Item | Description |
|------|-------------|
| Keystroke events | Per-keystroke records aggregated into minute buckets |
| Minute stats | WPM, Backspace %, interval percentiles, and other per-minute summaries |
| Matrix activity | Per-cell press counts with the active layer at the time |
| Sessions | Start / end markers for each typing session |
| Keymap snapshots | Point-in-time keymap captures used to resolve heatmap positions and layer-op targets |
| App tag | Active application name attached to each minute when Monitor App is on. Minutes that observed only one app carry that name; minutes that observed multiple apps are tagged as unknown; minutes captured while Monitor App was off are not tagged. Powers the App filter and the By App tab in Analyze |

**What is synced, what is local cache**

| Storage | Path (under user data directory) | Scope |
|---------|-----------------------------------|-------|
| Per-device typing log (master) | `sync/keyboards/{uid}/devices/{machineHash}/{YYYY-MM-DD}.jsonl` | **Synced** across your signed-in devices |
| Keymap snapshots (master) | `typing-analytics/keymaps/{uid}/{machineHash}/*.json` | Local only (per machine) |
| Query cache (SQLite) | `local/typing-analytics.db` | Local only — rebuilt from the JSONL master when missing or stale |

The JSONL master is the source of truth and survives cache rebuilds. When the app can't find the SQLite cache (first launch on a new machine, file corruption, schema upgrade), it replays the JSONL log to rebuild it; no data is lost.

**Layer names in the chart** come from Per-Keyboard Settings above, not from typing analytics — renaming a layer in the layer panel updates the axis label in Analyze the next time you open it.

### Snapshots

Complete point-in-time captures of a keyboard's state. Each snapshot contains:

| Item | Description |
|------|-------------|
| Keymap | All layers, all keys |
| Encoder mappings | Clockwise/counter-clockwise assignments per layer |
| Layout options | Physical layout selections |
| Macros | All macro definitions |
| Tap Dance entries | All tap dance configurations |
| Combos | All combo definitions |
| Key Overrides | All key override rules |
| Alternate Repeat Keys | All alt repeat key mappings |
| QMK Settings | All firmware settings |
| Layer names | Custom layer names |
| Keyboard definition | Physical key layout and matrix info (v2+) |

Snapshots are created manually via "Save Current State" and stored as `.pipette` files. They can be restored to the keyboard or exported as `.vil` files.

The `.pipette` format has two versions:
- **v1** (legacy): No `version` field, no keyboard definition embedded.
- **v2** (current): Includes `version: 2` and embeds the `KeyboardDefinition` (physical key layout, matrix dimensions) so the snapshot can render a virtual keyboard without a physical device connected.

Legacy v1 files are automatically migrated to v2 when loaded with a connected device.

### Favorites

Reusable configurations that work across any keyboard. Individual entries can be uploaded to Pipette Hub.

| Type | Description |
|------|-------------|
| Tap Dance | Saved tap dance entry |
| Macro | Saved macro sequence |
| Combo | Saved combo definition |
| Key Override | Saved key override rule |
| Alternate Repeat Key | Saved alt repeat key mapping |

Each favorite entry may have an associated `hubPostId` if it has been uploaded to Hub. Renaming a Hub-uploaded favorite also updates its title on Hub.

### Key Labels

Maps QMK keycode ids to keycap legends used by the Keymap Editor, the Keycodes Overlay Panel, the Settings → Defaults dropdown, and the Layout Comparison view. QWERTY ships built-in; every other label set (Dvorak, Colemak, French, Brazilian, …) is downloaded from Pipette Hub or imported as a `.json` file. The store is shared across keyboards (it survives Reset Keyboard Data) and syncs entry-by-entry across machines.

A Key Label `.json` is a small JSON object:

```json
{
  "name": "Brazilian (QWERTY)",
  "map": { "KC_2": "2\n@", "KC_QUOT": "ç", "KC_GRAVE": "KC_LALT" },
  "compositeLabels": { "LSFT(KC_2)": "@", "LALT(KC_L)": "KC_LALT" }
}
```

| Field | Required | Purpose |
|------|:--:|---------|
| `name` | Yes | Display name and uniqueness key for overwrite-on-import |
| `map` | Yes | `QMK keycode id → label string`. Lines are split on `\n` to control the cap layout (1 = centred, 2 = stacked, 3 = three slices, 4 = 2 × 2 quadrants). Empty parts leave a slot blank |
| `compositeLabels` | No | Overrides for composite keycodes (e.g. `LT(0,KC_A)`, `LSFT(KC_2)`). Composite caps render the inner key in an inset rectangle, so only the first two `\n` parts of the outer label are honoured |

Values may also be plain QMK keycode ids (e.g. `"LALT(KC_L)": "KC_LALT"`). The editor runs the value through `keycodeLabel()` before display, so a keycode-id value resolves to that keycode's canonical legend automatically.

See `docs/OPERATION-GUIDE.md` §6.2 for the full authoring guide and the modal walkthrough.

### Typing Test Language Packs

Word lists downloaded from the server for the typing test. Can be managed (download / delete) from the typing test language selector.

### Logs

Rotating log files for debugging. No keyboard data or personal information is logged.

### Authentication Credentials

OAuth tokens and sync password are encrypted using the OS keychain (Electron `safeStorage`). These are never stored in plain text.

---

## Keyboard-Side Data

The following data is stored in the keyboard's own memory (EEPROM / dynamic RAM). This data persists even if Pipette is uninstalled — it is erased only by a keyboard factory reset.

- Keymap (all layers)
- Encoder mappings
- Layout options
- Macro buffer
- Tap Dance, Combo, Key Override, Alternate Repeat Key entries
- QMK Settings values
- Lighting configuration (backlight, RGB)
- Lock/unlock state

Pipette reads and writes this data via USB HID using the VIA/Vial protocol. Changes are applied directly to the keyboard when you edit them.

---

## Cloud Sync (Google Drive appDataFolder)

### How It Works

Pipette uses [Google Drive **appDataFolder**](https://developers.google.com/workspace/drive/api/guides/appdata) to sync your data across devices. The appDataFolder is **not** regular Google Drive storage — it is a hidden, app-specific folder that only the app which created it (identified by its OAuth client ID) can access. Its contents are invisible to the user and to other Google Drive applications.

- Sync is **opt-in** — you must sign in with Google and set a sync password to enable it
- Synced data is **end-to-end encrypted** before upload (AES-256-GCM with a key derived from your sync password via PBKDF2)
- Sync happens automatically when changes are detected (with a 10-second debounce) and via periodic polling (every 3 minutes)
- Pending changes are flushed on app exit
- **Selective sync scope**: Not all keyboards' data is downloaded at once. On device connection, favorites are downloaded first, then the connected keyboard's snapshots and settings are downloaded (in full) once its UID is confirmed. Keyboards you have never connected on this machine are left undownloaded; their data is fetched on demand when you open them from the **Data** modal's Sync section. Manual sync (**Sync**) and background polling keep the currently connected keyboard and favorites in sync — other keyboards' data is never pulled down automatically
- **Lightweight keyboard name index**: A small synced index (UID → keyboard name) is kept so that remote-only keyboards can be shown by name in the Data modal before their full data is ever downloaded. The index holds only UIDs and keyboard names — no keymap, macro, or setting data

### What Is Synced

| Data | Sync Unit |
|------|-----------|
| Snapshots | Per keyboard |
| Per-keyboard settings | Per keyboard |
| Favorites | Per type (tap dance, macro, etc.) |
| Keyboard name index (UID → name) | Single shared index |

App settings (theme, language, window state, etc.) are **not** synced.

### Security & Privacy

| Concern | How it's addressed |
|---------|--------------------|
| **What permissions does Pipette request?** | The only Drive-related scope is `drive.appdata`, which allows access exclusively to Pipette's own Application Data folder. Additionally, `openid`, `email`, and `profile` are requested for identity verification (see scope table below). |
| **Can Pipette access my Google Drive files?** | **No.** The `drive.appdata` scope grants access exclusively to a hidden folder created by Pipette. It cannot list, read, modify, or delete any of your personal files, documents, photos, or other Drive content. |
| **Can other apps see Pipette's data?** | **No.** The Application Data folder is invisible to the user and to other applications. Only the app that created it (identified by its OAuth client ID) can access it. |
| **Is my data encrypted?** | **Yes.** All data is encrypted with AES-256-GCM using a key derived from your sync password (PBKDF2, 600,000 iterations) before it leaves your device. Google stores only encrypted blobs. |
| **Can Pipette's developers read my synced data?** | **No.** Encryption happens on your device with your password. Without your sync password, the encrypted data is unreadable. |
| **What happens if I sign out?** | Local data is preserved. Cloud data remains in Google Drive appDataFolder but is no longer synced. You can sign back in to resume syncing. |
| **How do I delete all cloud data?** | Use "Reset Sync Data" in settings and select both keyboard and favorite data. This removes selected `keyboards_*.enc` / `favorites_*.enc` files from Google Drive appDataFolder. The keyboard name index (`meta_keyboard-names.enc`) and password check (`password-check.enc`) are retained; deletions are propagated to other signed-in devices via tombstone entries in the name index (garbage-collected after 30 days). |
| **What is stored on Google?** | Encrypted files named by sync unit (e.g., `keyboards_{uid}_snapshots.enc`, `favorites_tapDance.enc`, `meta_keyboard-names.enc`, `password-check.enc`). File names contain keyboard UIDs but no personal information. |
| **How does authentication work?** | Standard Google OAuth 2.0 with PKCE (Proof Key for Code Exchange) via a local loopback redirect. No passwords are sent to any third-party server. |
| **What happens if I change my password?** | All synced files are re-encrypted with the new password. No data is deleted — files are decrypted and re-encrypted in place. |
| **What are undecryptable files?** | Files that cannot be decrypted with your current sync password or are otherwise unreadable (e.g., leftover from a previous password). You can scan for and delete them from the Data tab in settings. |

### Google OAuth Scopes

| Scope | Purpose |
|-------|---------|
| `drive.appdata` | Read/write Pipette's own Application Data folder |
| `openid` | Verify user identity |
| `email` | Display signed-in email address |
| `profile` | Display user name |

---

## Pipette Hub

### What Is It

[Pipette Hub](https://pipette-hub-worker.keymaps.workers.dev) is a community keymap gallery where you can share your keyboard configurations.

### How It Works

- Uploading requires signing in with the same Google account used for sync
- Pipette sends your Google `id_token` to the Hub server, which verifies it against Google's public keys and issues a short-lived Hub session token
- **Keyboard snapshot uploads** include: keymap data (`.vil` and `.pipette` formats), a `keymap.c` export, a PDF cheat sheet, and a thumbnail screenshot
- **Favorite entry uploads** include: the favorite configuration as a JSON file (Pipette's favorite export format with QMK keycode names)

### What Is Uploaded

**Keyboard Snapshots:**

| Item | Description |
|------|-------------|
| Title | User-provided post title |
| Keyboard name | Name of the keyboard |
| `.vil` file | Keymap in VIL format |
| `.pipette` file | Keymap in Pipette format |
| `keymap.c` | QMK-compatible C source |
| PDF | Printable keymap cheat sheet |
| Thumbnail | Screenshot of the current keymap view |

**Favorite Entries (Tap Dance, Macro, Combo, Key Override, Alt Repeat Key):**

| Item | Description |
|------|-------------|
| Title | Favorite entry label |
| Post type | Entry type (`td`, `macro`, `combo`, `ko`, `ark`) |
| JSON file | Favorite configuration in Pipette export format (with QMK keycode names) |

### Security & Privacy

| Concern | How it's addressed |
|---------|--------------------|
| **What permissions does Hub require?** | No additional permissions beyond the Google sign-in already used for sync. Hub authenticates using the same Google `id_token`. |
| **Can Hub access my Google Drive or other data?** | **No.** Hub only receives and verifies your Google `id_token` to confirm your identity. It does not request any Google API scopes and cannot access any of your Google data. |
| **Who can upload and delete posts?** | Only the authenticated owner. Pipette is the official client for uploading and deleting posts, and all actions require a valid Hub session token tied to your Google account. |
| **Can I delete my uploads?** | **Yes.** You can delete your own posts from within Pipette. |
| **Where is Hub data stored?** | On Cloudflare infrastructure (Workers, D1 database, R2 storage). |
| **Is the Hub server open source?** | The Hub server is a separate project. Pipette's source code (this repository) is fully open — you can verify exactly what data is sent. |

---

## Export Formats

Pipette can export keymap data in several formats. These are local file downloads and do not involve any network requests.

| Format | Extension | Description |
|--------|-----------|-------------|
| VIL | `.vil` | Complete keyboard state (compatible with Vial GUI) |
| Pipette | `.pipette` | Pipette's snapshot format (includes layer names) |
| keymap.c | `.c` | QMK-compatible C source code |
| PDF (Keymap) | `.pdf` | Printable keymap cheat sheet |
| PDF (Layout) | `.pdf` | Layout export with key outlines and summary pages for dynamic entries |

---

## Reset Operations

| Operation | Snapshots | Settings | Favorites | Cloud Data | Hub Posts | App Settings |
|-----------|:---------:|:--------:|:---------:|:----------:|:--------:|:------------:|
| Reset Keyboard Data | Deleted | Deleted | - | Deleted for that keyboard | - | - |
| Reset Local Data | Selected targets deleted | Selected targets deleted | Selected targets deleted | - | - | Selected targets reset to defaults |
| Reset Sync Data | - | - | - | Selected targets deleted | - | - |
| Change Password | - | - | - | All files re-encrypted | - | - |
| Sign Out | - | - | - | - | - | - |
| Export/Import Local Data | Included | Included | Included | - | - | - |

> **Note**: Reset Local Data allows you to select individual targets — keyboard data, favorites, and app settings can each be reset independently.
>
> **Note**: Reset Local Data and Reset Sync Data do not delete the local keyboard name index (`sync/meta/keyboard-names.json`) or the remote index file (`meta_keyboard-names.enc`). Reset Keyboard Data and Reset Sync Data mark the affected UIDs as deleted in the index (tombstone, 30-day TTL) so other signed-in devices see the removal; the index file itself is retained.
