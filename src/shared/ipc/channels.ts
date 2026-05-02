// IPC channel name constants — single source of truth
export const IpcChannels = {
  // Device events (main → renderer)
  DEVICE_CONNECTED: 'device:connected',
  DEVICE_DISCONNECTED: 'device:disconnected',

  // File I/O (renderer → main → renderer)
  FILE_SAVE_LAYOUT: 'file:save-layout',
  FILE_LOAD_LAYOUT: 'file:load-layout',
  FILE_EXPORT_KEYMAP_C: 'file:export-keymap-c',
  FILE_EXPORT_PDF: 'file:export-pdf',
  FILE_EXPORT_CSV: 'file:export-csv',
  FILE_EXPORT_CSV_BUNDLE: 'file:export-csv-bundle',
  FILE_EXPORT_JSON: 'file:export-json',

  // Logging (preload → main)
  LOG_ENTRY: 'log:entry',
  LOG_HID_PACKET: 'log:hid-packet',

  // HID transport (preload → main → preload)
  HID_LIST_DEVICES: 'hid:listDevices',
  HID_OPEN_DEVICE: 'hid:openDevice',
  HID_CLOSE_DEVICE: 'hid:closeDevice',
  HID_SEND_RECEIVE: 'hid:sendReceive',
  HID_SEND: 'hid:send',
  HID_IS_DEVICE_OPEN: 'hid:isDeviceOpen',
  HID_PROBE_DEVICE: 'hid:probeDevice',

  // LZMA decompression (preload → main → preload)
  LZMA_DECOMPRESS: 'lzma:decompress',

  // Snapshot Store (renderer → main → renderer)
  SNAPSHOT_STORE_LIST: 'snapshot-store:list',
  SNAPSHOT_STORE_SAVE: 'snapshot-store:save',
  SNAPSHOT_STORE_LOAD: 'snapshot-store:load',
  SNAPSHOT_STORE_UPDATE: 'snapshot-store:update',
  SNAPSHOT_STORE_RENAME: 'snapshot-store:rename',
  SNAPSHOT_STORE_DELETE: 'snapshot-store:delete',

  // Analyze Filter Store (renderer → main → renderer)
  ANALYZE_FILTER_STORE_LIST: 'analyze-filter-store:list',
  ANALYZE_FILTER_STORE_SAVE: 'analyze-filter-store:save',
  ANALYZE_FILTER_STORE_LOAD: 'analyze-filter-store:load',
  ANALYZE_FILTER_STORE_UPDATE: 'analyze-filter-store:update',
  ANALYZE_FILTER_STORE_RENAME: 'analyze-filter-store:rename',
  ANALYZE_FILTER_STORE_DELETE: 'analyze-filter-store:delete',

  // Sideload JSON (renderer → main → renderer)
  SIDELOAD_JSON: 'dialog:sideload-json',

  // Favorite Store (renderer → main → renderer)
  FAVORITE_STORE_LIST: 'favorite-store:list',
  FAVORITE_STORE_SAVE: 'favorite-store:save',
  FAVORITE_STORE_LOAD: 'favorite-store:load',
  FAVORITE_STORE_RENAME: 'favorite-store:rename',
  FAVORITE_STORE_DELETE: 'favorite-store:delete',
  FAVORITE_STORE_EXPORT: 'favorite-store:export',
  FAVORITE_STORE_EXPORT_CURRENT: 'favorite-store:export-current',
  FAVORITE_STORE_IMPORT: 'favorite-store:import',
  FAVORITE_STORE_IMPORT_TO_CURRENT: 'favorite-store:import-to-current',

  // App Config (renderer ↔ main)
  APP_CONFIG_GET_ALL: 'app-config:get-all',
  APP_CONFIG_SET: 'app-config:set',

  // Sync (renderer ↔ main)
  SYNC_AUTH_START: 'sync:auth-start',
  SYNC_AUTH_STATUS: 'sync:auth-status',
  SYNC_AUTH_SIGN_OUT: 'sync:auth-sign-out',
  SYNC_EXECUTE: 'sync:execute',
  SYNC_SET_PASSWORD: 'sync:set-password',
  SYNC_CHANGE_PASSWORD: 'sync:change-password',
  SYNC_HAS_PASSWORD: 'sync:has-password',
  SYNC_VALIDATE_PASSWORD: 'sync:validate-password',
  SYNC_RESET_TARGETS: 'sync:reset-targets',
  SYNC_NOTIFY_CHANGE: 'sync:notify-change',
  SYNC_PROGRESS: 'sync:progress',
  SYNC_PENDING_STATUS: 'sync:pending-status',
  SYNC_LIST_UNDECRYPTABLE: 'sync:list-undecryptable',
  SYNC_SCAN_REMOTE: 'sync:scan-remote',
  SYNC_FETCH_REMOTE_BUNDLE: 'sync:fetch-remote-bundle',
  SYNC_DELETE_FILES: 'sync:delete-files',
  SYNC_CHECK_PASSWORD_EXISTS: 'sync:check-password-exists',
  SYNC_ANALYTICS_NOW: 'sync:analytics-now',

  // Pipette Settings Store (renderer → main → renderer)
  PIPETTE_SETTINGS_GET: 'pipette-settings:get',
  PIPETTE_SETTINGS_SET: 'pipette-settings:set',

  // Typing Analytics (renderer ↔ main)
  TYPING_ANALYTICS_EVENT: 'typing-analytics:event',
  TYPING_ANALYTICS_FLUSH: 'typing-analytics:flush',
  TYPING_ANALYTICS_LIST_KEYBOARDS: 'typing-analytics:list-keyboards',
  TYPING_ANALYTICS_LIST_ITEMS: 'typing-analytics:list-items',
  TYPING_ANALYTICS_LIST_INTERVAL_ITEMS: 'typing-analytics:list-interval-items',
  TYPING_ANALYTICS_LIST_ACTIVITY_GRID: 'typing-analytics:list-activity-grid',
  TYPING_ANALYTICS_LIST_LAYER_USAGE: 'typing-analytics:list-layer-usage',
  TYPING_ANALYTICS_LIST_MATRIX_CELLS: 'typing-analytics:list-matrix-cells',
  TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY: 'typing-analytics:list-matrix-cells-by-day',
  TYPING_ANALYTICS_LIST_MINUTE_STATS: 'typing-analytics:list-minute-stats',
  TYPING_ANALYTICS_LIST_SESSIONS: 'typing-analytics:list-sessions',
  TYPING_ANALYTICS_LIST_BKS_MINUTE: 'typing-analytics:list-bks-minute',
  TYPING_ANALYTICS_DELETE_ITEMS: 'typing-analytics:delete-items',
  TYPING_ANALYTICS_DELETE_ALL: 'typing-analytics:delete-all',
  TYPING_ANALYTICS_GET_MATRIX_HEATMAP: 'typing-analytics:get-matrix-heatmap',
  // v7 Local/Sync split — hash-scoped list and delete
  TYPING_ANALYTICS_LIST_ITEMS_LOCAL: 'typing-analytics:list-items-local',
  TYPING_ANALYTICS_LIST_INTERVAL_ITEMS_LOCAL: 'typing-analytics:list-interval-items-local',
  TYPING_ANALYTICS_LIST_ACTIVITY_GRID_LOCAL: 'typing-analytics:list-activity-grid-local',
  TYPING_ANALYTICS_LIST_LAYER_USAGE_LOCAL: 'typing-analytics:list-layer-usage-local',
  TYPING_ANALYTICS_LIST_MATRIX_CELLS_LOCAL: 'typing-analytics:list-matrix-cells-local',
  TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY_LOCAL: 'typing-analytics:list-matrix-cells-by-day-local',
  TYPING_ANALYTICS_LIST_MINUTE_STATS_LOCAL: 'typing-analytics:list-minute-stats-local',
  TYPING_ANALYTICS_LIST_SESSIONS_LOCAL: 'typing-analytics:list-sessions-local',
  TYPING_ANALYTICS_LIST_BKS_MINUTE_LOCAL: 'typing-analytics:list-bks-minute-local',
  TYPING_ANALYTICS_GET_PEAK_RECORDS: 'typing-analytics:get-peak-records',
  TYPING_ANALYTICS_GET_PEAK_RECORDS_LOCAL: 'typing-analytics:get-peak-records-local',
  TYPING_ANALYTICS_SAVE_KEYMAP_SNAPSHOT: 'typing-analytics:save-keymap-snapshot',
  TYPING_ANALYTICS_GET_KEYMAP_SNAPSHOT_FOR_RANGE: 'typing-analytics:get-keymap-snapshot-for-range',
  TYPING_ANALYTICS_LIST_KEYMAP_SNAPSHOTS: 'typing-analytics:list-keymap-snapshots',
  TYPING_ANALYTICS_GET_MATRIX_HEATMAP_FOR_RANGE: 'typing-analytics:get-matrix-heatmap-for-range',
  TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE: 'typing-analytics:get-bigram-aggregate-for-range',
  TYPING_ANALYTICS_GET_LAYOUT_COMPARISON_FOR_RANGE: 'typing-analytics:get-layout-comparison-for-range',
  TYPING_ANALYTICS_LIST_DEVICE_INFOS: 'typing-analytics:list-device-infos',
  TYPING_ANALYTICS_LIST_ITEMS_FOR_HASH: 'typing-analytics:list-items-for-hash',
  // Per-hash variants used by the Analyze Device select when scoping
  // to a specific remote machine hash. `*Local` is own-hash only, `*`
  // is all-hash merged; these fill in "pick one remote hash".
  TYPING_ANALYTICS_LIST_INTERVAL_ITEMS_FOR_HASH: 'typing-analytics:list-interval-items-for-hash',
  TYPING_ANALYTICS_LIST_ACTIVITY_GRID_FOR_HASH: 'typing-analytics:list-activity-grid-for-hash',
  TYPING_ANALYTICS_LIST_LAYER_USAGE_FOR_HASH: 'typing-analytics:list-layer-usage-for-hash',
  TYPING_ANALYTICS_LIST_MATRIX_CELLS_FOR_HASH: 'typing-analytics:list-matrix-cells-for-hash',
  TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY_FOR_HASH: 'typing-analytics:list-matrix-cells-by-day-for-hash',
  TYPING_ANALYTICS_LIST_MINUTE_STATS_FOR_HASH: 'typing-analytics:list-minute-stats-for-hash',
  TYPING_ANALYTICS_LIST_SESSIONS_FOR_HASH: 'typing-analytics:list-sessions-for-hash',
  TYPING_ANALYTICS_LIST_BKS_MINUTE_FOR_HASH: 'typing-analytics:list-bks-minute-for-hash',
  TYPING_ANALYTICS_GET_PEAK_RECORDS_FOR_HASH: 'typing-analytics:get-peak-records-for-hash',
  TYPING_ANALYTICS_LIST_LOCAL_DEVICE_DAYS: 'typing-analytics:list-local-device-days',
  TYPING_ANALYTICS_HAS_REMOTE: 'typing-analytics:has-remote',
  TYPING_ANALYTICS_LIST_REMOTE_CLOUD_HASHES: 'typing-analytics:list-remote-cloud-hashes',
  TYPING_ANALYTICS_LIST_REMOTE_CLOUD_DAYS: 'typing-analytics:list-remote-cloud-days',
  TYPING_ANALYTICS_FETCH_REMOTE_DAY: 'typing-analytics:fetch-remote-day',
  TYPING_ANALYTICS_DELETE_REMOTE_DAY: 'typing-analytics:delete-remote-day',
  TYPING_ANALYTICS_EXPORT: 'typing-analytics:export',
  TYPING_ANALYTICS_IMPORT: 'typing-analytics:import',
  /** Distinct app_name list (with keystroke totals) for the analyze
   * range. Drives the App selector dropdown — selected values are
   * collected into the `appScopes` array passed to every per-app-aware
   * range query. */
  TYPING_ANALYTICS_LIST_APPS_FOR_RANGE: 'typing-analytics:list-apps-for-range',
  /** Per-app keystroke / activeMs aggregate over the analyze range.
   * Backs the App Usage Distribution pie chart. */
  TYPING_ANALYTICS_GET_APP_USAGE_FOR_RANGE: 'typing-analytics:get-app-usage-for-range',
  /** Per-app WPM aggregate (mean over single-app minutes) over the
   * analyze range. Backs the "WPM by App" bar chart. */
  TYPING_ANALYTICS_GET_WPM_BY_APP_FOR_RANGE: 'typing-analytics:get-wpm-by-app-for-range',

  // Language Store (renderer → main → renderer)
  LANG_LIST: 'lang:list',
  LANG_GET: 'lang:get',
  LANG_DOWNLOAD: 'lang:download',
  LANG_DELETE: 'lang:delete',

  // Data management (renderer → main → renderer)
  LIST_STORED_KEYBOARDS: 'data:list-stored-keyboards',
  RESET_KEYBOARD_DATA: 'data:reset-keyboard',
  RESET_LOCAL_TARGETS: 'data:reset-local-targets',
  EXPORT_LOCAL_DATA: 'data:export-local',
  IMPORT_LOCAL_DATA: 'data:import-local',

  // Hub (renderer → main → renderer)
  HUB_UPLOAD_POST: 'hub:upload-post',
  HUB_UPDATE_POST: 'hub:update-post',
  HUB_PATCH_POST: 'hub:patch-post',
  HUB_DELETE_POST: 'hub:delete-post',
  HUB_FETCH_MY_POSTS: 'hub:fetch-my-posts',
  HUB_FETCH_AUTH_ME: 'hub:fetch-auth-me',
  HUB_PATCH_AUTH_ME: 'hub:patch-auth-me',
  HUB_GET_ORIGIN: 'hub:get-origin',
  HUB_FETCH_MY_KEYBOARD_POSTS: 'hub:fetch-my-keyboard-posts',
  HUB_SET_AUTH_DISPLAY_NAME: 'hub:set-auth-display-name',

  // Shell (renderer → main)
  SHELL_OPEN_EXTERNAL: 'shell:open-external',

  // Notification (renderer → main → renderer)
  NOTIFICATION_FETCH: 'notification:fetch',

  // Snapshot Store extensions
  SNAPSHOT_STORE_SET_HUB_POST_ID: 'snapshot-store:set-hub-post-id',

  // Hub Feature posts (favorites)
  HUB_UPLOAD_FAVORITE_POST: 'hub:upload-favorite-post',
  HUB_UPDATE_FAVORITE_POST: 'hub:update-favorite-post',

  // Favorite Store extensions
  FAVORITE_STORE_SET_HUB_POST_ID: 'favorite-store:set-hub-post-id',

  // Key Label Store (renderer → main → renderer)
  KEY_LABEL_STORE_LIST: 'key-label-store:list',
  KEY_LABEL_STORE_LIST_ALL: 'key-label-store:list-all',
  KEY_LABEL_STORE_GET: 'key-label-store:get',
  KEY_LABEL_STORE_RENAME: 'key-label-store:rename',
  KEY_LABEL_STORE_DELETE: 'key-label-store:delete',
  KEY_LABEL_STORE_IMPORT: 'key-label-store:import',
  KEY_LABEL_STORE_EXPORT: 'key-label-store:export',
  KEY_LABEL_STORE_REORDER: 'key-label-store:reorder',
  KEY_LABEL_STORE_SET_HUB_POST_ID: 'key-label-store:set-hub-post-id',
  KEY_LABEL_STORE_HAS_NAME: 'key-label-store:has-name',

  // Key Label Hub (renderer → main → renderer) [filled in T3]
  KEY_LABEL_HUB_LIST: 'key-label-hub:list',
  KEY_LABEL_HUB_DETAIL: 'key-label-hub:detail',
  KEY_LABEL_HUB_DOWNLOAD: 'key-label-hub:download',
  KEY_LABEL_HUB_UPLOAD: 'key-label-hub:upload',
  KEY_LABEL_HUB_UPDATE: 'key-label-hub:update',
  KEY_LABEL_HUB_DELETE: 'key-label-hub:delete',

  // Window management (renderer → main)
  WINDOW_SET_COMPACT_MODE: 'window:set-compact-mode',
  WINDOW_SET_ASPECT_RATIO: 'window:set-aspect-ratio',
  WINDOW_SET_ALWAYS_ON_TOP: 'window:set-always-on-top',
  WINDOW_SET_MIN_SIZE: 'window:set-min-size',
  WINDOW_IS_ALWAYS_ON_TOP_SUPPORTED: 'window:is-always-on-top-supported',
} as const
