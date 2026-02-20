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

Click a keyboard name in the list to open the keymap editor.

---

## 2. Keymap Editor

### 2.1 Screen Layout

The keymap editor consists of two main areas: the keyboard layout display and the keycode palette.

![Keymap Editor Overview](screenshots/02-keymap-editor-overview.png)

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

![Layer 0](screenshots/03-layer-0.png)

![Layer 1](screenshots/04-layer-1.png)

![Layer 2](screenshots/05-layer-2.png)

- Click layer number buttons to switch between layers
- Layer 0 is the default layer
- The number of available layers depends on the keyboard configuration

---

## 3. Keycode Palette

Select keycodes from different categories using the tabbed palette at the bottom of the screen.

### 3.1 Basic

Standard character keys, function keys, modifier keys, and navigation keys.

![Basic Tab](screenshots/06-tab-basic.png)

- Character keys (A-Z, 0-9, symbols)
- Function keys (F1-F24)
- Editing keys (Enter, Tab, Backspace, Delete)
- Navigation keys (arrows, Home, End, PageUp/Down)
- Numpad keys

### 3.2 Layers

Keycodes for layer operations.

![Layers Tab](screenshots/07-tab-layers.png)

- **MO(n)**: Momentarily activate layer n while held
- **DF(n)**: Set default layer to n
- **TG(n)**: Toggle layer n
- **LT(n, kc)**: Layer on hold, keycode on tap
- **OSL(n)**: Activate layer n for the next keypress only
- **TO(n)**: Switch to layer n

### 3.3 Modifiers

Keycodes for modifier key combinations and tap behavior settings.

![Modifiers Tab](screenshots/08-tab-modifiers.png)

- **One-Shot Modifier (OSM)**: Activate modifier for the next keypress only
- **Mod-Tap**: Modifier on hold, regular key on tap
- **Mod Mask**: Modifier key combinations

### 3.4 Tap-Hold / Tap Dance

Keycodes that assign different actions to tap and hold.

![Tap-Hold / Tap Dance Tab](screenshots/09-tab-tapDance.png)

- Click a Tap Dance entry to open the edit modal
- Configure tap, hold, double-tap, and other actions for each entry

### 3.5 Macro

Macro keycodes.

![Macro Tab](screenshots/10-tab-macro.png)

- Click a macro entry to open the edit modal
- Record sequences of key inputs as macros

### 3.6 Quantum

Keycodes for advanced QMK features.

![Quantum Tab](screenshots/11-tab-quantum.png)

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

![Media Tab](screenshots/12-tab-media.png)

- Mouse buttons, movement, and scrolling
- Media playback controls (play/stop/volume)
- Application launcher keys

### 3.8 Lighting

Keycodes for backlight and RGB lighting controls.

![Lighting Tab](screenshots/13-tab-backlight.png)

- RGB Matrix controls
- RGB Lighting controls
- Backlight controls
- LED Matrix controls

### 3.9 User

User-defined keycodes.

![User Tab](screenshots/14-tab-user.png)

- Custom keycodes defined in firmware

> **Note**: The MIDI tab is only displayed for MIDI-capable keyboards.

---

## 4. Toolbar

The toolbar on the left side of the keymap editor provides the following features.

![Toolbar](screenshots/15-toolbar.png)

### 4.1 Dual Mode (Split Edit)

Displays two keyboard layouts side by side for comparing and copying keys between layers.

![Dual Mode](screenshots/16-dual-mode.png)

- Click the button to toggle dual mode
- Useful for copying key settings between layers

### 4.2 Zoom

Adjusts the keyboard layout display scale.

![Zoom In](screenshots/17-zoom-in.png)

- (+) button to zoom in
- (-) button to zoom out
- Can also be adjusted in editor settings

### 4.3 Typing Test

A typing practice feature. Test your typing with the current keymap.

![Typing Test](screenshots/18-typing-test.png)

- Measures WPM (Words Per Minute) and accuracy
- Toggle punctuation and numbers on/off
- View test result history

---

## 5. Detail Setting Editors

Open detail setting modals from the settings buttons at the bottom of each keycode palette tab.

### 5.1 Lighting Settings

Open from the Lighting tab settings button. Configure RGB lighting colors and effects.

![Lighting Settings](screenshots/19-lighting-modal.png)

- Select colors with the HSV color picker
- Choose colors from preset palette
- Adjust effects and speed
- Click Save to apply

### 5.2 Combo

Open from the Quantum tab combo settings button. Configure simultaneous key press combinations to trigger different keys.

![Combo List](screenshots/20-combo-modal.png)

![Combo Detail](screenshots/21-combo-detail.png)

- Select combo entries from the grid tiles
- Configure trigger key combinations and output keys
- Adjust timeout values

### 5.3 Key Override

Open from the Quantum tab key override settings button. Replace specific key inputs with different keys.

![Key Override List](screenshots/22-key-override-modal.png)

![Key Override Detail](screenshots/23-key-override-detail.png)

- Configure trigger and replacement keys
- Specify layer and modifier conditions
- Enable/disable individual entries

### 5.4 Alt Repeat Key

Open from the Quantum tab Alt Repeat Key settings button. Configure alternative actions for the Repeat Key.

![Alt Repeat Key List](screenshots/24-alt-repeat-key-modal.png)

![Alt Repeat Key Detail](screenshots/25-alt-repeat-key-detail.png)

- Set alternative keys based on the last key pressed
- Specify allowed modifiers
- Enable/disable individual entries

### 5.5 Favorites

Each editor modal (Tap Dance, Macro, Combo, Key Override, Alt Repeat Key) includes a **Fav** button for saving and loading individual entry configurations.

![Fav Button](screenshots/30-fav-button.png)

- Click the **Fav** button (yellow) to open the Favorites modal
- **Save Current State**: Enter a label and click Save to store the current entry configuration
- **Synced Data**: Previously saved entries are listed with Load, Rename, and Delete actions

![Favorites Modal](screenshots/31-fav-modal.png)

- **Load**: Apply a saved configuration to the current entry
- **Rename**: Change the label of a saved entry
- **Delete**: Remove a saved entry

> **Note**: Favorites are not tied to a specific keyboard — saved entries can be loaded on any compatible keyboard. When Cloud Sync is enabled, favorites are also synced across devices (see §6.4).

---

## 6. Editor Settings Panel

Open the editor settings panel from the settings button (gear icon) in the keymap editor.

### 6.1 Layer Settings (Layers Tab)

![Layer Settings](screenshots/26-editor-settings-layers.png)

- Layer list with visibility toggle for each layer
- Keyboard layout selection
- Zoom level adjustment
- Auto Advance toggle
- Matrix Tester toggle
- Keyboard lock settings

### 6.2 Tool Settings (Tools Tab)

![Tool Settings](screenshots/27-editor-settings-tools.png)

- QMK Settings configuration (supported keyboards only)
- Other tool settings

### 6.3 Data Management (Data Tab)

![Data Management](screenshots/28-editor-settings-data.png)

- **Import**: Restore from `.vil` files or sideload custom JSON definitions
- **Export Current State**: Download keymap as `.vil`, `keymap.c`, or PDF cheat sheet
- **Save Current State**: Save a snapshot of the current keyboard state with a label. Enter a name in the Label field and click Save. If the Label field is left empty, the Save button is disabled. Saved snapshots appear in the Synced Data list below and can be loaded or deleted later
- **Synced Data**: List of saved snapshots. Click to load, rename, or delete entries
- **Reset Keyboard Data**: Reset keyboard to factory defaults (use with caution)

### 6.4 Cloud Sync (Google Drive appDataFolder)

Pipette can sync your saved snapshots, favorites, and per-keyboard settings across multiple devices via Google Drive.

Sync is configured in the **Settings** modal (gear icon on the device selection screen), under the **Data & Sync** tab:

![Data & Sync Tab](screenshots/hub-settings-data-sync.png)

1. **Sign in** with your Google account
2. **Set a sync password** to encrypt your data (required for security)
3. **Auto Sync**: Enable automatic sync, or use **Sync Now** for manual sync

Synced data is stored in [Google Drive appDataFolder](https://developers.google.com/workspace/drive/api/guides/appdata) — a hidden, app-specific folder that only Pipette can access. Your personal Drive files are never touched.

See the [Data Guide](Data.md) for details on what is synced and how your data is protected.

---

## 7. Pipette Hub

[Pipette Hub](https://pipette-hub-worker.keymaps.workers.dev/) is a community keymap gallery where you can upload and share your keyboard configurations.

### 7.1 Hub Setup

Hub features require Google account authentication. Please complete Google account authentication first. Configure Hub in the **Settings** modal (gear icon on the device selection screen):

1. In the **Data & Sync** tab, click **Connect** to sign in with your Google account
2. Switch to the **Hub** tab — it should show **Connected**

![Hub Tab](screenshots/hub-settings-hub-tab.png)

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

![Status Bar](screenshots/29-status-bar.png)

- **Device name**: Shows the name of the connected keyboard
- **Loaded label**: The label of the loaded snapshot (shown only when a snapshot is loaded)
- **Auto Advance**: Status of automatic key advancement after assigning a keycode (shown only when enabled)
- **Key Tester**: Matrix Tester mode status (shown only when enabled and Typing Test is not active)
- **Typing Test**: Typing Test mode status (shown only when enabled)
- **Locked / Unlocked**: Keyboard lock status (prevents accidental changes to dangerous keycodes)
- **Sync status**: Cloud sync status (shown only when sync is configured)
- **Hub connection**: Pipette Hub connection status (shown only when Hub is configured)
- **Disconnect button**: Disconnects from the keyboard and returns to the device selection screen
