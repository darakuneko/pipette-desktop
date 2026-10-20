// The names of the events the app sends to the page. The Rust side defines
// the same strings: src-tauri/src/events.rs (sync and packs),
// src-tauri/src/main_window.rs (window visibility) and
// src-tauri/src/updater.rs (update progress).
export const IpcChannels = {
  // Sync
  SYNC_PROGRESS: 'sync:progress',
  SYNC_PENDING_STATUS: 'sync:pending-status',
  SYNC_FORMAT_STATUS_CHANGED: 'sync:format-status-changed',
  SYNC_UNIT_APPLIED: 'sync:unit-applied',

  // Language and theme packs
  I18N_PACK_CHANGED: 'i18n-pack:changed',
  THEME_PACK_CHANGED: 'theme-pack:changed',

  // Window visibility
  WINDOW_VISIBILITY_CHANGED: 'window:visibility-changed',

  // In-app update
  UPDATE_PROGRESS: 'update:progress',
} as const
