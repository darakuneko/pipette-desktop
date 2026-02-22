# Pipette Operation Guide

[日本語版はこちら](OPERATION-GUIDE.ja.md)

This document explains how to use the Pipette desktop application.
Screenshots were taken using a GPK60-63R keyboard.

---

## 1. Device Connection

### 1.1 Device Selection Screen

When you launch the app, a list of connected Vial-compatible keyboards is displayed.

![Device Selection Screen](screenshots/01-device-selection.png)

- USB-connected keyboards are automatically detected
- If multiple keyboards are connected, select one from the list
- On Linux, udev rules may need to be configured if no devices are found

### 1.2 Connecting a Keyboard

Click a keyboard name in the list to open the keymap editor. A connecting overlay shows loading progress while the keyboard data is read.

If Cloud Sync is configured, sync progress is also displayed during connection (favorites first, then keyboard-specific data).

### 1.3 Data Modal

The Data button on the device selection screen opens the Data modal for centralized management of favorites and Hub posts.

![Data Modal — Favorites](screenshots/02-data-modal.png)

- **Favorites tabs**: Tap Dance, Macro, Combo, Key Override, Alt Repeat Key — each type has its own tab
- Per-entry actions: click to rename, delete, or **Export** individual entries
- **Import** / **Export All** buttons at the footer for bulk operations

![Data Modal — Hub Posts](screenshots/02-data-modal-hub-posts.png)

- **Hub Posts** tab: Manage your Pipette Hub uploads (visible when Hub is connected)

---

## 2. Keymap Editor

### 2.1 Screen Layout

The keymap editor consists of two main areas: the keyboard layout display and the keycode palette.

![Keymap Editor Overview](screenshots/03-keymap-editor-overview.png)

- Top area: Physical keyboard layout (shows the current keycode assigned to each key)
- Left side: Toolbar (dual mode, zoom, typing test, etc.)
- Bottom area: Keycode palette (tabbed interface)
- Bottom bar: Status bar

### 2.2 Changing Keys

1. Click a key on the keyboard layout to select it
2. Click a keycode from the keycode palette to assign it
3. The key display updates immediately
4. Changes are automatically sent to the keyboard

- Ctrl+click to select multiple keys
- Shift+click for range selection

### 2.3 Layer Switching

Layer switching buttons are located on the left side of the keyboard layout.

![Layer 0](screenshots/04-layer-0.png)

![Layer 1](screenshots/05-layer-1.png)

![Layer 2](screenshots/06-layer-2.png)

- Click layer number buttons to switch between layers
- Layer 0 is the default layer
- The number of available layers depends on the keyboard configuration

### 2.4 Key Popover

Double-click a key on the keyboard layout to open the Key Popover — a quick way to search and assign keycodes without scrolling through the palette.

**Key Tab**

![Key Popover — Key Tab](screenshots/32-key-popover-key.png)

- The search input is pre-filled with the current keycode name
- Type to search by name, QMK ID, or alias — results are ranked by relevance
- Click a result to assign it immediately
- The popover also appears when double-clicking key fields in detail editors (Tap Dance, Combo, Key Override, etc.)

**Code Tab**

![Key Popover — Code Tab](screenshots/33-key-popover-code.png)

- Enter a keycode value directly in hexadecimal (e.g., `0x0029` for Escape)
- The resolved keycode name is displayed below the hex input
- Click **Apply** to assign the entered keycode

**Mod Mask / Mod-Tap Mode**

![Key Popover — Modifier Mode](screenshots/34-key-popover-modifier.png)

- **Mod Mask**: Click to combine a modifier with a key (e.g., `LSFT(KC_ESCAPE)`)
- **Mod-Tap**: Click to set modifier on hold, key on tap
- Use the modifier checkbox strip to select Left/Right Ctrl, Shift, Alt, or GUI
- Left and Right modifiers cannot be mixed — selecting one side disables the other

Press Escape or click outside the popover to close it.

---

## 3. Keycode Palette

Select keycodes from different categories using the tabbed palette at the bottom of the screen.

### 3.1 Basic

Standard character keys, function keys, modifier keys, and navigation keys.

![Basic Tab](screenshots/07-tab-basic.png)

- Character keys (A-Z, 0-9, symbols)
- Function keys (F1-F24)
- Editing keys (Enter, Tab, Backspace, Delete)
- Navigation keys (arrows, Home, End, PageUp/Down)
- Numpad keys

### 3.2 Layers

Keycodes for layer operations.

![Layers Tab](screenshots/08-tab-layers.png)

- **MO(n)**: Momentarily activate layer n while held
- **DF(n)**: Set default layer to n
- **TG(n)**: Toggle layer n
- **LT(n, kc)**: Layer on hold, keycode on tap
- **OSL(n)**: Activate layer n for the next keypress only
- **TO(n)**: Switch to layer n

### 3.3 Modifiers

Keycodes for modifier key combinations and tap behavior settings.

![Modifiers Tab](screenshots/09-tab-modifiers.png)

- **One-Shot Modifier (OSM)**: Activate modifier for the next keypress only
- **Mod-Tap**: Modifier on hold, regular key on tap
- **Mod Mask**: Modifier key combinations

### 3.4 Tap-Hold / Tap Dance

Keycodes that assign different actions to tap and hold.

![Tap-Hold / Tap Dance Tab](screenshots/10-tab-tapDance.png)

- Click a Tap Dance entry to open the edit modal
- Configure tap, hold, double-tap, and other actions for each entry

### 3.5 Macro

Macro keycodes.

![Macro Tab](screenshots/11-tab-macro.png)

- Click a macro entry to open the edit modal
- Record sequences of key inputs as macros

### 3.6 Quantum

Keycodes for advanced QMK features.

![Quantum Tab](screenshots/12-tab-quantum.png)

- Boot (bootloader mode)
- Caps Word
- Magic keys
- Auto Shift
- Combo
- Key Override
- Alt Repeat Key
- Swap Hands

### 3.7 Media

Keycodes for media keys, mouse keys, and joystick operations.

![Media Tab](screenshots/13-tab-media.png)

- Mouse buttons, movement, and scrolling
- Media playback controls (play/stop/volume)
- Application launcher keys

### 3.8 Lighting

Keycodes for backlight and RGB lighting controls.

![Lighting Tab](screenshots/14-tab-backlight.png)

- RGB Matrix controls
- RGB Lighting controls
- Backlight controls
- LED Matrix controls

### 3.9 User

User-defined keycodes.

![User Tab](screenshots/15-tab-user.png)

- Custom keycodes defined in firmware

> **Note**: The MIDI tab is only displayed for MIDI-capable keyboards.

---

## 4. Toolbar

The toolbar on the left side of the keymap editor provides the following features.

![Toolbar](screenshots/16-toolbar.png)

### 4.1 Dual Mode (Split Edit)

Displays two keyboard layouts side by side for comparing and copying keys between layers.

![Dual Mode](screenshots/17-dual-mode.png)

- Click the button to toggle dual mode
- Useful for copying key settings between layers

### 4.2 Zoom

Adjusts the keyboard layout display scale.

![Zoom In](screenshots/18-zoom-in.png)

- (+) button to zoom in
- (-) button to zoom out
- Can also be adjusted in editor settings

### 4.3 Typing Test

A typing practice feature. Test your typing with the current keymap.

![Typing Test](screenshots/19-typing-test.png)

- Measures WPM (Words Per Minute) and accuracy
- Toggle punctuation and numbers on/off
- View test result history

---

## 5. Detail Setting Editors

Open detail setting modals from the settings buttons at the bottom of each keycode palette tab.

### 5.1 Lighting Settings

Open from the Lighting tab settings button. Configure RGB lighting colors and effects.

![Lighting Settings](screenshots/20-lighting-modal.png)

- Select colors with the HSV color picker
- Choose colors from preset palette
- Adjust effects and speed
- Click Save to apply

### 5.2 Combo

Open from the Quantum tab combo settings button. Configure simultaneous key press combinations to trigger different keys. The combo editor uses a **2-screen flow**: a tile grid overview followed by a detail editor.

**Screen 1 — Tile Grid Overview**

![Combo List](screenshots/21-combo-modal.png)

Shows a grid of numbered tiles (0--31). Configured entries display a summary (e.g., "A + B -> C"). Click a tile to open the detail editor. Timeout (ms) and Save button are shown on this screen.

**Screen 2 — Detail Editor**

![Combo Detail](screenshots/22-combo-detail.png)

- Left panel: Combo editor with Key 1--4 and Output fields
- Right panel: Inline favorites panel (Save Current State / Synced Data / Import / Export All)
- **Clear** resets all fields; **Revert** restores the last saved state. Both use two-step confirmation.
- **Save** writes changes to the keyboard
- **Back** returns to the tile grid overview

### 5.3 Key Override

Open from the Quantum tab key override settings button. Replace specific key inputs with different keys. The key override editor uses the same **2-screen flow** as Combo.

**Screen 1 — Tile Grid Overview**

![Key Override List](screenshots/23-key-override-modal.png)

Shows a grid of numbered tiles. Configured entries display a summary. Click a tile to open the detail editor.

**Screen 2 — Detail Editor**

![Key Override Detail](screenshots/24-key-override-detail.png)

- Left panel: Trigger Key, Replacement Key, enabled toggle, layer and modifier options
- Right panel: Inline favorites panel (Save Current State / Synced Data / Import / Export All)
- **Clear** resets all fields; **Revert** restores the last saved state. Both use two-step confirmation.
- **Save** writes changes to the keyboard
- **Back** returns to the tile grid overview

### 5.4 Alt Repeat Key

Open from the Quantum tab Alt Repeat Key settings button. Configure alternative actions for the Repeat Key. The Alt Repeat Key editor uses the same **2-screen flow** as Combo.

**Screen 1 — Tile Grid Overview**

![Alt Repeat Key List](screenshots/25-alt-repeat-key-modal.png)

Shows a grid of numbered tiles. Configured entries display a summary. Click a tile to open the detail editor.

**Screen 2 — Detail Editor**

![Alt Repeat Key Detail](screenshots/26-alt-repeat-key-detail.png)

- Left panel: Trigger Key, Replacement Key, enabled toggle, modifier options
- Right panel: Inline favorites panel (Save Current State / Synced Data / Import / Export All)
- **Clear** resets all fields; **Revert** restores the last saved state. Both use two-step confirmation.
- **Save** writes changes to the keyboard
- **Back** returns to the tile grid overview

### 5.5 Favorites

Each editor modal (Tap Dance, Macro, Combo, Key Override, Alt Repeat Key) includes an inline **Favorites panel** on the right side of the editor.

![Inline Favorites Panel](screenshots/31-inline-favorites.png)

The inline favorites panel provides:

- **Save Current State**: Enter a label and click Save to store the current entry configuration
- **Synced Data**: Previously saved entries are listed with Load, Rename, Delete, and Export actions
- **Import** / **Export All**: Footer buttons for bulk import/export of favorites

Within the Synced Data list:

- **Load**: Apply a saved configuration to the current entry
- **Rename**: Change the label of a saved entry
- **Delete**: Remove a saved entry
- **Export**: Download an individual saved entry as a file

> **Note**: Favorites are not tied to a specific keyboard — saved entries can be loaded on any compatible keyboard. When Cloud Sync is enabled, favorites are also synced across devices (see §6.4). Favorites can also be managed from the Data modal on the device selection screen (see §1.3).

---

## 6. Editor Settings Panel

Open the editor settings panel from the settings button (gear icon) in the keymap editor.

### 6.1 Layer Settings (Layers Tab)

![Layer Settings](screenshots/27-editor-settings-layers.png)

- Layer list with the current layer highlighted
- Click a layer to switch to it
- Click a layer name to rename it (custom names are saved per keyboard)

Layer names are Pipette-specific — they are not written to the keyboard firmware and are not visible in Vial or other keymap editors.

| Default Name | Common Example |
|-------------|----------------|
| Layer 0 | Base layer (QWERTY, Dvorak, etc.) |
| Layer 1 | Symbol / number layer |
| Layer 2 | Navigation / function keys |
| Layer 3 | Media / adjustment layer |

### 6.2 Tool Settings (Tools Tab)

![Tool Settings](screenshots/28-editor-settings-tools.png)

- **Keyboard Layout**: Select the display layout for key labels (QWERTY, Dvorak, etc.)
- **Zoom**: Adjust the keyboard layout display scale
- **Auto Advance**: Toggle automatic advancement to the next key after assigning a keycode
- **Key Tester**: Toggle Matrix Tester mode (supported keyboards only)
- **Security**: Shows lock status (Locked/Unlocked) with a Lock button to re-lock the keyboard

### 6.3 Data Management (Data Tab)

![Data Management](screenshots/29-editor-settings-data.png)

- **Import**: Restore from `.vil` files or sideload custom JSON definitions
- **Export Current State**: Download keymap as `.vil`, `keymap.c`, or PDF cheat sheet
- **Save Current State**: Save a snapshot of the current keyboard state with a label. Enter a name in the Label field and click Save. If the Label field is left empty, the Save button is disabled. Saved snapshots appear in the Synced Data list below and can be loaded or deleted later
- **Synced Data**: List of saved snapshots. Click to load, rename, or delete entries
- **Reset Keyboard Data**: Reset keyboard to factory defaults (use with caution)

### 6.4 Cloud Sync (Google Drive appDataFolder)

Pipette can sync your saved snapshots, favorites, and per-keyboard settings across multiple devices via Google Drive.

Sync is configured in the **Settings** modal (gear icon on the device selection screen), under the **Data** tab:

![Data Tab](screenshots/hub-settings-data-sync.png)

The Data tab contains the following sections: Google Account, Data Sync, Pipette Hub, and Troubleshooting.

#### Google Account

- Click **Connect** to sign in with your Google account
- Click **Disconnect** to sign out. If Pipette Hub is also connected, a warning confirms that Hub will be disconnected as well

#### Sync Encryption Password

- Set a password to encrypt all synced data (required). A strength indicator helps you choose a strong password
- If a password already exists on the server (set from another device), a hint is shown asking you to enter the same password
- **Change Password**: Click **Change Password** to re-encrypt all synced files with a new password. No data is deleted — existing files are decrypted and re-encrypted in place

#### Sync Controls

- **Auto Sync**: Toggle automatic sync on or off. When enabled, changes sync automatically with a 10-second debounce and periodic 3-minute polling
- **Sync**: Manually sync favorites and connected keyboard data. Only favorites and the currently connected keyboard are synced (not all keyboards)

#### Sync Status

- Displays current sync progress with the sync unit name and an item counter (current / total)
- Shows error or partial-sync details if any units failed

#### Undecryptable Files

- Files that cannot be decrypted with the current password or are otherwise unreadable (e.g., encrypted with a forgotten previous password)
- Click **Scan** to detect undecryptable files, select the ones to remove, then click **Delete Selected** to permanently delete them from Google Drive

#### Sync Unavailable Alert

- Displayed when the sync backend cannot be reached. Click **Retry** to attempt reconnection

#### Reset Sync Data / Local Data

- **Reset Sync Data**: Select targets (keyboard data, favorite data) and delete them from Google Drive
- **Local Data**: Import/export local data, or reset selected local targets (keyboard data, favorites, app settings)

#### Data Storage

Synced data is stored in [Google Drive appDataFolder](https://developers.google.com/workspace/drive/api/guides/appdata) — a hidden, app-specific folder that only Pipette can access. Your personal Drive files are never touched.

See the [Data Guide](Data.md) for details on what is synced and how your data is protected.

---

## 7. Pipette Hub

[Pipette Hub](https://pipette-hub-worker.keymaps.workers.dev/) is a community keymap gallery where you can upload and share your keyboard configurations.

### 7.1 Hub Setup

Hub features require Google account authentication. Please complete Google account authentication first. Configure Hub in the **Settings** modal (gear icon on the device selection screen):

1. In the **Data** tab, click **Connect** under the Google Account section to sign in with your Google account
2. Scroll down to the **Pipette Hub** section in the same Data tab — it should show **Connected**
3. Set your **Display Name** — this name is shown on your Hub posts
4. Your uploaded keymaps appear in the **My Posts** list

### 7.2 Uploading a Keymap

To upload a keymap to Hub:

1. Connect to your keyboard and open the editor settings (gear icon in the keymap editor)
2. Switch to the **Data** tab
3. Save the current state with a label (e.g., "Default")

![Upload Button](screenshots/hub-03-upload-button.png)

4. Click the **Upload** button on the saved snapshot entry
5. After uploading, the entry shows **Uploaded** status with **Open in Browser**, **Update**, and **Remove** buttons

![Uploaded](screenshots/hub-04-uploaded.png)

- **Open in Browser**: Opens the Hub page for this keymap
- **Update**: Re-uploads the current keyboard state to update the existing Hub post
- **Remove**: Removes the keymap from Hub

### 7.3 Hub Website

The [Pipette Hub website](https://pipette-hub-worker.keymaps.workers.dev/) displays uploaded keymaps in a gallery format.

![Hub Top Page](screenshots/hub-web-top.png)

- Browse uploaded keymaps from the community
- Search by keyboard name
- Download keymaps as `.vil`, `.c`, `.pdf`, or `.pippette` files

#### Individual Keymap Page

Clicking a keymap card opens the detail page with a full keyboard layout visualization.

![Hub Detail Page](screenshots/hub-web-detail.png)

- View all layers (Layer 0–3) of the uploaded keymap
- Review Tap Dance, Macro, Combo, Alt Repeat Key, and Key Override configurations
- **Copy URL** or **Share on X** to share with others
- Download in various formats (`.pdf`, `.c`, `.vil`, `.pippette`)

See the [Data Guide](Data.md) for details on how Hub authentication works.

---

## 8. Status Bar

The status bar at the bottom of the screen shows connection information and action buttons.

![Status Bar](screenshots/30-status-bar.png)

- **Device name**: Shows the name of the connected keyboard
- **Loaded label**: The label of the loaded snapshot (shown only when a snapshot is loaded)
- **Auto Advance**: Status of automatic key advancement after assigning a keycode (shown only when enabled)
- **Key Tester**: Matrix Tester mode status (shown only when enabled and Typing Test is not active)
- **Typing Test**: Typing Test mode status (shown only when enabled)
- **Locked / Unlocked**: Keyboard lock status (prevents accidental changes to dangerous keycodes)
- **Sync status**: Cloud sync status (shown only when sync is configured)
- **Hub connection**: Pipette Hub connection status (shown only when Hub is configured)
- **Disconnect button**: Disconnects from the keyboard and returns to the device selection screen
