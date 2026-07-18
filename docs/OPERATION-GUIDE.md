# Pipette Operation Guide

[日本語版はこちら](OPERATION-GUIDE.ja.md)

This document explains how to use the Pipette desktop application.
Screenshots were taken using the software-emulated GPK60-63R keyboard, displayed as "Virtual Keyboard", unless otherwise noted.

---

## Table of Contents

- [Feature Availability](#feature-availability)
- [1. Device Connection](#1-device-connection)
  - [1.1 Device Selection Screen](#11-device-selection-screen)
  - [1.2 Connecting a Keyboard](#12-connecting-a-keyboard)
  - [1.3 Data](#13-data)
  - [1.4 Analyze](#14-analyze)
- [2. Keymap Editor](#2-keymap-editor)
  - [2.1 Screen Layout](#21-screen-layout)
  - [2.2 Changing Keys](#22-changing-keys)
  - [2.3 Layer Switching](#23-layer-switching)
  - [2.4 Key Popover](#24-key-popover)
  - [2.5 Layout Options](#25-layout-options)
  - [2.6 View Matrix](#26-view-matrix)
- [3. Keycode Palette](#3-keycode-palette)
  - [3.1 Basic](#31-basic)
  - [3.2 Layers](#32-layers)
  - [3.3 Modifiers](#33-modifiers)
  - [3.4 System](#34-system)
  - [3.5 Lighting](#35-lighting)
  - [3.6 Tap-Hold / Tap Dance](#36-tap-hold--tap-dance)
  - [3.7 Macro](#37-macro)
  - [3.8 Combo](#38-combo)
  - [3.9 Key Override](#39-key-override)
  - [3.10 Alt Repeat Key](#310-alt-repeat-key)
  - [3.11 Behavior](#311-behavior)
  - [3.12 User](#312-user)
  - [3.13 Keyboard (Device Picker)](#313-keyboard-device-picker)
  - [3.14 Keycodes Overlay Panel](#314-keycodes-overlay-panel)
- [4. Toolbar](#4-toolbar)
  - [4.1 Zoom](#41-zoom)
  - [4.2 Undo / Redo (Keymap History)](#42-undo--redo-keymap-history)
  - [4.3 Typing Test](#43-typing-test)
- [5. Detail Setting Editors](#5-detail-setting-editors)
  - [5.1 Lighting Settings](#51-lighting-settings)
  - [5.2 Combo](#52-combo)
  - [5.3 Key Override](#53-key-override)
  - [5.4 Alt Repeat Key](#54-alt-repeat-key)
  - [5.5 Favorites](#55-favorites)
  - [5.6 JSON Editor](#56-json-editor)
- [6. Editor Settings Panel](#6-editor-settings-panel)
  - [6.1 Cloud Sync (Google Drive appDataFolder)](#61-cloud-sync-google-drive-appdatafolder)
  - [6.2 Key Labels Manage](#62-key-labels-manage)
  - [6.3 Language Packs Manage](#63-language-packs-manage)
  - [6.4 Theme Packs Manage](#64-theme-packs-manage)
  - [6.5 Zoom (UI Scale)](#65-zoom-ui-scale)
  - [6.6 Launch at Login / Stay in System Tray](#66-launch-at-login--stay-in-system-tray)
- [7. Pipette Hub](#7-pipette-hub)
  - [7.1 Hub Setup](#71-hub-setup)
  - [7.2 Uploading a Keymap](#72-uploading-a-keymap)
  - [7.3 Uploading Favorite Entries](#73-uploading-favorite-entries)
  - [7.4 Uploading Analytics](#74-uploading-analytics)
  - [7.5 Hub Website](#75-hub-website)
- [8. Modal Interactions](#8-modal-interactions)
  - [Escape to Close](#escape-to-close)
  - [Unlock Dialog Protection](#unlock-dialog-protection)
  - [Escape Suppression During Busy Flows](#escape-suppression-during-busy-flows)
- [9. Status Bar](#9-status-bar)

---

## Feature Availability

What you can do depends on whether you connect a Google account. Editing and most local features work with no integration at all; signing in unlocks cross-device Cloud Sync, and connecting Pipette Hub additionally lets you share to the community.

| Feature | No Integration | Google Account Integration |
|---|:---:|:---:|
| Keymap / macro / tap-dance / combo / key-override / alt-repeat editing | ✅ | ✅ |
| RGB lighting · QMK settings · Matrix tester | ✅ | ✅ |
| Snapshots & Favorites (local save / load) | ✅ | ✅ |
| Import / Export (`.vil` · `.pipette` · `keymap.c` · PDF) | ✅ | ✅ |
| Offline editing (`.pipette` without a keyboard) | ✅ | ✅ |
| Typing Test & Typing View | ✅ | ✅ |
| Analyze — typing analytics (heatmaps · ergonomics · bigrams · layout comparison · per-app) | ✅ | ✅ |
| Download community language / theme / key-label packs from Hub | ✅ | ✅ |
| Cloud Sync — snapshots / favorites / settings across devices | ❌ | ✅ |
| Download remote-only keyboards on demand | ❌ | ✅ |
| Sync typing analytics across devices | ❌ | ✅ |
| Share keymaps to Hub | ❌ | ✅ (Hub) |
| Share favorites (tap dance · macro · combo · …) to Hub | ❌ | ✅ (Hub) |
| Share typing analytics to Hub | ❌ | ✅ (Hub) |
| Publish your own language / theme / key-label packs | ❌ | ✅ (Hub) |

> **Pipette Hub requires a connected Google account.** Rows marked **(Hub)** need Hub connected (set a Display Name in Settings → Data) in addition to Google sign-in. Cloud Sync also needs a sync encryption password. **Downloading community packs from Hub needs no sign-in at all.**

---

## 1. Device Connection

### 1.1 Device Selection Screen

When you launch the app, a list of connected Vial-compatible keyboards is displayed.

![Device Selection Screen](screenshots/01-device-selection.png)

- USB-connected keyboards are automatically detected
- If multiple keyboards are connected, select one from the list
- On Linux, udev rules may need to be configured if no devices are found

**File Tab**

![File Tab](screenshots/file-tab.png)

The File tab allows offline editing of `.pipette` files without a physical keyboard connected:

- Browse previously saved keyboards and select an entry to load
- Load an external `.pipette` file from disk
- A virtual keyboard is created from the embedded definition in the file
- An unsaved changes indicator is shown when edits have not been saved

> **Use case:** You want to tweak your keyboard's keymap, but the keyboard isn't with you right now. If you've previously saved its data, you can load it from the File tab, make your edits offline, and later connect the keyboard and load the modified data to apply your changes.

> **Tip — Save a shared file under your own name:** Load a community or shared `.pipette` file (for example, one downloaded from Pipette Hub or sent by a friend), then open the Save panel (§3.14) and use **Save Current State** to store it under a name of your choice. It joins your saved keyboards and becomes selectable as a **File** source in the Keyboard tab (§3.13) — even for hardware you don't own.

**Feature Availability: Device vs File Mode**

| Feature | Device (USB) | File (.pipette) |
|---------|:------------:|:---------------:|
| Keymap editing | Yes | Yes |
| Macro / Tap Dance editing | Yes | Yes |
| Combo / Key Override / Alt Repeat Key | Yes | Yes |
| QMK Settings | Yes (device) | Yes (local data) |
| Typing Test | Yes | Yes |
| Export (.vil / .c / .pdf) | Yes | Yes |
| Lighting control | Yes | No |
| Matrix Tester | Yes | No |
| Lock / Unlock | Yes | No |
| Snapshot save / load | Yes | Yes |
| Hub upload | Yes | Yes |
| JSON sideload | Yes | No |
| Device probe (Keyboard tab) | Yes | No |
| Cloud Sync | Yes | No |

### 1.2 Connecting a Keyboard

Click a keyboard name in the list to open the keymap editor. A connecting overlay shows loading progress while the keyboard data is read.

If Cloud Sync is configured, sync progress is also displayed during connection (favorites first, then keyboard-specific data).

### 1.3 Data

The Data button on the device selection screen opens the Data panel for centralized management of keyboards, favorites, sync data, and Hub posts.

![Data — Favorites](screenshots/data-sidebar-favorites.png)

The left sidebar provides a **tree navigation** with the following structure:

- **Local**
  - **Keyboards**: Browse saved keyboard snapshots. Click a keyboard to view, load, export, or delete entries
  - **Typing**: Recorded typing-analytics data per keyboard — a per-day list (date, keystrokes, active time) with day selection for deleting, plus export / import of the recorded days
  - **Favorites**: Tap Dance, Macro, Combo, Key Override, Alt Repeat Key — each type shows its saved entries with rename, delete, export, and Hub actions
  - **Application**: Import/export local data or reset selected targets (keyboard data, favorites, app settings)
- **Sync** (when Cloud Sync is configured): Lists keyboards that exist only in Google Drive (not yet downloaded on this device). Each entry is labeled with the keyboard's real name, resolved from the synced name index rather than from the raw UID. Click a remote-only keyboard to download it on demand — a spinner is shown while fetching, and a failure message appears inline if the download cannot complete. Once downloaded, the keyboard moves into the **Local › Keyboards** branch. To clean up orphaned encrypted files that can no longer be decrypted, use **Undecryptable Files** in the Settings **Data** tab instead (see §6.1)
- **Hub** (when Hub is connected): Manage Hub posts grouped by keyboard name

Keyboards are shown by display name everywhere in this panel: on connect, a keyboard that has no saved name yet is automatically named from its USB product name, so even keyboards that never saved anything show a real name instead of a raw uid — including in the **Sync** list. Every keyboard list is sorted A–Z by display name (case-insensitive).

![Data — Keyboard Saves](screenshots/data-sidebar-keyboard-saves.png)

![Data — Application](screenshots/data-sidebar-application.png)

Per-entry actions in the favorites list:
- Click to rename, delete, or **Export** individual entries
- **Hub actions**: When Hub is connected, each entry shows **Upload to Hub** / **Update on Hub** / **Remove from Hub** buttons. Uploading opens a Public / Private confirmation dialog (§7.2)
- **Import** / **Export All** buttons at the footer for bulk operations

A **breadcrumb navigation** at the top of the content area shows the current path (e.g., "Local › Favorites › Tap Dance")

### 1.4 Analyze

The Analyze page shows how you actually type — per-key heatmaps, WPM trends, inter-keystroke intervals, hour-by-day activity, per-finger load, key-pair (bigram) timing, and per-layer usage. Data comes from two sources feeding the same stream: typing tests run in the editor are always recorded (each keystroke tagged with the test material and run), while ambient typing is recorded only while you are in Typing View (the compact window opened from the status bar) with the REC toggle set to Start — the REC toggle gates the Typing View stream only, not typing tests.

**Access**

There are two entry points:

- **Analyze tab** on the device selection screen — open the page without connecting a keyboard. Useful for reviewing data from keyboards that are currently unplugged
- **View Analytics** button in the Typing Test pane — jumps to Analyze for the keyboard you are currently using, then returns to the typing view when you go back

**Keyboard selector**

The **Keyboard** row inside the filter conditions modal (see **Filter conditions modal** below) lists every keyboard that has recorded typing data — pick one to populate the charts. Keyboards with no data never appear in the list. Switching keyboards there resets the Device / Source / Keymap / Period rows below it to that keyboard's own defaults, since a device or app picked for the previous keyboard may not even apply to the new one. The Back button at the bottom of the page returns to the previous view (e.g. the device selector).

**Analysis tabs**

The tab bar above the chart groups ten analyses by intent — overview, performance, behavior, load, and optimization:

| Group | Tab | What it shows |
|-------|-----|---------------|
| Overview | **Summary** | Today / last-7-days deltas, typing profile cards (Speed / Hand balance / SFB / Fatigue), goal streak record |
| Performance | **WPM** | Words-per-minute over time, or by hour of day |
| Performance | **Interval** | Keystroke interval percentiles (min / p25 / median / p75 / max), as a time series or a distribution |
| Behavior | **Activity** | Hour × day-of-week grid or sliding-month calendar, colored by keystrokes / WPM / sessions |
| Behavior | **By App** | Active-application breakdown — App Usage Distribution donut and WPM by App horizontal bars. Requires Monitor App data |
| Load | **Heatmap** | Press count per physical key, overlaid on the keymap (per layer). Requires a keymap snapshot in range |
| Load | **Ergonomics** | Per-finger keystroke totals, with a manual finger-assignment editor and a Learning curve view. Requires a snapshot |
| Load | **Bigrams** | Top key-pair/triple counts, pair-interval ranking with SD, and per-finger IKI bar chart (2/3-gram toggle) |
| Load | **Layer** | Per-layer keystroke counts or layer-op activations |
| Optimization | **Layout Comparison** | Simulate how your recorded typing would land on alternative layouts (Colemak / Dvorak / etc.). Requires a snapshot |

The Heatmap, Ergonomics, Bigrams > Finger IKI, Layout Comparison, and Layer > Activations views need a keymap snapshot that overlaps the selected range. Pipette saves a snapshot automatically when typing recording is enabled on the keyboard; the empty state tells you when to start a recording session to capture one.

**Filter summary chip**

The filter row is a single collapsed chip — `keyboard · device · source · period`. Each segment truncates a long value with an ellipsis; hover the chip to see the full text. Click the chip to open the filter conditions modal — every common condition, including the keymap snapshot, is edited there (the modal's **Keymap** row is the only place to change snapshots).

**Filter conditions modal**

The modal edits a draft copy of the filters — nothing on the page changes until you press **Save**. **Reset** returns the Device and Source rows (and the App/TypingTest toggle) to their defaults — the Keyboard, Keymap, and Period rows keep their current draft values. Pressing Esc, the close button, or clicking outside the modal discards the whole draft instead. Rows, top to bottom:

- **Keyboard** — see **Keyboard selector** above
- **Device** — multi-select. Pick any combination of `This device` and remote-machine hashes to merge or isolate per-machine data. Replaced with an explanatory note when the Interval tab's View is set to Distribution (distribution bins are always computed from this device alone)
- **Source** — a segmented **App / TypingTest** toggle switches this row between two mutually exclusive dimensions (a typing test always runs inside some app, so only one dimension filters at a time). Replaced with an explanatory note on the **By App** tab, whose charts aggregate across every source regardless of the App or TypingTest selection:
  - **App** — multi-select dropdown listing every active application name observed during the range. Defaults to **All apps** (no filter); selecting one or more apps narrows every chart to minutes tagged with one of the chosen apps. The dropdown only populates after Monitor App has been enabled and at least one minute has been tagged with an app name. Persisted per keyboard
  - **TypingTest** — multi-select dropdown listing the typing tests that produced data in the selected range and device scope. File Import tests are listed by their text name; MonkeyType tests as "mode (language)". Picking one or more tests narrows every chart to those runs, and a second **Results** select appears beside it to drill down to individual runs
  - Typing-test names and other long option labels are ellipsized in both selects (and in the chip); hover to see the full text
- **Keymap** — the snapshot timeline, shown only when the selected keyboard has recorded snapshots. Editing Period below stays inside the chosen snapshot's active window so charts that need a snapshot (Heatmap / Ergonomics / Bigrams Finger IKI / Layer activations) never mix two layouts in one view
- **Period** — the **From** / **To** range to analyze, clamped to the active snapshot's window (or to the most recent 7 days when the keyboard has no snapshot recorded yet)

Individual tabs still add their own filters above the chart (view mode, granularity, unit, etc.), outside the modal; those are described per tab in the sections below. The Heatmap tab keeps its **Normalize** / **Aggregate** / **Group** / **Top N** controls with the ranking row underneath the keyboard itself.

**Saved search conditions**

The bookmark icon in the panel header opens the **Saved search conditions** side panel. Save the active filters under a label, restore a saved set later, rename / delete entries, or export the current condition's chart data as CSV. Each saved entry shows a one-line summary of the filters (device, app, snapshot, range) under its label; the entry itself captures the full filter state — including the App / TypingTest dimension and its test / run selections — and restores all of it on Load.

- Up to **50 entries per keyboard** — the panel surfaces a cap warning when you reach the limit; delete an existing entry to make room
- Synced via Cloud Sync (when enabled) so the same set is available on other signed-in machines
- Loading an entry written by a newer Pipette release shows an unsupported-version error rather than guessing at unknown fields
- **Overwrite**: typing a label that already exists swaps the Save button to a danger-styled **Overwrite?** + Cancel pair. Editing the label clears the pending confirmation so you cannot overwrite a different entry by accident
- **Load behavior**: loading a saved entry always opens on the **Summary** tab regardless of which tab was active when the condition was saved
- **Hub actions**: when Pipette Hub is connected, each saved entry shows an additional Hub row with **Upload to Hub** / **Update on Hub** / **Remove from Hub** + **Open in Browser**. The row is labelled **Hub (Public)** or **Hub (Private)**, and uploading opens the Public / Private confirmation dialog — the same pattern as the keymap and favorites save panels (see §7.2, §7.4)

#### Summary

The Summary tab is the default landing view. It collects four read-only cards built from the same minute-bucket aggregates as the rest of the page, so you can scan the latest highs / averages / streaks before drilling into a specific tab.

![Analyze — Summary](screenshots/analyze-summary.png)

- **Today** — Keystrokes, WPM, Typing duration for the current local day
- **Last 7 days** — Keystrokes, WPM, Typing duration, Active days, each with a delta arrow comparing the prior 7 days. Insufficient prior data renders as `—`
- **Typing profile (last N days)** — Four qualitative read-outs computed over the recent window:
  - **Speed** — overall WPM bucketed into Slow (<30) / Medium (30–50) / Fast (≥50)
  - **Hand balance** — share of bigram keystrokes per hand. Within ±5% of 50/50 reads as Balanced
  - **SFB rate** — share of bigrams typed with the same finger. <4% Low / 4–8% Medium / ≥8% High
  - **Fatigue risk** — drop from peak hour to slowest hour WPM. Wider gap = higher risk
- **Goal streak record** — Current cycle progress (`current / goalDays`), longest historical streak, and editable Goal settings (consecutive days × keystrokes/day). Changing the goal clears the current cycle counter. The **Achievement history** button opens a modal that lists every completed cycle with period, goal, days, total keystrokes, and average per day

The Summary tab respects the App filter — selecting one or more apps narrows every card to minutes tagged with those apps.

#### Heatmap

The Heatmap tab paints per-physical-key data on the keymap layout, one layer at a time. A **Count / Speed** toggle above the keymap panel switches what's painted; Layer and Period filters apply to both modes.

**Count mode**

The default mode counts every press per physical key. It's useful for spotting over- or under-used keys per layer and for tuning the layout.

Keys are tinted by press count (dim = low, saturated accent = high). When a keyboard has more than one layer, a layer toggle bar appears above the panel (**Layer 0**, **Layer 1**, …) and each button shows the per-layer count. Hovering a key opens a tooltip inside the chart with the bound keycode and the count; the tooltip never spills outside the heatmap frame.

Below the heatmap is a ranking table. Four filters control what it shows:

- **Normalize** — `Absolute` (raw count), `Per hour` (count ÷ active hours), `Share of total` (% of total presses in range)
- **Aggregate** — `By cell` collapses every press of the same physical cell; `By character` collapses every press of the same keycode regardless of where on the keymap it sits
- **Group** — `All`, `Character`, `Modifier`, `Layer op`
- **Top N** — 10 / 20 / 30 / … / 100

Columns are **Key**, **Layer** (only when the group spans multiple layers), **Matrix**, **Count**.

![Analyze — Heatmap](screenshots/analyze-heatmap.png)

**Speed mode**

Speed recolours the same keyboard by how slow the average reach into each key is, built from the same bigram data as the Bigrams tab: each key is tinted by the average interval (avg IKI) between the previous keystroke and a press landing on that key — cool (blue) keys are reached quickly, warm (red) keys are reached slowly. Keys reached fewer than 5 times in range stay uncoloured; a caption under the ranking table repeats that threshold. On very large ranges the same 5,000-pair fetch cap as the Bigrams tab applies — a caveat appears next to the threshold caption when the averages are computed from the most frequent pairs only.

The **Normalize** and **Aggregate** controls disappear in Speed mode (both are count-specific); **Group** and **Top N** still apply. The ranking table's columns switch to **Key**, **Avg IKI**, **Count**, sorted slowest-reach-first.

![Analyze — Heatmap (speed)](screenshots/analyze-heatmap-speed.png)

**Empty states**

- **No snapshot** — "No keymap snapshot recorded for this range. Start a record session to capture one."
- **No layout** — "Layout data not available for this snapshot." The snapshot exists but lacks KLE geometry
- **No activity** — "No key presses in this range." Ranking table only (Count mode)
- **No reach-speed data** — "No reach-speed data in this range yet." Ranking table only (Speed mode)

#### WPM

The WPM tab charts Words Per Minute — keystrokes per minute divided by 5 — either as a time series or binned by hour of day.

**View Mode**

- **Time series** — WPM over the selected range as a line chart. A red dashed **Bksp %** line is always overlaid on a secondary right-hand axis (0–100 %) so speed and error rate sit together; click the Bksp legend entry to hide it if you only want the WPM line

  ![Analyze — WPM Time Series](screenshots/analyze-wpm-time-series.png)

- **Time of day** — Bar chart of the 24 hours in the local day. Each bar is the average WPM for that hour across the range. Bars that did not meet **Min sample** render in a muted tone

  ![Analyze — WPM Time of Day](screenshots/analyze-wpm-time-of-day.png)

**Min sample** (both views)

`30s`, `1 min`, `2 min`, `5 min`. Minutes with fewer keystrokes than the chosen WPM-worth-of-keys threshold are dropped from the chart so very light sessions don't skew the line.

**Granularity** (Time series only)

Bucket width of the time series (`Auto`, `1 min`, `5 min`, … `1 week`, `1 month`).

**Summary cards**

- **Time series** — Total keystrokes, Active typing time, Overall WPM, Peak WPM, Lowest WPM, Weighted median WPM, Peak K/min, Peak K/day, Total Bksp, Overall Bksp %
- **Time of day** — Total keystrokes, Active typing time, Overall WPM, Peak hour, Slowest hour, Active hours (N / 24)

#### Interval

The Interval tab visualizes the time between consecutive keystrokes, either as percentile lines over time or as a distribution histogram.

**View Mode**

- **Time series** — Five percentile lines on a log-scale Y axis: **Min**, **p25**, **Median**, **p75**, **Max**. The Median line is drawn thickest. Click a legend entry to hide a line. The Y-axis label reads `sec (log)` or `ms (log)` depending on Display

  ![Analyze — Interval Time Series](screenshots/analyze-interval-time-series.png)

- **Distribution** — Bar chart of nine fixed bins (`<50ms`, `50-100ms`, `100-200ms`, `200-500ms`, `500ms-1s`, `1-2s`, `2-5s`, `5-10s`, `>10s`). Bars are colored by band: **Fast** (green, <200ms), **Normal** (blue, 200–500ms), **Slow** (orange, 500ms–2s), **Pause** (red, ≥2s). The **Device** filter is hidden in Distribution mode because bins are always computed from this device alone

  ![Analyze — Interval Distribution](screenshots/analyze-interval-distribution.png)

**Display** (both views)

`Seconds` / `Milliseconds`. Switches the unit used in tooltips and on the Y axis. The distribution bin labels stay in their native unit.

**Granularity** (Time series only)

Same options as WPM.

**Summary cards**

- **Time series** — Total keystrokes, Active typing time, Weighted median interval, Shortest interval (per min), Longest interval (per min)
- **Distribution** — Total keystrokes, Median interval, Fast (<200ms) share, Normal (200–500ms) share, Slow (500ms–2s) share, Pause (≥2s) share, Longest interval (per min), Longest session

#### Activity

The Activity tab groups typing by day-of-week × hour so you can see when you actually type. The filter row offers two orthogonal pickers: **View** (chart geometry) and **Metric** (what each cell measures).

**View**

- **Hour** — the historical 24 × 7 hour-of-day × day-of-week grid (or sessions histogram when Metric = Sessions). Driven by the top-level Period picker
- **Day** — sliding-window day calendar. Adds a **Range** selector (1 / 3 / 6 / 12 months) plus prev / next month cursor buttons so you can browse the month-by-month heatmap. For 3 / 6 / 12-month ranges the current month stops at today so future days stay blank; the 1-month range shows the full calendar month including future empty days

**Metric**

- **Keystrokes** — keystroke count. Empty cells are dim, the busiest cell is fully saturated. In Grid view a non-empty cell tooltip shows both the raw count and its share of the range total (e.g. `Mon 09:00 — 1,234 keys (5.2% of total)`)

  ![Analyze — Activity Keystrokes](screenshots/analyze-activity-keystrokes.png)

- **WPM** — average WPM per cell. In Grid view, cells that don't meet **Min sample** are desaturated instead of pinning the color scale
- **Sessions** — In Grid view this swaps to a histogram of session lengths in seven bins (`<5 min`, `5-15 min`, `15-30 min`, `30-60 min`, `1-2 h`, `2-4 h`, `>4 h`); in Calendar view each cell counts the **sessions whose start fell on that date** (not sessions active on that date)

**Day-only controls** (View = Day)

- **Normalize** — `Absolute` colors by the peak day in the rendered window, `Share of week` divides each cell by the column's weekly total, `Share of total` divides by the grand total of the rendered range
- **Range** — `1 month`, `3 months`, `6 months`, `12 months`. Sets the visible window relative to the cursor month
- **Prev / Next month buttons** — slide the visible window one month earlier or later. The current month is the right-most column; future days stay blank (except in the 1-month view which shows the full month)

  ![Analyze — Activity Calendar](screenshots/analyze-activity-calendar.png)

A gradient legend bar below the calendar shows the color scale from low to peak value, so the intensity mapping is always visible at a glance.

Clicking a populated cell jumps the rest of the Analyze pane to that single day. The snapshot picker auto-selects the snapshot that contains the date so dependent tabs (Heatmap, Ergonomics, Layer activations) stay aligned with the keymap that was active.

**Min sample** (View = Grid, Metric = WPM)

Same options as the WPM tab.

**Peak records**

Four stat cards above the grid summarize the peaks across the selected range: Peak WPM, Peak K/min, Peak K/day, Longest session (min). They stay visible for every metric so you always see the overall highs at a glance.

**Summary cards**

Under the grid, the summary depends on the metric:

- **Keystrokes** — Total keystrokes, Active typing time, Busiest day, Busiest hour, Peak cell, Active cells (N / 168). The count context under each card also carries its share of the range total (e.g. `800 keys (40.0%)`)
- **WPM** — Total keystrokes, Active typing time, Overall WPM, Peak cell, Slowest cell, Active cells (N / 168)
- **Sessions** — Session count, Total duration, Mean duration, Median duration, Longest session, Shortest session

#### Ergonomics

The Ergonomics tab reports the physical load of your typing — per finger, per hand, per row — based on the key → finger assignment in the snapshot keymap.

Like Heatmap, this view needs a keymap snapshot that overlaps the range.

**Sections**

Three bar charts stack vertically:

1. **Finger Load** — 10 vertical bars, one per finger from left pinky to right pinky
2. **Hand Balance** — 2 horizontal bars (Left / Right)
3. **Row Usage** — 6 horizontal bars (Function / Number / Top / Home / Bottom / Thumb)

![Analyze — Ergonomics](screenshots/analyze-ergonomics.png)

**Finger assignment**

Each key is auto-assigned to a finger based on the layout's KLE metadata (column position and the standard column-to-finger mapping). The **Finger assignment** button sits right-aligned in the tab's filter row on every finger-based tab — Summary, Ergonomics, Bigrams, and Layout Comparison — and shows whenever a keymap snapshot is available. Click it to override any key manually:

![Analyze — Finger Assignment](screenshots/analyze-finger-assignment-modal.png)

- Each key shows a short finger code (`Lp`, `Lr`, `Lm`, `Li`, `Lt` / `Rt`, `Ri`, `Rm`, `Rr`, `Rp`). Manually overridden keys are prefixed with `*`
- Click a key → popover to pick a finger
- **Save** persists the overrides; **Reset all** clears every override (disabled when there are none). **Reset to estimate** in the per-key popover clears just that key
- Overrides apply immediately once you close the modal. On this tab, Finger Load, Hand Balance, and Row Load (its per-hand split derives from the overridden finger) all recompute right away — only Row Usage stays unchanged, since row categories themselves are never overridden. The same overrides also feed the Summary tab's typing-profile cards, the Bigrams tab's finger classification, and Layout Comparison's simulations

**Learning curve**

Set the **View** filter to **Learning curve** to swap the four-pane snapshot for a weekly / monthly trend chart. The view buckets per-day matrix counts into the chosen **Period** (week / month) and folds each bucket into three sub-scores plus a composite score:

- **Finger load** — how evenly the 10 fingers share the load (1 = perfectly even, 0 = one-finger lock-in)
- **Hand balance** — how close the left / right split is to 50 / 50
- **Home row stay** — fraction of keystrokes on the home row

The bold line is the composite **Overall** score (weighted mean of the three sub-scores); the dashed lines are the individual sub-scores. The summary cards at the top show the latest bucket's overall score, the delta against the prior buckets, and the qualified bucket count (a bucket is qualified once its keystroke total clears the min-sample threshold; below-threshold buckets stay visible but are flagged in the tooltip).

![Analyze — Ergonomic Learning Curve](screenshots/analyze-ergonomics-learning.png)

> The composite score is a **relative trend indicator**, not a calibrated absolute metric. The weights are heuristic and finger-stddev is sensitive to layout choices. Read the curve as "is my distribution improving over time?" rather than as a numeric grade.

**Empty states**

- **No snapshot** — same message as Heatmap
- **No layout** — "Layout data not available for this snapshot."
- **No activity** — "No keystrokes recorded in this range."
- **No data** (Learning curve only) — "Not enough matrix activity in this range. Type more or widen the period filter."

#### Bigrams

The Bigrams tab analyzes consecutive key-press sequences and the inter-key interval (IKI) between them. A toggle in the top-right corner switches the tab between **2-gram** (key pairs, the default) and **3-gram** (key triples) granularity. Both are aggregated per minute as the typing happens, so the tab works over any selected range without re-scanning raw events.

**Quadrant layout**

At 2-gram the view is a 3-quadrant grid; each quadrant has its own list-size selector (10 / 20 / 30 / … / 100). Bars are rendered with recharts so tooltips track the cursor. At 3-gram the **Finger IKI** quadrant disappears — a finger-pair mapping isn't a defined concept for a 3-key sequence — and **Top pairs** / **Pair interval** expand to fill the freed row instead of leaving an empty cell.

| Quadrant | What it shows |
|----------|---------------|
| **Top pairs** | Ranking by total occurrence count. Click **Count**, **Avg IKI**, or **SD** to re-sort |
| **Pair interval** | Ranking by average IKI (slowest first). Click any of **Count**, **Avg IKI**, **SD**, or **p95** to re-sort. The Avg interval threshold (see Common filters) hides faster-than-threshold rows |
| **Finger IKI** (2-gram only) | Per-(from-finger → to-finger) average IKI bar chart. Bars are coloured blue for left-hand starts and red for right-hand starts. Same Avg interval threshold applies |

At 3-gram, **Avg IKI** is the average of the two intervals inside the triple (key1→key2 and key2→key3) — not the total elapsed time across all three keystrokes. Hover the column header for this reminder.

The **SD** column is the standard deviation of the underlying IKI samples for that pair/triple — low SD means a consistent rhythm, high SD means erratic timing. It reads as "—" per row: a pair/triple shows "—" when it has fewer than 2 samples in the range, or when any of its data in the range was recorded before this column shipped — a true SD needs the raw sum/sum-of-squares that older rows don't carry, and mixing a partial sum in would silently understate the result. Other pairs in the same range keep their SD; pick a range recorded entirely after the update to see values on every row.

![Analyze — Bigrams](screenshots/analyze-bigrams.png)

![Analyze — Bigrams (3-gram)](screenshots/analyze-bigrams-trigram.png)

**Snapshot requirement**

Only the **Finger IKI** quadrant needs a keymap snapshot — it has to map each numeric keycode in the pair to a finger, which depends on the snapshot's keymap and layout. Since Finger IKI only exists at 2-gram, the 3-gram view never needs a snapshot. The Top pairs and Pair interval quadrants both render directly from the recorded counts and work without a snapshot at either gram size.

**Common filters**

- **Range** — same `From` / `To` pickers as the rest of Analyze. The view re-aggregates over the chosen window
- **Device** — `This device` only or all synced devices, identical to the other tabs
- **Avg interval (ms or slower)** — minimum-IKI threshold rendered inline in the Pair interval quadrant header, and also in the Finger IKI quadrant header at 2-gram. Rows whose average IKI is below the threshold are hidden from both of those quadrants at once (the input is shared, so editing it in one quadrant updates the other); Top pairs is never filtered. `0` disables the filter; the value is persisted per keyboard via `PipetteSettings`. The IKI used for comparison is approximate (histogram bucket-center weighted average), so the cut-off is best treated as a coarse "ignore rows faster than ~N ms" filter

**Empty states**

- **No bigram data** — "No bigram data in this range yet. Record some typing and try again." Shown when the range has no recorded activity for the selected gram size
- **No snapshot (Finger IKI quadrant only, 2-gram)** — "Finger interval needs a keymap snapshot. Start a record session or pick a range with one." The other quadrants still render
- **Threshold filtered everything out** — when **Avg interval** is set high enough that no row survives, Pair interval (and Finger IKI at 2-gram) fall back to "No bigram data in this range yet." Lower the threshold to bring rows back
- **Very large ranges** — when the selected range holds more distinct pairs/triples than the single-fetch cap (5,000), Pair interval and Finger IKI show "Computed from the 5000 most frequent pairs — rare pairs may be missing." Top pairs stays exact; narrow the range to bring rare rows back

#### By App

The By App tab breaks the recorded data down by the active application name captured during typing. It only populates after Monitor App has been enabled in the Typing View and at least one minute has been tagged with an app name. This tab intentionally **ignores the App filter** — applying it would collapse the chart to a single slice / bar.

![Analyze — By App](screenshots/analyze-by-app.png)

**App Usage Distribution** (donut)

Per-app share of total keystrokes for the selected range. Minutes tagged with multiple apps fold into an `Unknown / Mixed` slice; minutes that pre-date Monitor App or were captured while it was disabled go to `Other`. Hover for the tooltip with the per-slice keystrokes count and share percentage.

**WPM by App** (horizontal bars)

Per-app median WPM as a horizontal bar chart, ranked by share of activity. Bars below the configured min-sample threshold render in a muted tone. Hover for the per-bar WPM and keystroke count.

**Empty state**

- "No app data — turn on Monitor App and start REC to populate this chart." Shown when no app-tagged minutes exist in the range

#### Layout Comparison

The Layout Comparison simulates how your recorded typing would land on a different keyboard layout — Colemak, Dvorak, Colemak DH, and 30+ others — without touching your firmware. Pick a candidate from the dropdown and the tab folds your matrix activity through that layout's character map to show how your finger / hand / row workload would shift.

**Pickers**

- **Current layout** — what character convention to interpret your recorded events with. Defaults to QWERTY; change it if your firmware fires keycodes for a different layout natively
- **Compare to** — the candidate layout to simulate against. Picks are persisted per keyboard so the comparison reopens to the same target after a reload

**Panels**

Once a target is picked, all three panels render at once so you can read the spatial, per-finger, and tabular views together without flipping a sub-view:

| Panel | What it shows |
|-------|---------------|
| **Heatmap diff** (top, full width) | Per-physical-key delta painted over the keyboard. Red shades where the candidate sends more activity to that key, blue shades where it sends less |
| **Finger diff** (bottom-left) | Per-finger signed delta bar chart. Red bars mark fingers that take more load on the candidate, green bars mark fingers that take less |
| **Metric table** (bottom-right) | Side-by-side share-of-events table with finger load (per finger), hand balance (left / right), row distribution, and home-row stay rate |

Manual finger assignments (see **Finger assignment** under Ergonomics above) are honored here too — the Finger diff and the Metric table's finger load / hand balance use your overrides instead of the automatic column-based estimate. Row distribution is unaffected, since finger overrides don't change row categories.

![Analyze — Layout Comparison Heatmap Diff](screenshots/analyze-layout-comparison-heatmap-diff.png)

![Analyze — Layout Comparison Finger Diff](screenshots/analyze-layout-comparison-finger-diff.png)

![Analyze — Layout Comparison Metric](screenshots/analyze-layout-comparison-metric.png)

**Skip-rate warning**

Some events can't be mapped onto a candidate — for example, when the source character has no equivalent on the target layout, or the firmware hasn't bound the candidate's keycode anywhere. When that share rises above 5% the view shows a warning so you know the metrics are approximate.

**Empty states**

- **No snapshot** — same empty state as the rest of the snapshot-bound tabs. Start a record session in the chosen range to capture one
- **No target picked** — the empty hint stays until you pick a comparison layout from the dropdown
- **Fetch error** — generic "failed to compute the layout comparison" message; reload or pick a smaller range and retry

#### Layer

The Layer tab breaks usage down by keyboard layer.

**View Mode**

- **Keystrokes** — sums every press at the layer that was active at the time. Reflects `MO`, `LT`, `TG`, and any other layer op live, because the active layer is recorded when the press happens. Works with or without a keymap snapshot

  ![Analyze — Layer Keystrokes](screenshots/analyze-layer-keystrokes.png)

- **Activations** — counts how many times each layer was *reached* through a layer-op keycode. Requires a keymap snapshot so the layer-op target can be resolved:
  - `MO` / `TG` / `TO` / `DF` / `PDF` / `OSL` / `TT` — counted on press
  - `LT` / `LM` — counted only on hold (so a tapped `LT0(KC_ESC)` doesn't look like a layer transition)

  ![Analyze — Layer Activations](screenshots/analyze-layer-activations.png)

**Base Layer**

Appears only in Activations mode on keyboards with two or more layers. Selects the layer you are analyzing from — that layer is dropped from the bar list so a "hold the same layer you're already on" press (e.g., `LT0(KC_ESC)` while base = 0) doesn't show up as a transition.

**Layer names**

If you have named layers in the layer panel (see §2.3), the name is appended to the axis label (e.g., `Layer 0 · Base`) so you can tell layers apart without counting.

**Empty states**

- **Keystrokes, no activity** — nothing pressed in range
- **Activations, no activity** — no layer-op keys pressed in range
- **Activations, no snapshot** — "Layer activations need a keymap snapshot. Start a record session in this range to capture one." Keystrokes mode keeps working without a snapshot

#### Export / Upload

The **Export** button on the panel header opens a category-pick modal that writes the chart data for the active filters as a `.csv` file. Ten categories can be ticked independently:

- **Summary** — today / last-7-days overview cards
- **WPM** — per-bucket WPM time series
- **Interval** — per-bucket interval percentiles
- **Activity** — hour × day-of-week or day-cell counts depending on the View setting
- **By App** — per-application breakdown
- **Heatmap** — per-cell press counts (snapshot-bound)
- **Ergonomics** — per-finger / per-hand / per-row totals (snapshot-bound)
- **Bigrams** — Top pairs / Pair interval rows (Count, Avg IKI, SD); Finger IKI has no CSV column. Exports whichever gram size (2-gram or 3-gram) is currently selected in the tab — the id column is named `bigram_id` or `trigram_id` to match
- **Layer** — per-layer keystroke or activation counts
- **Layout Comparison** — per-finger / row / hand deltas (snapshot-bound; reflects manual finger overrides)

The modal lists the active conditions (Device, App, Keymap, Period) above the category list so the file you save is unambiguous about which slice it captures. Heatmap, Ergonomics, and Layout Comparison entries are unavailable when the range has no overlapping snapshot — the modal shows a "snapshot missing" notice for those categories. Manual finger overrides are noted next to the Ergonomics row.

**Upload mode**

The same modal opens in **upload mode** when triggered from a saved entry's Hub action row (Upload to Hub / Update on Hub). In this mode the confirm button reads **Upload** or **Update** and the data is sent to Pipette Hub instead of written to a CSV file. Upload mode adds two additional selectors:

- **Layout Comparison targets** — a multi-select popover listing all installed key-label sets and built-in layouts. Pick one or more target layouts to include in the Hub post; the Layout Comparison toggle is disabled when no targets are selected
- **Per-app data** — a multi-select popover listing every app observed in the range. Select which apps to include as per-app breakdowns on Hub

See §7.4 for the full analytics upload flow and validation rules.

---

## 2. Keymap Editor

### 2.1 Screen Layout

The keymap editor consists of two main areas: the keyboard layout display and the keycode palette.

![Keymap Editor Overview](screenshots/02-keymap-editor-overview.png)

- Top area: Physical keyboard layout (shows the current keycode assigned to each key)
- Left side: Toolbar (zoom, undo/redo, etc.)
- Bottom area: Keycode palette (tabbed interface) with overlay panel toggle
- Right side (when open): Keycodes Overlay Panel (tools, save, layout options)
- Bottom bar: Status bar

### 2.2 Changing Keys

1. Click a key on the keyboard layout to select it
2. Click a keycode from the keycode palette to assign it
3. The key display updates immediately
4. Changes are automatically sent to the keyboard

- Ctrl+click to select multiple keys
- Shift+click for range selection
- Press Escape to deselect all keys

**Instant Key Selection** controls how keycode assignment behaves:

- **ON** (default): A single click on a keycode immediately assigns it and closes the selection. Fast workflow for quick edits.
- **OFF**: A single click selects a keycode (highlighted), double-click or press Enter to confirm and assign. A hint is shown at the bottom of the palette. Useful when you want to browse keycodes before committing.

This setting can be toggled per-keyboard in the Keycodes Overlay Panel (§3.14), and the global default can be set in Settings → Defaults (§6.1).

### 2.3 Layer Switching

Layer switching buttons are located on the left side of the keyboard layout.

![Layer 0](screenshots/03-layer-0.png)

![Layer 1](screenshots/04-layer-1.png)

![Layer 2](screenshots/05-layer-2.png)

- Click layer number buttons to switch between layers
- Layer 0 is the default layer
- The number of available layers depends on the keyboard configuration

The layer panel can be collapsed to save space:

![Layer Panel Collapsed](screenshots/layer-panel-collapsed.png)

Click the collapse button (chevron) to minimize the layer panel to just numbers. Click the expand button to restore full layer names.

![Layer Panel Expanded](screenshots/layer-panel-expanded.png)

### 2.4 Key Popover

Double-click a key on the keyboard layout to open the Key Popover — a quick way to search and assign keycodes without scrolling through the palette.

**Layer Sidebar**

![Key Popover — Layer Sidebar](screenshots/key-popover-layer-sidebar.png)

A vertical layer sidebar appears on the left side of the popover, matching the layer panel buttons. Click a layer number to switch layers without closing the popover. If the number of layers exceeds the popover height, the sidebar scrolls independently.

**Key Tab**

![Key Popover — Key Tab](screenshots/key-popover-key.png)

- The search input is pre-filled with the current keycode name
- Type to search by name, keycode name, or alias — results are ranked by relevance
- Click a result to assign it immediately
- The popover also appears when double-clicking key fields in detail editors (Tap Dance, Combo, Key Override, etc.)

**Code Tab**

![Key Popover — Code Tab](screenshots/key-popover-code.png)

- Enter a keycode value directly in hexadecimal (e.g., `0x0029` for Escape)
- The resolved keycode name is displayed below the hex input
- Click **Apply** to assign the entered keycode

**Wrapper Modes**

The mode buttons at the top of the popover let you build composite keycodes:

![Key Popover — Modifier Mode](screenshots/key-popover-modifier.png)

- **Mod Mask**: Combine a modifier with a key (e.g., `LSFT(KC_ESCAPE)`)
- **Mod-Tap**: Modifier on hold, key on tap (e.g., `LSFT_T(KC_ESCAPE)`)

Both modes show the modifier checkbox strip to select Left/Right Ctrl, Shift, Alt, or GUI. Left and Right modifiers cannot be mixed — selecting one side disables the other.

![Key Popover — LT Mode](screenshots/key-popover-lt.png)

- **LT**: Layer-Tap — activate a layer on hold, send a key on tap (e.g., `LT0(KC_ESCAPE)`). A layer selector appears to choose the target layer.
- **SH_T**: Swap Hands Tap — swap hands on hold, send a key on tap (e.g., `SH_T(KC_ESCAPE)`)
- **LM**: Layer-Mod — activate a layer with modifiers (e.g., `LM(0, MOD_LSFT)`). Shows both the layer selector and the modifier checkbox strip.

Click an active mode button to toggle it off and revert to a basic keycode.

**Undo / Redo**: The popover footer shows context-sensitive **Undo** and **Redo** buttons. Undo displays the previous keycode and reverts to it; Redo displays the next keycode and re-applies it. These buttons only appear when the most recent undo/redo history entry matches the key currently open in the popover (i.e., the last single change). For multi-step history navigation, use the toolbar buttons or keyboard shortcuts (see §4.2).

![Key Popover — Undo](screenshots/key-popover-undo.png)
![Key Popover — Redo](screenshots/key-popover-redo.png)

**Confirmation**: Press **Enter** to confirm the current selection and close the popover. Press **Escape** or click outside the popover to close it without changes.

### 2.5 Layout Options

Some keyboards support multiple physical layouts (e.g., split backspace, ISO enter, different bottom row configurations). When a keyboard has layout options, a Layout Options button (grid icon) appears at the right end of the keycode palette tab bar.

![Layout Options Panel](screenshots/layout-options-open.png)

- Click the grid icon to open the Layout Options panel
- **Checkbox options**: Toggle a layout variant on or off (e.g., "Macro Pad", "Split Backspace", "ISO Enter")
- **Dropdown options**: Select from multiple layout variants (e.g., "Bottom Section" with Full Grid / Macro Pad / Arrow Keys choices)
- Changes are applied immediately — the keyboard layout display updates in real time to reflect the selected options

![Layout Options Changed](screenshots/layout-options-changed.png)

- Selecting a different option updates the visible keys on the keyboard layout
- Layout options are saved to the keyboard and persist across sessions
- Click outside the panel or press Escape to close it

> **Note**: The Layout Options button only appears for keyboards that define multiple layout variants. Most keyboards with a single fixed layout do not show this button. Screenshots in this section were taken using a dummy JSON definition loaded via "Load from JSON file".

### 2.6 View Matrix

When **Auto Move** is enabled (§3.14), assigning a keycode automatically advances the selection to the next key. Keys are visited in order of their matrix position (sorted by row, then by column) — by default the physical matrix defined by the keyboard, which gives a natural left-to-right, top-to-bottom walk even on keyboards whose definition lists keys in a scrambled order. The View Matrix lets you customize this order per keyboard by assigning each key a custom view position.

To edit the View Matrix, open the Keycodes Overlay Panel (§3.14) and click **Edit** in the **View Matrix** row. While the mode is active:

![View Matrix Mode](screenshots/view-matrix-mode.png)

- The keymap display goes blank — instead of keycodes, each key shows its effective view position as two lines: `R` (row) and `C` (column)
- All keymap operations are disabled: layer switching, key assignment, the key popover, and the Key Tester (turned off automatically on entry). The keycode picker area (tabs, tiles, and menu) is hidden entirely, leaving a two-pane view: the **View Matrix** panel on the left and the keymap on the right (zoom and scrolling keep working)
- The layer panel is replaced by the **View Matrix** panel: the **Done** toggle, **Row** / **Col** selects for the currently selected key(s), and — at the bottom — the **Reset** button. Click Reset and confirm (**Reset?**) to delete all custom positions and return to the physical matrix order
- Click a key to select it — it's highlighted on the keymap, and the **Row** / **Col** selects immediately show its effective position. Both selects offer the same range, `0` up to one less than the larger of the keyboard's matrix row/column counts — view positions are a logical ordering, not a readout of each axis's physical size, so direct-pin keyboards (whose physical matrix collapses to a single row or column) still get a full 2D range on both axes. Changing either select saves instantly; there is no separate Save step. Choosing the value equal to the key's own physical position removes its custom position instead
- Ctrl-click (or Cmd-click on macOS) adds or removes a key from the selection; Shift-click selects a contiguous range. All selected keys stay highlighted. With 2 or more keys selected, the **Row** / **Col** selects show a blank placeholder — picking a value bulk-applies that row (or column) to every selected key in one step, each key keeping its own value on the other axis. A reminder of these Ctrl-click / Shift-click shortcuts is shown below the keymap, just above the relocated zoom controls
- If two or more keys resolve to the same effective view position, those keys are flagged with a shared highlight color on the keymap until the collision is resolved. Editing isn't blocked, but the Auto Move order between those keys becomes ambiguous
- The layer label normally shown below the keymap is hidden while the mode is active — the View Matrix has no layer concept
- Click **Done** in the **View Matrix** panel to exit the mode (it also exits automatically when switching or disconnecting the keyboard)

![View Matrix — Key Selected](screenshots/view-matrix-selected.png)

- Clicking a key highlights it and populates the **Row** / **Col** selects with its effective position

![View Matrix — Duplicate Positions](screenshots/view-matrix-duplicate.png)

- Here two keys resolve to the same view position (`R 0` / `C 1`), so both are flagged with the shared highlight color

![View Matrix on a Direct-Pin Keyboard](screenshots/view-matrix-direct-pin.png)

- On a direct-pin keyboard the physical matrix is a single row or column (here 1×6), yet both axes still span the larger matrix dimension — the **Row** and **Col** selects each offer `0`–`5`

Only keys you change are stored — every other key keeps its physical matrix position in the ordering. Encoders and decorative keys are not part of the Auto Move order and cannot be edited in this mode. The View Matrix is saved per keyboard and included in cloud sync (§6.1).

---

## 3. Keycode Palette

Select keycodes from different categories using the tabbed palette at the bottom of the screen.

### 3.1 Basic

Standard character keys, function keys, modifier keys, and navigation keys. The Basic tab supports four view types, selectable from the view selector at the bottom of the Basic tab:

**ANSI Keyboard View** (default)

![Basic Tab — ANSI View](screenshots/basic-ansi-view.png)

Displays keycodes as an ANSI keyboard layout. Click a key on the visual keyboard to assign it.

**ISO Keyboard View**

![Basic Tab — ISO View](screenshots/basic-iso-view.png)

Displays keycodes as an ISO keyboard layout with the ISO-specific keys.

**JIS Keyboard View**

![Basic Tab — JIS View](screenshots/basic-jis-view.png)

Displays keycodes as a JIS keyboard layout with JIS-specific keys (Yen, Ro, Henkan, Muhenkan, Katakana/Hiragana).

**List View**

![Basic Tab — List View](screenshots/basic-list-view.png)

Displays keycodes in the traditional scrollable list format.

All views include:
- Character keys (A-Z, 0-9, symbols)
- Function keys (F1-F24)
- Editing keys (Enter, Tab, Backspace, Delete)
- Navigation keys (arrows, Home, End, PageUp/Down)
- Numpad keys
- International keys (KC_INT1–KC_INT5)
- Language keys (KC_LANG1–KC_LANG5)

### 3.2 Layers

Keycodes for layer operations.

![Layers Tab](screenshots/tab-layers.png)

- **MO(n)**: Momentarily activate layer n while held
- **DF(n)**: Set default layer to n
- **TG(n)**: Toggle layer n
- **LT(n, kc)**: Layer on hold, keycode on tap
- **OSL(n)**: Activate layer n for the next keypress only
- **TO(n)**: Switch to layer n

### 3.3 Modifiers

Keycodes for modifier key combinations and tap behavior settings.

![Modifiers Tab](screenshots/tab-modifiers.png)

- **One-Shot Modifiers (OSM)**: Activate modifier for the next keypress only
- **One-Shot Control**: Turn the one-shot feature itself on / off / toggle (distinct from OSM, which triggers a one-shot modifier)
- **Mod-Tap**: Modifier on hold, regular key on tap
- **Modifier Masks**: Modifier key combinations

### 3.4 System

Keycodes for mouse control, media playback, system utilities, and audio/haptic feedback.

![System Tab](screenshots/tab-system.png)

- **Mouse**: buttons, movement, and scrolling
- **Joystick**: axis and button keycodes
- **Audio**: audio toggle and control keycodes
- **Haptic**: haptic feedback toggle and control keycodes
- **Media Playback**: play/stop/volume/track controls
- **Locking Keys**: Locking Caps Lock, Num Lock, Scroll Lock
- **App / Browser**: application launcher and browser navigation keys
- **System Control**: system power, sleep, wake
- **Boot**: enter bootloader mode (QK_BOOT)

> **Note**: The MIDI tab is only displayed for MIDI-capable keyboards. When available, it appears between System and Lighting.

### 3.5 Lighting

Keycodes for backlight and RGB lighting controls.

![Lighting Tab](screenshots/tab-lighting.png)

- RGB Matrix controls
- RGB Lighting controls
- Backlight controls
- LED Matrix controls

### 3.6 Tap-Hold / Tap Dance

Keycodes that assign different actions to tap and hold.

![Tap-Hold / Tap Dance Tab](screenshots/tab-tapDance.png)

The Tap Dance section displays a **tile grid preview** showing all entries at a glance:

![Tap Dance Tile Grid](screenshots/td-tile-grid.png)

- Each tile shows the entry number and a summary of configured actions
- Configured entries display their tap/hold actions; unconfigured tiles show the number only
- Click a tile to open the Tap Dance edit modal directly to that entry
- Configure tap, hold, double-tap, and other actions for each entry
- **Edit JSON** button at the bottom opens a JSON editor for bulk editing all entries (see §5.6)

### 3.7 Macro

Macro keycodes.

![Macro Tab](screenshots/tab-macro.png)

The Macro section displays a **tile grid preview** showing all entries at a glance:

![Macro Tile Grid](screenshots/macro-tile-grid.png)

- Each tile shows the macro number and a preview of the recorded sequence
- Configured entries display a summary of key actions; unconfigured tiles show the number only
- Click a tile to open the Macro edit modal directly to that entry
- Record sequences of key inputs as macros
- **Edit JSON** button at the bottom opens a JSON editor for bulk editing all entries (see §5.6)

#### Macro Edit Modal — List Mode and Edit Mode

Opening a macro action brings up the Macro Modal with two display modes that share the same row:

- **List mode** (default): The action's keycodes are shown as clickable tiles followed by a dashed **add slot**. Single-click a keycode tile to switch that index into edit mode. Single-click the dashed add slot to select it; double-click the dashed slot to open the keycode popover with an empty query (mirrors the keymap editor). The pencil "edit" icon from earlier versions is gone — clicking is the only affordance
- **Edit mode**: The keycode picker stays visible below the row. Each keycode tile shows a hover **X** button to delete that index, and the Tap row exposes a **Close** button to leave edit mode. Picker and popover selections are **staged** — they update the row visually but are not committed until you press the bottom **Save** button or **Enter**. The footer also shows a **Revert** ConfirmButton when you are editing an action that already existed (it is hidden when you just added the action via Add Action, since there is nothing prior to revert to). Save and Revert are disabled until a pick actually changes something. Pressing **Escape**, the per-row **Close** button, **Revert**, or clicking outside the picker / action list / footer / key popover rolls back the entire in-flight edit — including newly-appended Add-keycode slots or an entirely newly-added action — and leaves edit mode. Deleting a slot during edit shifts the selection so the session continues rather than exiting.

Empty keycode actions are tolerated while editing; they are normalized out silently when the macro is saved or exported to a favorite.

#### Recording Lock

While the built-in recorder is capturing keystrokes, the Macro Modal enters a strict disabled state to prevent accidental edits:

- The Add Action select, Text Editor toggle, Clear, Revert, and bottom **Save** buttons are all disabled
- Every existing MacroActionItem and its KeycodeField is disabled (native `disabled` attribute — Tab / hover / click are all suppressed)
- The inline favorites panel is made invisible with its width preserved, so the layout does not jump
- The modal's top-right Close button and backdrop click are inert — the modal cannot be dismissed until recording stops
- The list-mode footer's Clear / Revert / Save buttons remain visible but disabled during recording. In per-action edit mode the list-level Clear / Revert are hidden, but the edit-mode Save (and Revert, for existing edits) are kept visible and disabled so you can see the affordance

### 3.8 Combo

Combo keycodes for simultaneous key-press combinations.

![Combo Tab](screenshots/tab-combo.png)

The Combo tab displays a **tile grid preview** showing all entries. A note reads: "These features apply to the entire keyboard, not just the current layer."

- Each tile shows the combo number and a summary (e.g., "A + B → C")
- Click a tile to open the Combo edit modal directly to that entry (§5.2)
- Combo keycodes (CMB_000–CMB_031) can be assigned to keys for triggering combos
- **Settings: Configuration** button at the bottom opens a settings modal for combo-related timeout configuration (e.g., Combo time out period)
- **Edit JSON** button at the bottom opens a JSON editor for bulk editing all entries (see §5.6)

### 3.9 Key Override

Key Override keycodes for replacing key outputs when specific modifiers are held.

![Key Override Tab](screenshots/tab-keyOverride.png)

The Key Override tab displays a **tile grid preview** showing all entries and a settings area.

- Each tile shows the override number and a summary
- Click a tile to open the Key Override edit modal directly to that entry (§5.3)
- **Edit JSON** button at the bottom opens a JSON editor for bulk editing all entries (see §5.6)

### 3.10 Alt Repeat Key

Alt Repeat Key keycodes for context-aware alternate repeat key bindings.

![Alt Repeat Key Tab](screenshots/tab-altRepeatKey.png)

The Alt Repeat Key tab displays a **tile grid preview** showing all entries and a settings area.

- Each tile shows the entry number and a summary
- Click a tile to open the Alt Repeat Key edit modal directly to that entry (§5.4)
- **Edit JSON** button at the bottom opens a JSON editor for bulk editing all entries (see §5.6)

### 3.11 Behavior

Keycodes for advanced QMK behavior features.

- **Magic**: Magic keycodes for swapping and toggling keyboard behaviors
- **Mode**: NKRO toggle, mode switching keycodes
- **Auto Shift**: Auto Shift toggle and configuration keycodes
- **Autocorrect**: Autocorrect on / off / toggle
- **Leader**: Begin a leader sequence (`QK_LEAD`)
- **Swap Hands**: Swap Hands keycodes and Swap Hands Tap variants
- **Caps Word**: Caps Word toggle
- **Dynamic Tapping Term**: Print / increase / decrease the tapping term at runtime

### 3.12 User

User-defined keycodes.

![User Tab](screenshots/tab-user.png)

- Custom keycodes defined in firmware (e.g., `CUSTOM_1`, `CUSTOM_2`)
- When exporting `keymap.c`, custom keycodes use their configured names instead of generic `USER00`/`USER01` identifiers, and an `enum custom_keycodes` block is generated automatically

### 3.13 Keyboard (Device Picker)

The Keyboard tab lets you copy keycodes from other connected keyboards or from saved files.

> **Use case:** While editing a keyboard, you wonder how another keyboard's keymap is set up — but that keyboard isn't connected right now. If you've previously saved its data (via the Save panel), you can load it from the **File** source in this tab to browse its keymap and copy keycodes directly into your current layout.

**Device List**

![Keyboard Tab — Device List](screenshots/keyboard-tab-device-list.png)

When you open the Keyboard tab, a list of all connected Vial-compatible keyboards is displayed. This list updates in real time as you plug in or unplug devices.

- Click a device to load its keymap — the currently connected keyboard shows its live keymap instantly; other devices are probed via a temporary USB connection

![Keyboard Tab — Keymap View](screenshots/keyboard-tab-keymap.png)

- Once loaded, click any key on the displayed keyboard to assign that keycode to the selected key on the main keymap
- Use Ctrl+click for multi-select, Shift+click for range select
- Layer buttons at the bottom right let you browse different layers
- Zoom controls (+ / numeric input / −) adjust the picker keyboard size (30%–200%). When viewing another keyboard, its saved zoom level is loaded automatically
- Press Escape to clear the picker selection

**File Source**

Click the **File** button at the bottom to switch to the file source. This shows saved keyboard snapshots and allows loading `.pipette` files — the same keycode picking workflow applies.

> **Note**: Only V2 format (`.pipette`) files are supported in the key picker. If a legacy V1 format file is selected, a warning is displayed prompting you to connect the keyboard and open the keymap to migrate the data.

> **Tip — Build from keyboards you don't own:** The reference keyboard doesn't have to be one you physically own. Save a shared `.pipette` file under a name (§1.1), pick it as the **File** source here, then Ctrl+click / Shift+click to multi-select keys on the reference keyboard and click a key on your own keymap to paste them in. This lets you copy assignments from other people's layouts — or any keyboard you've collected — straight into yours, with no hardware connected.

**Composite Keycodes**

When clicking a composite key (e.g., `LT1(KC_SPC)`) in the picker, the full keycode is assigned as-is. Inner/outer parts are not split — the complete keycode is copied to the target key.

> **Note**: The Keyboard tab is hidden when editing the inner part of a mask key (e.g., choosing the `KC_SPC` inside `LT1(KC_SPC)`), since composite keycodes cannot be assigned to the inner byte.

### 3.14 Keycodes Overlay Panel

The Keycodes Overlay Panel provides quick access to editor tools and save functions. Toggle it with the panel button at the right end of the keycode tab bar.

**Settings / Import Tab**

![Overlay Panel — Settings / Import](screenshots/overlay-tools.png)

- **Key Editor Zoom**: Set the UI zoom level (50–200%) applied while in key editor mode. Defaults to the global UI zoom (§6.5) when not configured. Saved and synced per keyboard
- **Auto Move**: Toggle automatic advancement to the next key after assigning a keycode
- **View Matrix**: Enter or leave View Matrix mode (**Edit** / **Done**) to customize the Auto Move key order (see §2.6)
- **Instant Key Selection**: Toggle instant key selection mode (see §2.2 for behavior details)
- **Separate Shift in Key Picker**: Toggle split display for combined keycodes (e.g., show Mod-Tap as two halves)
- **Key Tester**: Toggle Matrix Tester mode (supported keyboards only)
- **Security**: Shows lock status (Locked/Unlocked) with a Lock button
- **Import**: Restore from `.vil` files or sideload custom JSON definitions
- **Reset Keyboard Data**: Reset keyboard to factory defaults

**Save Tab**

![Overlay Panel — Save](screenshots/overlay-save.png)

- **Export Current State**: Download keymap as `.vil`, `keymap.c`, PDF keymap cheat sheet, or PDF layout export (key outlines with summary pages for Tap Dance, Macro, Combo, Key Override, and Alt Repeat Key entries)
- **Save Current State**: Save a snapshot of the current keyboard state with a label
- **Synced Data**: List of saved snapshots with Load, Rename, Delete, and Export actions
- This is the same Save panel as the standalone editor settings (§6)

**Layout Tab** (when available)

Some keyboards support layout options (see §2.5). When available, a Layout tab appears as the first tab in the overlay panel, providing access to the same layout options.

---

## 4. Toolbar

The toolbar on the left side of the keymap editor provides the following features.

![Toolbar](screenshots/toolbar.png)

### 4.1 Zoom

Adjusts the keyboard layout display scale. Range: 30%–200% (default 100%).

![Zoom In](screenshots/zoom-in.png)

- (+) button to zoom in
- (-) button to zoom out
- Can also be adjusted in editor settings
- Zoom level is saved per keyboard and restored automatically on reconnect

### 4.2 Undo / Redo (Keymap History)

The keymap editor automatically records a history of keycode changes. You can navigate through this history to undo or redo changes.

| Method | Scope | How to use |
|--------|-------|------------|
| **Keyboard shortcuts** | Full history (up to Max Keymap History, default 100) | Ctrl/Cmd+Z (Undo), Ctrl+Y / Ctrl/Cmd+Shift+Z (Redo) |
| **Toolbar buttons** | Full history | Undo / Redo buttons in the left toolbar |
| **Popover buttons** | Last single change only (must match the open key) | Undo / Redo buttons in the popover footer (see §2.4) |

- History is cleared when switching keyboards or disconnecting
- The maximum history size can be configured in Settings → Defaults → **Max Keymap History** (see §6.1)
- All keymap mutation paths are tracked: single key edits, popover selections, mod-mask changes, paste, and copy-layer operations

### 4.3 Typing Test

A typing practice feature. Test your typing with the current keymap while viewing the keyboard layout below. The layout highlights key presses in real time, so you can verify that your physical keymap matches the on-screen display.

Click the **Typing Test** button in the status bar to enter typing test mode.

#### Settings Panel

The left side of the typing-test screen is a collapsible **Settings** panel. The chevron button at its bottom collapses it to a thin rail and expands it again; the state is saved per keyboard. The panel groups the test controls into three sections:

- **Settings** — the **Data Source** row (see below); **Layer** (the base layer used by the on-screen keymap, shown when the keyboard has more than one layer); and **Lines** / **Font** (line count and font size of the reading window — these two apply in every mode). With a MonkeyType language active, the **Pattern** / **Units** / **Option** rows described under **MonkeyType** also appear here; with a Tatoeba pack active, Tatoeba's own **Pattern** / **Units** rows appear instead (see **Tatoeba** below)
- **Data** — **History** opens the saved-results modal: results are split into **MonkeyType** and **File Import** tabs, with a mode filter dropdown on the MonkeyType tab and a text filter dropdown on the File Import tab; the stats row (Best / Avg / Last 10 / Tests / Avg Acc), the sparkline, and **Export CSV** all follow the current filter, and each row can be renamed (via the same naming modal as the finished screen) or deleted. **Compare** picks the comparison baseline — **Previous**, **Best**, **Average**, a pinned **Result**, or **Off**; while a baseline is set, colored ▲ / ▼ deltas appear next to WPM / KPM / Accuracy in the stats row. The baseline choice is remembered per test condition (mode + settings + language, or per imported text). **Save Unnamed** (default on) auto-saves finished results even without a name; switched off, only named results are kept

  Below the sparkline, an **Accuracy Trend** chart plots accuracy over time for a single test condition, picked from the dropdown next to it (e.g. "50 words (english) +punct" or "30s (english)"; the label format varies by mode). This condition picker is independent of the mode/text filter above it — it always lists every condition present in the active tab's full history — and defaults to the condition of the most recent run. The chart appears once the selected condition has 2 or more saved runs

  ![Typing Test — Accuracy trend](screenshots/typing-test-accuracy-trend.png)

  Below the Accuracy Trend chart, a **Most missed** ranking lists up to the top 15 missed characters (or, in Romaji mode, the missed kana's romaji, e.g. "shi") as proportional bars, ranked by mistake count. Unlike the Accuracy Trend, it isn't scoped to one condition — it aggregates every result in the active tab. It stays hidden when the tab has no results at all, and shows a brief empty message when there are results but none of them recorded a mistake
- **View** — three switches: **Operation** (the controls row below the reading window), **Measurement** (the live stats row), and **Keymap** (the keyboard pane). Each hides its area when switched off; a finished test always shows the controls and the results regardless

#### Data Source

![Typing Test — Data Source Modal (MonkeyType)](screenshots/typing-test-mode-monkeytype.png)

The **Data Source** row in the left Settings panel shows the active mode type and source (a MonkeyType language, a Tatoeba pack, or an imported text) — click the row to open the Data Source modal. Four tabs select what you type against:

- **MonkeyType** — random words, timed word bursts, or real-world quotes generated from a downloaded language pack
- **Tatoeba** — real sentences sampled from a downloaded Tatoeba language pack
- **Aozora Bunko** — public-domain Japanese literary works imported from the Aozora Bunko catalog
- **File Import** — a plain-text `.txt` file you import yourself

The modal opens on the tab matching the currently active mode. An Aozora Bunko import technically plays back as a File Import text, so opening the modal while one is active jumps straight to the **Aozora Bunko** tab instead of **File Import** — matching where the text is actually managed. Picking a row switches mode immediately and closes the modal; closing without picking (Escape, the X button, or clicking outside) leaves the current mode unchanged.

The **MonkeyType** and **Tatoeba** tabs share the same language-pack list:

- A search box filters the list by name
- Below the search box, a **Romaji** filter toggle narrows the list to Romaji-input-capable entries only (see **Romaji Input** under **MonkeyType** below). The **File Import** tab has the same toggle below its import button; the **Aozora Bunko** tab keeps its kana-row filter instead (see **Aozora Bunko** below)
- Packs are split into **Downloaded** and **Available** sections
- Each row shows the pack name and its word count; right-to-left languages also show an **RTL** badge, and kana packs (hiragana / katakana) that support Romaji input show a **Romaji** badge (see **Romaji Input** below)
- Click the download icon on an Available row to download it. Rows you downloaded yourself show a trash icon to delete them; packs bundled with the app (such as MonkeyType's english) are also listed under Downloaded but cannot be deleted
- If a newer dataset manifest is available, a banner reading "An update is available for the word lists." appears above the list with an **Update** button. This check runs automatically each time the tab is opened (a successful check is cached for the app session, so it won't repeatedly hit the network; a failed check — e.g. while offline — is not cached, and reopening the tab retries). Nothing downloads until you click **Update**
- Applying an update replaces the pack manifest and also removes that provider's previously downloaded packs, since they belong to the old dataset version — download them again from the refreshed list as needed

#### MonkeyType

With a MonkeyType language selected, the Settings panel gains three rows: **Pattern** picks the test pattern (**words** / **time** / **quote**), **Units** picks the word count, duration, or quote length for it, and **Option** toggles Punctuation / Numbers (words and time patterns only). The three patterns:

**Words Mode**

![Typing Test — Words Mode](screenshots/typing-test-words-waiting.png)

- Type a fixed number of random words (15 / 30 / 60 / 120)
- The test ends when all words are completed

**Time Mode**

![Typing Test — Time Mode](screenshots/typing-test-time-mode.png)

- Type as many words as possible within a time limit (15 / 30 / 60 / 120 seconds)
- A countdown timer shows remaining time

**Quote Mode**

![Typing Test — Quote Mode](screenshots/typing-test-quote-mode.png)

- Type a real-world quote (short / medium / long / all)
- The quote source is shown after completion

**Options**

![Typing Test — With Options](screenshots/typing-test-words-options.png)

In the words and time patterns, the Settings panel's **Option** row adds toggles:

- **Punctuation**: Adds punctuation marks (commas, periods, etc.) to the word list
- **Numbers**: Adds numbers to the word list

The Option row is hidden in the quote pattern (which uses the original text as-is) and in the Tatoeba / Aozora Bunko / File Import modes.

**Romaji Input**

![Typing Test — Romaji input](screenshots/typing-test-romaji.png)

Romaji input is not limited to the MonkeyType tab: with a romaji-capable source loaded — a **hiragana** or **katakana** MonkeyType language pack (words/time patterns), a kana **Tatoeba** pack, or a kana-only **File Import** / **Aozora Bunko** text — the Option row gains a full-width **Romaji** button. Romaji input **defaults on** for any capable source, so the button is already accent-colored the first time you load one — you don't need to turn it on yourself. Capable language packs and imported texts are marked with a **Romaji** badge wherever they're listed (see the shared language-pack list above, and the File Import / Aozora Bunko sections below), so you can spot them before selecting one. For an imported text, capability is computed locally from the text's own content the moment it's listed — it is never stored or synced, so it can't drift from the content it describes. Clicking the Romaji button opens the **Romaji Settings** modal rather than toggling judging directly; turning off the modal's master switch is the only way to opt out, and that choice persists across language and import switches until you turn it back on.

Japanese punctuation is typeable in Romaji mode too: 。、？！ map to `.` `,` `?` `!`, and a kana text containing them alongside kana is still counted as Romaji-capable.

![Typing Test — Romaji settings](screenshots/typing-test-romaji-settings.png)

The modal has four settings, in addition to the Romaji input master switch. The guide row's font size always tracks the shared **Settings > Font** size — there is no separate control for it.

- **Displayed case**: how the guide row's romaji is rendered — **ROMAJI** (upper case), **Romaji** (capitalized), or **romaji** (lower case, default). Display only; it never changes which keystrokes are accepted.
- **Words shown**: how many words of romaji the guide row displays, current word included — `0` hides the guide row entirely, `1` shows only the current word, `2` (default) adds the next word, and `3` adds two upcoming words. Upcoming (not-yet-current) words render fainter than the current word's guide.
- **Guide spelling pattern**: split into two rows, mirroring Accepted input patterns below.
  - **Base**: a single-select choice between **Hepburn** (shi/chi) and **Kunrei** (si/ti) — exactly one is always active, and it picks which base system's spelling the guide line shows for kana with multiple accepted spellings. **Hepburn is the default.**
  - **Options**: **C** (ca), **Q** (qu), **Digraph** (jya), **Small x** (xa), **Small l** (la), **W** (wi), **V** (va), **F** (fa), **YE** (ye), **Nasal x** (xn), and **N separator** (n') — independent alternate-spelling preferences layered on top of the selected Base, off by default. Multiple can be selected at once — e.g. selecting both Small x and the Kunrei base applies each preference to whichever kana it matches, in the same guide. Each button's label shows one example spelling; hover it for the full spelling list it covers.
  **Display only** — whichever accepted spelling you actually type is still correct, regardless of what the guide shows.
- **Accepted input patterns**: split into two rows.
  - **Base**: **Hepburn** (shi/chi) and **Kunrei** (si/ti), either of which can spell every kana on its own. Both are enabled by default. Clicks are selection-first: clicking an enabled base while both are on keeps **only** that base (one click switches to Kunrei alone), clicking a disabled base brings it back so both are accepted, and **at least one base always stays enabled** (clicking the sole enabled base does nothing).
  - **Options**: the same eleven families as the guide row above — **C**, **Q**, **Digraph**, **Small x**, **Small l**, **W**, **V**, **F**, **YE**, **Nasal x**, and **N separator** — all enabled by default. Turning any of them off rejects that family's spellings as input; unlike the base row, every option can be turned off at once, since the enabled base(s) already cover every kana on their own. Disabling a whole loanword family (W/V/F/YE) still leaves its kana typable via the decomposed spelling — e.g. with F off, ふぁ still completes as `fu` + `xa`.

Turning on Romaji input switches judging from literal text matching to sequential romaji-keystroke matching: each keystroke is checked against the current kana as you type, and any of its currently-accepted spellings is accepted interchangeably — for example でぃ accepts `dhi`, `deli`, or `dexi`, whichever you happen to type (subject to the Accepted input patterns above).

- The current word's kana are colored per confirmed segment, and a guide line below the reading window shows the romaji accepted so far plus the canonical spelling for the rest of the word — both update on every keystroke, including when a mid-word branch (like でぃ above) narrows down which spelling you're typing
- **Turn off your OS IME before typing.** Romaji input judges direct keystrokes, and an active IME composition intercepts them before they ever reach the matcher. If a composition event is detected while Romaji input is active, a hint appears below the guide line reminding you to turn the IME off
- A rejected keystroke does not advance the guide, and it stays counted against Accuracy — Backspace cannot undo it, so keep typing the current kana until it's accepted
- Words advance automatically as soon as their kana are complete; Space is not needed
- Because WPM tracks keystroke rate rather than confirmed word length in this mode, Romaji runs get their own personal best and history grouping (labeled with a `+romaji` suffix, e.g. "30 words (japanese_hiragana) +romaji") instead of being compared against non-Romaji runs
- This grouping does not track which Accepted input patterns were enabled — runs typed with different style restrictions still share the same personal best, Compare baseline, history filter, and Accuracy trend entries as long as everything else (mode, word count/duration, language, punctuation/numbers) matches

#### Tatoeba

![Typing Test — Data Source Modal (Tatoeba)](screenshots/typing-test-mode-tatoeba.png)

Pick a downloaded language pack from the **Tatoeba** tab (download it first if needed — see **Data Source** above) to type real sentences sampled from the [Tatoeba Project](https://tatoeba.org). Like MonkeyType, Tatoeba gets its own **Pattern** and **Units** rows in the Settings panel: **Pattern** picks **Lines** or **Time**. **Lines** samples a fixed batch of sentences per run — **Units** picks 5 / 10 / 20 / 40 sentences. **Time** runs for a set duration instead — **Units** picks 15 / 30 / 60 / 120 seconds — resampling another batch of sentences as you go so the run never runs out of material before time is up.

Personal bests, History, and the Accuracy Trend group Tatoeba runs by language + pattern + unit, so a 5-line run and a 30-second run of the same pack are tracked separately. The History condition label reflects this — e.g. **"Tatoeba 5 Lines (english)"** for a Lines run, **"Tatoeba 30s (english)"** for a Time run.

![Typing Test — Tatoeba Running](screenshots/typing-test-tatoeba-running.png)

- Each sampled sentence renders on its own line
- A **⏎** marker appears at the end of every line except the last; press **Enter** (not Space) there to advance to the next sentence. Elsewhere, Space still advances between words as usual
- Attribution and license details for the Tatoeba packs are shown on the About / legal screen
- The **japanese_hiragana** and **japanese_katakana** Tatoeba packs are kana-pure and marked with a **Romaji** badge in the pack list — see **Romaji Input** under MonkeyType above for how it works

#### Aozora Bunko

![Typing Test — Data Source Modal (Aozora Bunko)](screenshots/typing-test-mode-aozora.png)

Browse and import public-domain Japanese literary works from the [Aozora Bunko](https://www.aozora.gr.jp/) catalog (roughly 10,500 works, sourced via the aozorabunko GitHub mirror).

- The search box filters by title or author
- Below it, a two-tier gojūon (five-vowel kana) row filter narrows results by the first kana of the author's reading (ア / カ / サ / …); click a row to also reveal its column kana for a finer filter (e.g. the カ row → キ column). Click an active button again to clear it
- Results are split into **Downloaded** and **Available** sections; the **Available** section renders 50 works at a time, revealing the next 50 automatically as you scroll (the catalog list is loaded once when the tab opens — scrolling does not hit the network)
- Each row shows the title, author, and an estimated character count (`~N chars` — an estimate, not an exact figure)
- Clicking the download icon on an Available row downloads the work's archive from the GitHub mirror, decodes it, and automatically strips Aozora-specific markup (ruby annotations, editorial notes, header/footer boilerplate) before saving it as a typing text — no manual cleanup needed. The newly imported work is selected immediately. A failed import shows an inline error under that row
- A downloaded work is stored through the same normalization and 5,000-word cap as File Import texts (see below). Words are counted by whitespace, so in Japanese prose — which contains no spaces — each paragraph counts as one word, and the cap effectively allows around 5,000 paragraphs
- A downloaded work plays back exactly like an imported File Import text, including the per-line Enter-to-advance behavior, but it is only listed and deleted from this **Aozora Bunko** tab — it does not appear in the **File Import** tab
- Click the trash icon on a Downloaded row to remove it; it returns to Available and can be re-imported later
- The dataset-update banner described under **Data Source** also applies here — updating refreshes the catalog listing itself, not any already-imported works
- Once imported, a work whose content turns out to be pure kana (rare — most Aozora Bunko literature mixes kanji and kana) shows a **Romaji** badge in the Downloaded section, same as a kana File Import text — see **Romaji Input** under MonkeyType above

#### File Import

![Typing Test — Data Source Modal (File Import)](screenshots/typing-test-mode-import.png)

Import your own plain-text `.txt` file (UTF-8 only) to type against it — useful for practicing code snippets, prose, or any custom text.

- Click **Import UTF-8 text file** and choose a `.txt` file. Files must be UTF-8 encoded, no larger than 5 MB, and contain at least one typeable word — files that fail these checks are rejected with an inline error message
- Text is capped at 5,000 words; anything beyond the cap is silently truncated on import
- Non-empty line boundaries in the source file are preserved: a **⏎** marker appears at the end of every line except the last, and Enter (not Space) advances past it. Import normalizes the text — empty lines are dropped and runs of spaces or tabs within a line collapse to a single space. Leading indentation on each line is shown for reference but is not itself typed
- Importing a file whose name matches an existing entry prompts for confirmation before overwriting it
- Each row shows the text's name and length — **words** for space-separated text (e.g. English), or **lines** for text with no spaces to count words by (e.g. Japanese prose); click a row to select it, or click the trash icon to delete it
- This list only shows texts you imported directly here — Aozora Bunko imports are managed from the **Aozora Bunko** tab instead
- A text whose content is pure kana shows a **Romaji** badge and unlocks Romaji input for it — see **Romaji Input** under MonkeyType above. This is checked locally from the text's own content each time it's listed, not stored or synced

#### During a Test

![Typing Test — Running](screenshots/typing-test-running.png)

While typing, the following stats are displayed in real time:

- **WPM**: Words Per Minute (current typing speed)
- **KPM**: Keystrokes Per Minute (correct characters per minute)
- **Accuracy**: Percentage of correctly typed characters
- **Time**: Elapsed time (or remaining time in the time pattern)
- **Words**: Current word / total words. In File Import and Tatoeba modes this becomes **Chars** — character progress through the text instead of a word count

While a comparison baseline is set (Settings panel → Data → **Compare**), a colored ▲ / ▼ delta next to the WPM, KPM, and Accuracy values shows the difference against the baseline.

Correctly typed words turn green. Incorrect characters are highlighted in red with an underline. The cursor advances as you type, and words scroll automatically.

The controls row below the reading window changes with the test state:

- **Before a run starts**: **Next Test** generates a fresh test. When a paused File Import run is saved, a **Resume** button appears beside it
- **While running or paused**: **Restart** starts the test over. In File Import mode a **Pause** (running) or **Resume** (paused) button joins it — pausing saves the run, and resuming asks whether to continue from the saved position or start over
- **When finished**: a result-name field opens the naming modal, with quick-insert chips for the keyboard name, the test material, a timestamp, and the run's WPM / KPM / Accuracy; **Next Test** starts the next run. If the run had any mistakes, a **Missed** row appears below the stats, listing each missed character (or, in Romaji mode, each missed kana's romaji, e.g. "shi") with its count — counted when a wrong character is deleted with Backspace or left wrong when the word is submitted

Additional notes:

- Press Escape to exit typing test mode
- The status bar's Disconnect button is hidden while Typing Test is active. To disconnect, first return to the editor with Escape or the Typing Test button
- The keyboard layout below the test area shows key presses in real time via the Vial matrix tester protocol

#### Typing View (View-Only Mode)

Typing View displays only the keyboard layout in a compact, resizable window — ideal for overlaying on top of other applications while practicing.

Click the **Typing View** button in the status bar (visible when Typing Test is not active) to enter view-only mode.

![View-Only — Compact Window](screenshots/view-only-compact.png)

- The window shows only the keyboard layout with real-time key press highlighting
- The toolbar, keycode palette, typing test UI, and status bar are hidden
- The window maintains its aspect ratio when resized

**Menu Pane**

![View-Only — Controls](screenshots/view-only-controls.png)

Click anywhere on the keyboard area to toggle the menu pane (bottom-right popup). The pane is split into **Window** and **REC** tabs at the top, with a shared **Base** layer selector and **Exit Typing View** button at the bottom.

**Window tab** (default)

- **Default Size**: Reset the window to its default calculated size
- **Fit Size**: Adjust the window height to match the current width while preserving the aspect ratio
- **Top**: Keep the window above other windows (always-on-top; not available on Wayland)

**REC tab**

Recording controls and the Monitor App toggle. Detailed in **Typing analytics recording** below.

**Shared controls** (visible in both tabs)

- **Base**: Select which layer to display (when the keyboard has multiple layers)
- **Exit Typing View**: Return to the full editor

Press Escape or click the keyboard area again to close the pane. A hint text appears at the bottom when hovering over the window. The window size, always-on-top preference, and the active menu tab are saved per keyboard.

> **Note**: Auto-lock is suspended while in Typing View mode. If the keyboard is disconnected while in view-only mode, the window automatically restores to its normal size.

#### Typing analytics recording

While Typing View is open, the **REC** tab in the Menu Pane records per-key and per-minute statistics that feed the Analyze page (§1.4). Recording stays off by default.

![Typing Test — REC Tab](screenshots/typing-test-rec-tab.png)

**Start / Stop**

Press the toggle once to start recording — the button shows **Start** while idle and **Stop** while recording. The Recording indicator appears at the top of the Typing View window so you can tell at a glance whether data is being captured.

The very first time you press Start, a consent dialog appears:

![Typing Test — Recording Consent](screenshots/typing-test-rec-consent.png)

| Section | Items |
|---------|-------|
| **What we collect** | Per-minute character frequency · Per-key press counts (row / col / layer / keycode, tap vs hold) · Typing speed distribution (interval percentiles) · Active application name (only when Monitor App is on; minutes that observe multiple apps are recorded as unknown) |
| **What we do NOT collect** | Individual keystroke timing · Text content / passwords / specific words · Window title / URL / file path |

Click **Enable** to opt in — your consent is persisted in app settings (not synced) and the dialog never appears again. Click **Cancel** to back out without starting; you can press Start later to see the dialog again.

**Monitor App**

When the Monitor App toggle is on (and REC is in the Stop / recording state), Pipette resolves the foreground application name once per data flush so each minute can be tagged with the app that owned the keystrokes. Minutes that observed only one app carry that app's name; minutes that observed multiple apps are tagged as `Unknown / Mixed`. The tags drive the **App** filter and the **By App** tab in Analyze.

- The button is greyed out while REC is **Start** (not recording) state — turning it on without REC has no effect, so the UI funnels you through Start first
- The on/off state is global (AppConfig), not per-keyboard, and is **not** synced to other machines
- **Linux / Wayland**: requires the FocusedWindow GNOME Shell extension (see README). Without it, every minute is recorded as `null`
- **macOS**: requires the Accessibility permission (see README). Without it, every minute is recorded as `null`
- Turning Monitor App off keeps existing tags in the database; only newly recorded minutes go untagged

**Tray toggles**

Directly below Monitor App, the REC tab also has **Stay in System Tray** and **Start Hidden in Tray** toggles — the same settings as Settings → Tools (§6.6), with the same linked-disable behavior (Start Hidden in Tray is disabled while Stay in System Tray is off, and turning Stay in System Tray off also turns Start Hidden in Tray off). They're surfaced here too since the Typing View window is often the last one open before you reach for the tray.

**View Analytics**

Jumps directly to the Analyze page for this keyboard so you can review the stream you just recorded. Going back returns you to Typing View.

#### View Mode Memory and Auto-Restore

The last view mode (Editor / Typing Test / Typing View) is remembered per keyboard and automatically restored the next time you connect that keyboard:

- **Editor**: The editor view is shown as usual
- **Typing Test**: Typing Test mode is re-entered automatically. If the keyboard is locked, the Unlock dialog appears first and the test starts after unlocking
- **Typing View**: The compact view-only window is re-entered automatically. If the keyboard is locked, the Unlock dialog appears first

View mode is stored per keyboard alongside preferences like keyboard layout, zoom scale, and window size. When Pipette Hub sync is enabled, view mode is synced to other devices as well (see §7).

---

## 5. Detail Setting Editors

Open detail setting modals from their dedicated keycode tabs. Lighting opens via a **Settings: Configuration** button at the bottom of its tab; Combo, Key Override, and Alt Repeat Key detail editors open by clicking an entry on their respective tabs.

### 5.1 Lighting Settings

Open from the **Settings: Configuration** button on the Lighting tab. Configure RGB lighting colors and effects.

![Lighting Settings](screenshots/lighting-modal.png)

- Select colors with the HSV color picker
- Choose colors from preset palette
- Adjust effects and speed
- Click Save to apply

### 5.2 Combo

Configure simultaneous key press combinations to trigger different keys. The Combo tab displays an inline tile grid; clicking an entry opens the detail editor modal directly.

**Tile Grid (Combo tab)**

![Combo List](screenshots/combo-modal.png)

The Combo tab shows entries as a numbered list (0--31). Configured entries display a summary (e.g., "A + B → C"). Click an entry to open the detail editor. Combo keycodes (Combo On, Combo Off, Combo Toggle) are shown below the list. A **Settings: Configuration** button at the bottom opens a settings modal for QMK Combo timeout configuration (e.g., Combo time out period).

**Detail Editor**

![Combo Detail](screenshots/combo-detail.png)

- Left panel: Combo editor with Key 1--4 and Output fields.
- Right panel: Inline favorites panel (Save Current State / Synced Data / Import / Export All)
- **Clear** resets all fields; **Revert** restores the last saved state. Both use two-step confirmation.
- **Save** writes changes to the keyboard

### 5.3 Key Override

Replace specific key inputs with different keys. The Key Override tab displays an inline tile grid; clicking an entry opens the detail editor modal directly.

**Tile Grid (Key Override tab)**

![Key Override List](screenshots/key-override-modal.png)

Shows entries as a numbered list. Configured entries display a summary. Click an entry to open the detail editor.

**Detail Editor**

![Key Override Detail](screenshots/key-override-detail.png)

- Left panel: Trigger Key, Replacement Key, enabled toggle, layer and modifier options
- Right panel: Inline favorites panel (Save Current State / Synced Data / Import / Export All)
- **Clear** resets all fields; **Revert** restores the last saved state. Both use two-step confirmation.
- **Save** writes changes to the keyboard

### 5.4 Alt Repeat Key

Configure alternative actions for the Repeat Key. The Alt Repeat Key tab displays an inline tile grid; clicking an entry opens the detail editor modal directly.

**Tile Grid (Alt Repeat Key tab)**

![Alt Repeat Key List](screenshots/alt-repeat-key-modal.png)

Shows entries as a numbered list. Configured entries display a summary. Click an entry to open the detail editor.

**Detail Editor**

![Alt Repeat Key Detail](screenshots/alt-repeat-key-detail.png)

- Left panel: Last Key, Alt Key, enabled toggle, Allowed Mods, Options (DefaultToThisAltKey, Bidirectional, IgnoreModHandedness)
- Right panel: Inline favorites panel (Save Current State / Synced Data / Import / Export All)
- **Clear** resets all fields; **Revert** restores the last saved state. Both use two-step confirmation.
- **Save** writes changes to the keyboard

### 5.5 Favorites

Each editor modal (Tap Dance, Macro, Combo, Key Override, Alt Repeat Key) includes an inline **Favorites panel** on the right side of the editor.

![Inline Favorites Panel](screenshots/inline-favorites.png)

The inline favorites panel provides:

- **Save Current State**: Enter a label and click Save to store the current entry configuration
  - **Import** / **Export** buttons: Import a `.pipette-fav` file to apply to the current entry, or export the current entry settings as a `.pipette-fav` file without saving to the store. Inline "Imported" / "Exported" feedback is shown after each action.
- **Synced Data**: Previously saved entries are listed with Load, Rename, Delete, and Export actions
- **Import** / **Export All**: Footer buttons for bulk import/export of favorites

Within the Synced Data list:

- **Load**: Apply a saved configuration to the current entry
- **Rename**: Change the label of a saved entry (also synced to Hub if the entry is uploaded)
- **Delete**: Remove a saved entry
- **Export**: Download an individual saved entry as a file

When Pipette Hub is connected, each saved entry also shows Hub actions:

![Inline Favorites — Hub Actions](screenshots/hub-fav-inline.png)

- **Upload to Hub**: Upload the favorite entry to Pipette Hub as a feature post — opens the Public / Private confirmation dialog (§7.2)
- **Update on Hub**: Re-upload the latest configuration; the dialog can also switch the post between Public and Private
- **Remove from Hub**: Delete the entry from Pipette Hub (two-step confirmation)
- **Open in Browser**: Open the individual Hub post page in your browser

### 5.6 JSON Editor

Each feature tab (Tap Dance, Macro, Combo, Key Override, Alt Repeat Key) provides an **Edit JSON** button at the bottom of the tab. This opens a JSON editor modal for bulk editing all entries as raw JSON text.

![JSON Editor — Tap Dance](screenshots/json-editor-tap-dance.png)

- **Text area**: Edit all entries as a JSON array. Changes are validated in real time — parse errors are shown below the editor
- **Export** (left): Save the current JSON as a `.pipette-fav` file for backup or sharing
- **Cancel** (right): Close without saving
- **Save** (right): Apply the parsed JSON and write changes to the keyboard

![JSON Editor — Macro](screenshots/json-editor-macro.png)

For Macros, a warning is displayed indicating that keyboard unlock is required to save changes.

> **Note**: The JSON editor modifies all entries at once. Use with caution — invalid JSON will be rejected, but valid JSON with incorrect values may cause unexpected behavior.

> **Note**: Favorites are not tied to a specific keyboard — saved entries can be loaded on any compatible keyboard. When Cloud Sync is enabled, favorites are also synced across devices (see §6.1). Favorites can also be managed from the Data modal on the device selection screen (see §1.3).

---

## 6. Editor Settings Panel

Open the editor settings panel from the save button (floppy disk icon) in the keycode tab bar, or use the Save tab in the Keycodes Overlay Panel (§3.14).

![Editor Settings — Save](screenshots/editor-settings-save.png)

The editor settings panel now provides a single **Save** panel with the following features:

- **Export Current State**: Download keymap as `.vil`, `keymap.c`, PDF keymap cheat sheet, or PDF layout export (key outlines with summary pages for Tap Dance, Macro, Combo, Key Override, and Alt Repeat Key entries). An "Exported" inline feedback message appears after a successful export.
- **Save Current State**: Save a snapshot of the current keyboard state with a label. Enter a name in the Label field and click Save. If the Label field is left empty, the Save button is disabled. Saved snapshots appear in the Synced Data list below and can be loaded or deleted later
- **Synced Data**: List of saved snapshots. Click to load, rename, or delete entries
- **Reset Keyboard Data**: Reset keyboard to factory defaults (use with caution)

> **Note**: Tool settings (auto advance, key tester, security) are in the Keycodes Overlay Panel (§3.14). Keyboard layout is available in the status bar quick settings (§9); Basic tab view type is selectable at the bottom of the Basic tab. Zoom is available in the toolbar (§4.1). Layer settings are managed directly via the layer panel on the left side of the editor.

### 6.1 Cloud Sync (Google Drive appDataFolder)

Pipette can sync your saved snapshots, favorites, and per-keyboard settings across multiple devices via Google Drive.

Sync is configured in the **Settings** modal (gear icon on the device selection screen), under the **Data** tab:

![Data Tab](screenshots/hub-settings-data-sync.png)

The Data tab contains the following sections: Google Account, Data Sync, and Pipette Hub. Additional troubleshooting and data management options are available in the Data panel (§1.3).

#### Google Account

- Click **Connect** to sign in with your Google account
- Click **Disconnect** to sign out. If Pipette Hub is also connected, a warning confirms that Hub will be disconnected as well

#### Sync Encryption Password

- Set a password to encrypt all synced data (required). A strength indicator helps you choose a strong password
- If a password already exists on the server (set from another device), a hint is shown asking you to enter the same password
- **Change Password**: Click **Change Password** to re-encrypt all synced files with a new password. No data is deleted — existing files are decrypted and re-encrypted in place

**Change Password error conditions**

When a password change cannot proceed, Pipette shows a localized message instead of the raw error. The common cases are listed below; other underlying errors (network, Drive) may appear as their own messages.

Credential failures (the 5 reasons come from the same typed `SyncCredentialFailureReason` set used for readiness — only 3 of them surface in **Sync Status** below):

| Reason | Message | Trigger |
|--------|---------|---------|
| `unauthenticated` | "Please sign in to Google before changing the password." | Not signed in with Google |
| `noPasswordFile` | "No saved password to change. Set a password first." | No local sync password has ever been set |
| `decryptFailed` | "Couldn't read the existing password (OS keychain rejected it)." | The OS keychain entry is unreadable (keychain reset, profile move, etc.) |
| `keystoreUnavailable` | "OS keychain is not available; password cannot be changed here." | `safeStorage.isEncryptionAvailable()` returns false (typical on headless Linux without a keyring) |
| `remoteCheckFailed` | "Couldn't reach Google Drive to verify the current password." | Network or Drive outage — retry later |

Operational errors (shown as the message directly, no reason code):

| Message | Trigger |
|---------|---------|
| "Cannot change password while sync is in progress." | A sync is already running — wait for it to finish |
| "New password must be different from the current password." | The new password matches the existing one |
| "Some files cannot be decrypted. Please scan and delete undecryptable files first." | Drive has files the current password cannot decrypt — use **Undecryptable Files** first |
| "Sync password does not match. Please check your encryption password." | The current password fails to decrypt the remote password check — reconfirm the password you are providing |

#### Sync Controls

- **Auto Sync**: Toggle automatic sync on or off. When enabled, changes sync automatically with a 10-second debounce and periodic 3-minute polling
- **Sync**: Manually sync favorites and connected keyboard data. Only favorites and the currently connected keyboard are synced (not all keyboards)

#### Sync Status

- Displays current sync progress with the sync unit name and an item counter (current / total)
- Shows error or partial-sync details if any units failed

**Readiness reasons**

If sync cannot run because the client is not ready, a specific readiness reason is shown in place of the generic "Not synced yet" label. Only three reasons surface here; detailed keystore failures (`decryptFailed`, `keystoreUnavailable`) come through the password set/change flow instead.

| Reason | Message |
|--------|---------|
| `unauthenticated` | "Sign in to Google to sync." |
| `noPasswordFile` | "Set a sync password to start syncing." |
| `remoteCheckFailed` | "Couldn't reach Google Drive — sync is paused." |

#### Undecryptable Files

- Files that cannot be decrypted with the current password or are otherwise unreadable (e.g., encrypted with a forgotten previous password)
- Click **Scan** to detect undecryptable files, select the ones to remove, then click **Delete Selected** to permanently delete them from Google Drive

#### Sync Unavailable Alert

- Displayed when the sync backend cannot be reached. Click **Retry** to attempt reconnection

#### Data Storage

Synced data is stored in [Google Drive appDataFolder](https://developers.google.com/workspace/drive/api/guides/appdata) — a hidden, app-specific folder that only Pipette can access. Your personal Drive files are never touched.

See the [Data Guide](Data.md) for details on what is synced and how your data is protected.

#### Data Management

Troubleshooting and data management functions are available in the **Data** panel (see §1.3):

- **Local > Application**: Import/export local data or reset selected targets (keyboard data, favorites, app settings)
- **Sync**: List remote-only keyboards by real name and download any one on demand (see §1.3). To delete encrypted files that cannot be decrypted, use the **Undecryptable Files** section above

#### Settings — Defaults

![Settings — Defaults](screenshots/settings-defaults.png)

The Tools tab in the Settings modal includes a **Defaults** section for setting initial preferences for new keyboard connections:

- **Keyboard Layout**: Default key labels for new keyboards. The dropdown lists every entry currently installed in the **Key Labels** store (see §6.2). QWERTY ships built-in; install more from Pipette Hub or import a `.json` via **Key Labels Manage**. The drop-down preserves the manual order set in the modal — drag a row up or down there and the dropdown follows
- **Auto Move**: Default auto-advance behavior
- **Instant Key Selection**: Default instant key selection behavior (see §2.2)
- **Layer Panel Open**: Whether the layer panel starts expanded or collapsed
- **Basic View Type**: Default view type for the Basic tab (ANSI/ISO/JIS/List)
- **Separate Shift in Key Picker**: Default setting for separating Shift in the key picker
- **Max Keymap History**: Maximum number of keymap changes to keep in the current keyboard's edit history (default: 100). History is cleared on disconnect or keyboard switch. See §4.2 for details.

### 6.2 Key Labels Manage

The Tools tab also exposes a **Key Labels Manage** row (next to the Language Packs row). Click **Edit** to open the Key Labels modal, which manages every label set the app uses to render keycaps in the editor, the Analyze view, and the Layout Comparison.

QWERTY is built-in; every other label set (Dvorak, Colemak, French, Brazilian, …) is downloaded from Pipette Hub or imported from a local `.json` file. Installed entries sync across devices via Cloud Sync, so the same drag order and selection appear on every machine signed into the same account.

**Installed tab**

![Key Labels — Installed](screenshots/key-labels-installed.png)

Lists every label set already on this device. Each row shows the label name, the uploader name (when the entry came from Hub), the Hub-side last-update time (`YYYY-MM-DD HH:mm`, mirrors what the Hub website displays), an `.json` export shortcut, and a Delete button. Drag the grip handle on the left to reorder rows — the order is propagated to the Settings dropdown and to every Key Labels picker in the editor.

A second line under each row exposes the Hub actions:

- **Open**: open the entry's Hub page in the system browser (only when the row is linked to a Hub post)
- **Upload**: publish a new Hub post from this local entry (only for entries that have not been uploaded yet)
- **Update**: push the current local content to the existing Hub post (owner only)
- **Sync**: pull the latest Hub content into this local entry without losing the local rename or drag position (shown for downloaded entries you do not own). A **pulsing green dot** appears next to the Sync button when the Hub-side post is newer than your local cache — opening the modal triggers a bulk freshness check (throttled to once per 5 min) so you can spot updates without manually clicking each row
- **Remove**: take the post down from Hub. Confirms inline before running

If the Hub freshness check finds a row whose post has been deleted upstream, the Updated column reads **`(removed)`** in red instead of a timestamp; clicking Sync on such a row will fail because the Hub no longer serves it.

QWERTY shows no Hub actions and cannot be deleted, but it can be reordered like any other row.

**Find on Hub tab**

![Key Labels — Find on Hub](screenshots/key-labels-hub.png)

Searches Pipette Hub for label sets. Type 2 or more characters to start an automatic search (debounced); the **Search** button and **Enter** still work as manual triggers. Results show the label name, the uploader, and either a **Download** action or an **Installed** marker when the same name is already present locally. Re-importing a file with a name that already exists overwrites the local entry in place (`.json` content replaced, the Hub link is preserved).

**Authoring a Key Label**

A Key Label `.json` file is a small JSON object with three fields:

```json
{
  "name": "Brazilian (QWERTY)",
  "map": {
    "KC_2": "2\n@",
    "KC_3": "3\n#",
    "KC_LBRC": "´\n`",
    "KC_QUOT": "ç",
    "KC_GRAVE": "KC_LALT"
  },
  "compositeLabels": {
    "LSFT(KC_2)": "@",
    "LALT(KC_L)": "KC_LALT"
  }
}
```

In the example above, `"KC_GRAVE": "KC_LALT"` makes the editor render whichever cap is currently bound to `KC_GRAVE` with the canonical "LAlt" legend — the value is a keycode id, so `keycodeLabel()` resolves it on the fly.

| Field | Required | Purpose |
|------|:--:|---------|
| `name` | Yes | Display name shown in the modal, in the Settings → Defaults dropdown, and in the Keycodes Overlay Panel |
| `map` | Yes | `QMK keycode id → label string`. Used as the keycap legend in the Keymap Editor whenever this label set is active |
| `compositeLabels` | No | Same shape as `map`, but for composite keycodes (e.g. `LSFT(KC_2)`, `LT(0,KC_A)`, `MT(MOD_LCTL,KC_ESC)`). Used to override the inner / outer text of the composite key. Omit the field if you don't need any composite override |
| `keymapApplicable` | No | Optional boolean. Opt-in marker meaning this label set is a pure QWERTY-keycode permutation (e.g. Colemak, Dvorak) and can also be used to bulk-rewrite the actual keymap, not just the display legends — see **Applying a Key Label to the Keymap** below. Omit or set `false` for label sets that aren't a clean 1:1 character swap (multi-line shift/altgr legends, keycode-passthrough values, non-Latin layouts, …) |

A value can also be a plain QMK keycode id — the editor passes it through `keycodeLabel()` so something like `"LALT(KC_L)": "KC_LALT"` resolves to the canonical "LAlt" label without you having to spell the legend out by hand. The same shortcut works in `map`, so `"KC_8": "KC_LALT"` would render the cap as "LAlt".

The label string controls how the legend is rendered. Lines are separated by `\n` and the layout is chosen by part count:

| Parts | Layout | Example |
|------|--------|---------|
| 1 | Centred (existing behaviour) | `"8"` |
| 2 | Stacked top / bottom | `"(\n8"` → `(` over `8` |
| 3 | Three horizontal slices (top / middle / bottom) | `"a\nb\nc"` |
| 4 | 2 × 2 quadrants — top-left, top-right, bottom-left, bottom-right | `"1\n2\n3\n4"` →`1\|2 / 3\|4` |
| 5+ | Excess parts beyond 4 are dropped |  |

An empty string between separators leaves the corresponding slot blank, so `"1\n2\n\n4"` renders as:

```
1 | 2
-----
  | 4
```

Composite keycodes (LT, MT, modifier+key, …) render the inner key inside an inset rectangle that occupies the lower half of the cap, so only the first two `\n` parts of the outer label are honoured. Parts 3 and 4 are silently dropped to avoid colliding with the inner rect.

`name` is also the uniqueness key inside the local store: importing a `.json` whose name already exists overwrites the matching entry in place (the Hub post link, if any, is preserved). To start a brand-new entry, change the `name` before importing.

**Applying a Key Label to the Keymap**

Switching the **Keyboard Layout** dropdown in the footer normally just changes which legends are shown on the keycaps — the underlying keymap is untouched. For label sets marked `keymapApplicable`, the dropdown offers to rewrite the keymap itself so the physical keys actually produce the labelled characters.

When you pick a `keymapApplicable` entry (and a keymap is loaded on the connected keyboard), a confirmation dialog appears with three choices:

![Apply Key Label to Keymap](screenshots/key-label-keymap-apply-modal.png)

- **Rewrite Keymap** — bulk-rewrites every layer's keycodes (and encoders, where applicable) to match the label set. The whole rewrite lands as a single Undo step in the Keymap Editor's normal history — one Undo reverts every key it touched
- **Display Only** — switches only the legends, same as today's behaviour
- **Cancel** — closes the dialog without changing the current selection

After a successful Rewrite, the keys that were actually changed briefly flash the same blue used for key selection before fading back, so you can see at a glance what changed.

**The display stays on QWERTY legends after a Rewrite.** Once the keymap physically holds an arrangement's keycodes, the Keyboard Layout dropdown shows the *built-in QWERTY* legends, not the arrangement you just applied — the legends are meant to be read against the keys' actual QWERTY-baseline positions, and each key now sends the character its cap already shows. Selecting the same arrangement's own legends afterward would translate an already-rewritten keycode a second time (see the limitation below).

The dropdown remembers which arrangement was last actually rewritten into the keymap, separately from which legends are currently displayed. That means:

- **Picking QWERTY later offers a restore rewrite.** If the keymap currently holds e.g. Colemak's keycodes, selecting QWERTY from the dropdown re-opens the confirmation dialog — Rewrite Keymap converts the keys back to their original QWERTY characters.
- **Switching between two `keymapApplicable` arrangements converts directly.** Picking Dvorak while Colemak is the one actually applied rewrites straight from Colemak's current keycodes to Dvorak's — it does not assume the keymap is still raw QWERTY, so the keys end up with the correct Dvorak characters in one step.
- Picking **Display Only** at any point never changes which arrangement is considered "applied" — only a **Rewrite Keymap** confirmation does.

The desktop app always re-validates the map itself before offering the rewrite, even when `keymapApplicable` is set in the file — a label set with shift-pair legends, non-Latin characters, keycode-passthrough values (like the `"KC_GRAVE": "KC_LALT"` example above), or a map that isn't **closed** (every replacement character's key must itself remap somewhere, even if only back to itself — a map that sends key A's character to key B but never says what key B should now send would duplicate one character and lose another) fails validation and the dropdown falls back to a silent Display Only switch, same as a label set that has no flag at all. The same re-validation applies to whichever arrangement is currently applied — if that pack has since been removed or edited to fail validation, the dropdown logs the reason and falls back to a plain Display Only switch instead of guessing at a conversion.

**Limitations**

- Manually re-selecting the display legends for the arrangement that's already applied (e.g. choosing Colemak's own legends while the keymap is already Colemak-rewritten) intentionally looks double-translated — label sets assume the keys underneath are still QWERTY keycodes, so this is expected, not a bug.
- Manual per-key edits made after a Rewrite are skipped by the next Rewrite's safety check: it only touches a position whose keycode still matches what that arrangement's table expects to find there, so a key you've since edited by hand is left alone.
- If a Rewrite fails partway through (e.g. a device write error), Undo still reverts exactly the keys that were changed before the failure — but the Keyboard Layout dropdown's displayed legends are left exactly as they were and the arrangement is not recorded as newly "applied", since the keymap is now a mix of old and new characters that doesn't match either arrangement.

On Pipette Hub, the flag round-trips as `keymap_applicable` in the upload / download body alongside `map` and `composite_labels`.

### 6.3 Language Packs Manage

The Tools tab shows a **Language Packs** row displaying the currently active UI language. Click **Edit** to open the Language Packs modal.

English is built-in; every other language is imported from a local `.json` file or downloaded from Pipette Hub. Installed packs sync across devices via Cloud Sync. Hub-linked packs are automatically checked for updates at app startup and refreshed silently when newer versions are available.

**Installed tab**

![Language Packs — Installed](screenshots/language-packs-installed.png)

Lists every language pack on this device. Each row has a **check circle** on the left — click it to switch the active UI language immediately. The active row is highlighted with an accent border.

Each row shows:

- **Name** (click to rename inline)
- **Updated timestamp** (`YYYY-MM-DD HH:mm`)
- **Version** chip when the pack covers every key of the current English baseline, or a **not set keys** button that opens a modal listing the missing translation keys
- **Export** / **Delete** actions on the first line
- **Open** / **Upload** / **Update** / **Sync** / **Remove** Hub actions on the second line (same pattern as Key Labels §6.2)

A **pulsing green dot** next to the Sync button indicates that the Hub-side post is newer than the local copy (freshness check runs once per 5 minutes when the modal is open).

The **Import** button in the toolbar opens a file dialog to import a `.json` language pack. Re-importing a pack with the same `name` overwrites the existing entry.

**Find on Hub tab**

![Language Packs — Find on Hub](screenshots/language-packs-hub.png)

Searches Pipette Hub for language packs. Type 2 or more characters to start an automatic search (debounced). Results show the pack name, version, uploader, and either a **Download** action or an **Installed** marker.

**Authoring a Language Pack**

A language pack `.json` mirrors the structure of the built-in English pack. Export the English pack (built-in row → Export) to get a template with every key, then translate the values:

```json
{
  "name": "Japanese",
  "version": "0.1.0",
  "common": {
    "save": "保存",
    "cancel": "キャンセル"
  },
  "editor": {
    "keymap": {
      "title": "キーマップ"
    }
  }
}
```

| Field | Required | Purpose |
|------|:--:|---------|
| `name` | Yes | Display name and uniqueness key for overwrite-on-import |
| `version` | Yes | Semver string (e.g. `0.1.0`) |
| (other keys) | Yes | Nested translation tree matching the English structure |

Keys use dot-separated namespaces (e.g. `editor.keymap.title`). A pack that covers every key of the English baseline shows the version chip; partial packs show a "not set keys" link so translators can see what remains. A standard Japanese pack, plus several Japanese "persona" variants (different speaking styles, translated from the same baseline), are shipped as example packs in the [`sample-packs/i18n/`](../sample-packs/i18n/) directory in the repository.

### 6.4 Theme Packs Manage

The Tools tab shows a **Theme Packs** row displaying the currently active theme pack (if any). Click **Edit** to open the Theme Packs modal.

Theme packs override the application's colour palette. The built-in Light / Dark / System themes remain available; a theme pack layers its colours on top. Installed packs sync across devices via Cloud Sync.

> **For theme pack authors:** See the [Theme Pack Authoring Guide](THEME-PACK-AUTHORING.html) for a complete colour token reference and design tips.

**Installed section**

![Theme Packs — Installed](screenshots/theme-packs-installed.png)

Lists every theme pack on this device. Each row has a **radio circle** on the left — click it to apply that theme pack immediately. Click the active row again to deselect it and revert to the built-in theme. The three built-in options (Light / Dark / System) appear at the top.

Each row shows:

- **Name** (click to rename inline)
- **Updated timestamp** (`YYYY-MM-DD HH:mm`)
- **Version** chip
- **.json** export shortcut and **Delete** button on the first line
- **Open** / **Upload** / **Update** / **Sync** / **Remove** Hub actions on the second line (same pattern as Key Labels §6.2)

A **pulsing green dot** next to the Sync button indicates that the Hub-side post is newer than the local copy (freshness check runs once per 5 minutes when the modal is open).

The **Import** button in the toolbar opens a file dialog to import a `.json` theme pack. Re-importing a pack with the same `name` overwrites the existing entry.

**Find on Hub tab**

![Theme Packs — Find on Hub](screenshots/theme-packs-hub.png)

Searches Pipette Hub for theme packs. Type 2 or more characters to start an automatic search (debounced). Each result shows the pack name, version, uploader, a **Preview** button, and either a **Download** action or an **Installed** marker.

Click **Preview** to temporarily apply the theme's colours without installing. The preview resets when you close the modal, switch to the Installed tab, or click **Preview** again to toggle it off.

**Authoring a Theme Pack**

A theme pack `.json` defines a `name`, `version`, and a `colors` object mapping every colour token to a CSS colour value:

```json
{
  "name": "Nord",
  "version": "1.0.0",
  "colorScheme": "dark",
  "colors": {
    "surface": "#2e3440",
    "surface-alt": "#3b4252",
    "surface-dim": "#272c36",
    "surface-raised": "#434c5e",
    "content": "#eceff4",
    "content-secondary": "#d8dee9",
    "content-muted": "#7b88a1",
    "content-inverse": "#2e3440",
    "edge": "#4c566a",
    "edge-subtle": "#3b4252",
    "edge-strong": "#d8dee9",
    "accent": "#88c0d0",
    "accent-hover": "#81a1c1",
    "accent-alt": "#5e81ac",
    "success": "#a3be8c",
    "warning": "#ebcb8b",
    "danger": "#bf616a",
    "pending": "#b48ead",
    "key-bg": "#3b4252",
    "key-bg-hover": "#434c5e",
    "key-bg-active": "#4c566a",
    "key-border": "#4c566a",
    "key-shadow": "rgba(0,0,0,0.3)",
    "key-label": "#eceff4",
    "key-sublabel": "#d8dee9",
    "key-label-remap": "#88c0d0",
    "key-bg-multi-selected": "#434c5e",
    "tab-bg-active": "#3b4252",
    "tab-text": "#7b88a1",
    "tab-text-active": "#eceff4",
    "picker-bg": "#2e3440",
    "picker-item-bg": "#3b4252",
    "picker-item-hover": "#434c5e",
    "picker-item-text": "#eceff4",
    "picker-item-border": "#4c566a"
  }
}
```

| Field | Required | Purpose |
|------|:--:|---------|
| `name` | Yes | Display name and uniqueness key for overwrite-on-import |
| `version` | Yes | Semver string (e.g. `1.0.0`) |
| `colorScheme` | Yes | `"light"` or `"dark"` — declares the intended brightness of the pack |
| `colors` | Yes | Object mapping all 35 colour tokens to CSS colour values (`#hex`, `rgb()`, or `hsl()`) |

All 35 colour tokens are required. Export any installed pack (row → `.json`) to get a complete template. Ready-to-use example theme packs (Kanagawa Wave / Dragon / Lotus and Solarized Light / Dark) are also available in the [`sample-packs/themes/`](../sample-packs/themes/) directory in the repository.

### 6.5 Zoom (UI Scale)

The Tools tab shows a **Zoom** row below Theme Packs. This setting scales the entire application UI (50–200%).

![Zoom Setting](screenshots/settings-zoom.png)

- Enter a percentage value in the input field (50–200) and press **Enter** or click away to apply
- The zoom level takes effect immediately across all windows
- This is a machine-local setting — it is not synced to other devices via Cloud Sync

> **Note**: This is separate from the per-keyboard zoom in the toolbar (§4.1), which only scales the keymap editor display, and from the **Key Editor Zoom** in the Keycodes Overlay Panel (§3.14), which overrides the window zoom level while in key editor mode. The UI zoom here is the baseline applied on all other screens.

> **Warning**: Changing the zoom level may cause layout issues at extreme values. Use at your own risk.

### 6.6 Launch at Login / Stay in System Tray

The Tools tab shows four toggles below the Theme Packs and Zoom rows:

- **Launch at Login**: Start Pipette automatically when you sign in to the OS. On Windows and macOS this registers a login item; on Linux it manages an XDG autostart entry (`~/.config/autostart/pipette.desktop`). This works in installed (packaged) builds only — the toggle has no effect when running from source.
- **Stay in System Tray**: While ON, closing the window hides Pipette to the system tray and the app keeps running. Click the tray icon, or choose **Show** from its menu, to bring the window back. Hovering the tray icon shows a live tooltip: just `Pipette` when idle, `Pipette — {keyboard name}` once a keyboard is connected, and `Pipette — {keyboard name} — Cnt: X · KPM: Y` while the REC tab (§4.3) is recording. The tray menu itself is **Show**, a separator, the connected keyboard's name (when one is connected) — with **Recording** / **Cnt: N** / **KPM: N** rows added while recording — another separator, then **Quit**. Menu and tooltip labels are fixed English text for now, not translated.
- **Restore Last Session** (default ON): While ON, Pipette remembers the last keyboard you connected and automatically reconnects it the next time the app starts. Toggling this in Settings only affects the *next* launch — it never triggers a reconnect during the current session. Because the screen you were on is already remembered per keyboard, reconnecting also brings back the last screen you used with that keyboard. If the keyboard is not found within about 10 seconds of launch, Pipette gives up silently — no warning is shown, and the device selection screen stays as usual. Disconnecting a keyboard manually clears the remembered device.
- **Start Hidden in Tray**: While ON, Pipette launches resident in the system tray without opening the window. This requires **Stay in System Tray** — the toggle is disabled while Stay in System Tray is OFF, and turning Stay in System Tray OFF also turns this toggle OFF. If a session restore (see above) needs the Unlock dialog, the window appears just for that dialog and hides again once it is resolved. Once you show the window yourself (e.g. from the tray icon), it stays open — Pipette never auto-hides a window you opened.

All four are machine-local settings — they are not synced to other devices via Cloud Sync.

---

## 7. Pipette Hub

[Pipette Hub](https://pipette-hub-worker.keymaps.workers.dev/) is a community keymap gallery where you can upload and share your keyboard configurations and favorite entries.

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
5. A confirmation dialog opens — choose **Public** or **Private** (see *Public vs Private* below), then click **Confirm**

![Upload confirmation dialog](screenshots/hub-upload-confirm.png)

6. After uploading, the entry's Hub row is labelled **Hub (Public)** or **Hub (Private)** and shows **Open in Browser**, **Update**, and **Remove** buttons

![Uploaded](screenshots/hub-04-uploaded.png)

- **Open in Browser**: For a public post, opens its Hub page. For a private post, copies/opens the secret share link.
- **Update**: Opens the same confirmation dialog so you can re-upload **and** switch visibility (see below)
- **Remove**: Removes the post from Hub (the private link stops working immediately)

#### Public vs Private (Unlisted)

Every upload (and every **Update**) opens a confirmation dialog with two choices:

- **Public** — listed and searchable on Hub, just like before.
- **Private (Unlisted)** — reachable only by a secret link; never listed or searchable. When you pick Private you also choose a **link expiry** (1 / 3 / 7 / 30 / 60 / 90 / 180 days; default 7 days). Private links always expire — the maximum is 180 days. The dialog previews the exact expiry date. The private link is stored locally and synced across your devices, so **Open in Browser** can hand it out at any time.

**Switching visibility with Update.** Because a private post has no public page (and vice-versa), switching between Public and Private — or re-uploading a Private post — is performed as *delete + recreate*. This produces a **new share link and expiry**, so the dialog warns you before continuing. A plain Public → Public update keeps the same URL.

> **Note**: Hub uploads include a `.pipette` file alongside the standard export formats, allowing other users to load the full keyboard state directly.

### 7.3 Uploading Favorite Entries

Individual favorite entries (Tap Dance, Macro, Combo, Key Override, Alt Repeat Key) can also be uploaded to Hub:

![Data Modal — Favorites Hub Actions](screenshots/hub-fav-data-modal.png)

1. Open any editor modal with the inline favorites panel, or use the Data modal from the device selection screen
2. In the favorites list, each entry shows an **Upload to Hub** button when Hub is connected
3. Click **Upload to Hub** — the Public / Private confirmation dialog opens (see §7.2 *Public vs Private*)
4. After uploading, the row is labelled **Hub (Public)** or **Hub (Private)** with **Open in Browser**, **Update on Hub**, and **Remove from Hub** buttons (Update re-opens the dialog and can switch visibility)
5. Renaming a favorite that is uploaded to a public Hub post also updates the title on Hub automatically

> **Note**: A Display Name must be set before uploading. If no Display Name is configured, a warning is shown instead of the Upload button.

### 7.4 Uploading Analytics

Saved Analyze conditions can be uploaded to Hub, sharing your typing analytics charts with the community.

**Flow**

1. Open the Analyze page and set up the filters you want to share (keyboard, device, app, date range, keymap snapshot)
2. Save the condition with a label using the **Saved search conditions** panel (bookmark icon)
3. When Hub is connected, a **Hub** action row appears under each saved entry with an **Upload to Hub** button
4. Click **Upload to Hub** — the category-picker modal opens in upload mode (see §1.4 Export / Upload)
5. Select which chart categories to include, pick Layout Comparison targets and Per-app data if desired, then click **Upload**
6. The Public / Private confirmation dialog opens (see §7.2 *Public vs Private*); choose visibility (and, for Private, an expiry) and **Confirm**
7. After uploading, the entry's Hub row is labelled **Hub (Public)** or **Hub (Private)** with **Open in Browser**, **Update on Hub**, and **Remove from Hub** buttons

**Validation rules**

The Hub enforces two guards before accepting an analytics upload:

- **Minimum 100 keystrokes** in the saved range — sub-100-keystroke charts are too sparse to be useful
- **Maximum 30-day range** — longer ranges produce payloads that exceed the Hub size budget

If either rule is violated, a localized error message explains what to fix (e.g., shorten the range or record more typing).

**Upload-mode options**

- **Layout Comparison targets** — pick one or more alternative layouts to include. The Hub post will show how your typing would redistribute across each target. The toggle is disabled when no targets are selected
- **Per-app data** — choose which apps to include as per-app breakdowns. The Hub post renders per-app charts for the selected apps

**Update and Remove**

- **Update on Hub** re-uploads the latest chart data for the same saved condition (useful after more typing has been recorded)
- **Remove from Hub** deletes the analytics post from the Hub server (two-step confirmation)

**Error handling**

Upload errors are localized. Common cases: authentication failure (sign out and back in), payload too large (reduce categories or shorten range), rate limit (wait and retry).

> **Note**: A Display Name must be set before uploading. If no Display Name is configured, a warning is shown instead of the Upload button.

### 7.5 Hub Website

The [Pipette Hub website](https://pipette-hub-worker.keymaps.workers.dev/) displays uploaded keymaps in a gallery format.

![Hub Top Page](screenshots/hub-web-top.png)

- Browse uploaded keymaps from the community
- Search by keyboard name
- Download keymaps as `.vil`, `.c`, or `.pdf` files

#### Individual Keymap Page

Clicking a keymap card opens the detail page with a full keyboard layout visualization.

![Hub Detail Page](screenshots/hub-web-detail.png)

- View all layers (Layer 0–3) of the uploaded keymap
- Review Tap Dance, Macro, Combo, Alt Repeat Key, and Key Override configurations
- **Copy URL** or **Share on X** to share with others
- Download in various formats (`.pdf`, `.c`, `.vil`)

See the [Data Guide](Data.md) for details on how Hub authentication works.

---

## 8. Modal Interactions

Pipette applies a uniform set of keyboard and dismissal rules to every top-level modal (Settings, Data, Macro, QMK Settings, Tap Dance, Combo, Key Override, Alt Repeat Key, Notification, Language Packs, Theme Packs, Language Selector, Layout Store, Editor Settings, Favorite Store, and the History Toggle dialog).

### Escape to Close

Pressing **Escape** closes the modal, with the following exceptions so that Escape never interrupts text entry:

- If the focused element is an `<input>`, `<textarea>`, `<select>`, or anything inside a `contenteditable` region, Escape is ignored (the element receives it instead)
- During an IME composition (e.g., Japanese input), Escape is ignored so the composition can be cancelled without dismissing the modal

### Unlock Dialog Protection

The Unlock Dialog (prompting for a physical key press after a boot-unlock keycode is invoked) **intercepts Escape before it reaches the parent modal**. Pressing Escape on top of an unlock prompt cannot leak through, preventing accidental dismissal of a half-configured Settings or Data modal by rapid Escape presses.

### Escape Suppression During Busy Flows

Escape-to-close is disabled while the containing modal is in a transient state that must complete:

- **Settings / Data modals**: disabled while a sync / troubleshooting flow is running
- **Macro Modal**: disabled while the recorder is actively capturing keystrokes (see §3.7 Recording Lock); the backdrop click and top-right Close button are also inert at the same time

---

## 9. Status Bar

The status bar at the bottom of the screen shows connection information and action buttons.

![Status Bar](screenshots/status-bar.png)

**Status indicators** (left side)

- **Device name**: Shows the name of the connected keyboard
- **Loaded label**: The label of the loaded snapshot (shown only when a snapshot is loaded)
- **Auto Move**: Status of automatic key advancement after assigning a keycode (shown only when enabled)
- **Locked / Unlocked**: Keyboard lock status (prevents accidental changes to dangerous keycodes)
- **Sync status**: Cloud sync status (shown only when sync is configured)
- **Hub connection**: Pipette Hub connection status (shown only when Hub is configured)

**Quick Settings** (right side, shown when a keyboard is connected)

Inline selectors for common per-session preferences. A `|` separator divides them from the mode buttons.

- **Language**: Switch the UI language. Opens a dropdown of built-in languages and installed language packs (see §6.3)
- **Theme**: Switch the color theme. Options include System, Light, Dark, and any installed theme packs (see §6.4)
- **Key Labels**: Switch the key label set for the current keyboard. Options reflect the installed Key Labels store in drag order (see §6.2)
- **Edit / Done**: Toggle edit mode. Replaces the selectors with **Language Packs**, **Theme Packs**, and **Key Labels** management modal buttons for installing, syncing, or reordering entries

**Action buttons** (right side)

- **Key Tester**: Toggle button for Matrix Tester mode (requires matrix tester support; hidden when Typing Test is active)
- **Typing View**: Toggle button to enter view-only mode — a compact window showing only the keyboard layout (see §4.3). Requires matrix tester support; hidden when Typing Test is active
- **Typing Test**: Toggle button for Typing Test mode (requires matrix tester support)
- **Disconnect button**: Disconnects from the keyboard and returns to the device selection screen (hidden while Typing Test is active)
