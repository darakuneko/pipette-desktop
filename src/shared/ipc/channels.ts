// IPC channel name constants — single source of truth
export const IpcChannels = {
  // LZMA decompression
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

  // Favorite Store (renderer → main → renderer)
  FAVORITE_STORE_LIST: 'favorite-store:list',
  FAVORITE_STORE_SAVE: 'favorite-store:save',
  FAVORITE_STORE_LOAD: 'favorite-store:load',
  FAVORITE_STORE_RENAME: 'favorite-store:rename',
  FAVORITE_STORE_DELETE: 'favorite-store:delete',
  FAVORITE_STORE_EXPORT: 'favorite-store:export',
  FAVORITE_STORE_IMPORT: 'favorite-store:import',

  // App Config (renderer ↔ main)
  APP_CONFIG_SET: 'app-config:set',

  // Sync (renderer ↔ main)
  SYNC_EXECUTE: 'sync:execute',
  SYNC_RESET_TARGETS: 'sync:reset-targets',
  SYNC_PROGRESS: 'sync:progress',
  SYNC_PENDING_STATUS: 'sync:pending-status',
  SYNC_SCAN_REMOTE: 'sync:scan-remote',
  SYNC_FETCH_REMOTE_BUNDLE: 'sync:fetch-remote-bundle',
  SYNC_DELETE_FILES: 'sync:delete-files',
  SYNC_LIST_TRASH: 'sync:list-trash',
  SYNC_RESTORE_TRASH: 'sync:restore-trash',
  SYNC_DELETE_TRASH: 'sync:delete-trash',
  SYNC_ANALYTICS_NOW: 'sync:analytics-now',
  SYNC_FORMAT_STATUS: 'sync:format-status',
  SYNC_FORMAT_STATUS_CHANGED: 'sync:format-status-changed',
  SYNC_UNIT_APPLIED: 'sync:unit-applied',

  // Typing Analytics (renderer ↔ main)
  TYPING_ANALYTICS_IMPORT: 'typing-analytics:import',
  /** Per-minute Σoverlap_count / Σoverlap_n for the Analyze rollover
   * trend chart. Single-variant channel — `DeviceScope` is
   * passed as a parameter and resolved main-side rather than fanning
   * out to `*Local`/`*ForHash` siblings. */
  TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES: 'typing-analytics:list-rollover-minutes',
  /** Per-(row,col,layer) keypress-duration totals for the Analyze
   * duration distribution chart and the Heatmap duration mode.
   * Single-variant channel, same shape as
   * TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES — `DeviceScope` is resolved
   * main-side. Layer filtering happens renderer-side (a `layer` arg
   * could be added later if per-cell row counts ever warrant server-side
   * narrowing). */
  TYPING_ANALYTICS_LIST_DURATION_CELLS: 'typing-analytics:list-duration-cells',

  // Typing Run Log Store — per-run raw keystroke log (renderer → main → renderer)
  TYPING_RUN_LOG_SAVE: 'typing-run-log:save',
  TYPING_RUN_LOG_LIST: 'typing-run-log:list',
  TYPING_RUN_LOG_GET: 'typing-run-log:get',

  // Typing Test Text Store (renderer → main → renderer)
  TYPING_TEST_TEXT_LIST: 'typing-test-text:list',
  TYPING_TEST_TEXT_GET: 'typing-test-text:get',
  TYPING_TEST_TEXT_IMPORT: 'typing-test-text:import',
  TYPING_TEST_TEXT_IMPORT_CONFIRM: 'typing-test-text:import-confirm',

  // Language Store (renderer → main → renderer)
  LANG_LIST: 'lang:list',
  LANG_GET: 'lang:get',
  LANG_DOWNLOAD: 'lang:download',
  LANG_DELETE: 'lang:delete',
  TYPING_DATASET_CHECK: 'typing-dataset:check',
  TYPING_DATASET_UPDATE: 'typing-dataset:update',

  // Aozora Bunko catalog import (renderer → main → renderer)
  AOZORA_IMPORT: 'aozora:import',

  // Data management (renderer → main → renderer)
  LIST_STORED_KEYBOARDS: 'data:list-stored-keyboards',
  // Record a keyboard's display name on connect, only when it has none yet.
  KEYBOARD_META_NAME_IF_MISSING: 'data:keyboard-meta-name-if-missing',
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
  SNAPSHOT_STORE_SET_HUB_PRIVATE: 'snapshot-store:set-hub-private',

  // Hub Feature posts (favorites)
  HUB_UPLOAD_FAVORITE_POST: 'hub:upload-favorite-post',
  HUB_UPDATE_FAVORITE_POST: 'hub:update-favorite-post',

  // Hub Analytics posts
  HUB_UPLOAD_ANALYTICS_POST: 'hub:upload-analytics-post',
  HUB_UPDATE_ANALYTICS_POST: 'hub:update-analytics-post',
  HUB_PREVIEW_ANALYTICS_POST: 'hub:preview-analytics-post',

  // Hub Private (unlisted) uploads
  HUB_UPLOAD_PRIVATE_POST: 'hub:upload-private-post',
  HUB_UPLOAD_PRIVATE_FAVORITE_POST: 'hub:upload-private-favorite-post',
  HUB_UPLOAD_PRIVATE_ANALYTICS_POST: 'hub:upload-private-analytics-post',
  HUB_DELETE_PRIVATE_POST: 'hub:delete-private-post',

  // i18n language pack store (renderer ↔ main)
  I18N_PACK_STORE_LIST: 'i18n-pack-store:list',
  I18N_PACK_STORE_GET: 'i18n-pack-store:get',
  I18N_PACK_STORE_RENAME: 'i18n-pack-store:rename',
  I18N_PACK_STORE_SET_ENABLED: 'i18n-pack-store:set-enabled',
  I18N_PACK_STORE_REFRESH_COVERAGE: 'i18n-pack-store:refresh-coverage',
  I18N_PACK_STORE_DELETE: 'i18n-pack-store:delete',
  I18N_PACK_STORE_SET_HUB_POST_ID: 'i18n-pack-store:set-hub-post-id',
  I18N_PACK_STORE_HAS_NAME: 'i18n-pack-store:has-name',
  I18N_PACK_STORE_REORDER: 'i18n-pack-store:reorder',
  I18N_PACK_IMPORT: 'i18n-pack:import',
  I18N_PACK_IMPORT_APPLY: 'i18n-pack:import-apply',
  I18N_PACK_EXPORT: 'i18n-pack:export',
  I18N_PACK_CHANGED: 'i18n-pack:changed',

  // Hub i18n posts (renderer → main → renderer)
  HUB_LIST_I18N_POSTS: 'hub:list-i18n-posts',
  HUB_DOWNLOAD_I18N_POST: 'hub:download-i18n-post',
  HUB_UPLOAD_I18N_POST: 'hub:upload-i18n-post',
  HUB_UPDATE_I18N_POST: 'hub:update-i18n-post',
  HUB_DELETE_I18N_POST: 'hub:delete-i18n-post',
  HUB_I18N_PACK_TIMESTAMPS: 'hub:i18n-pack-timestamps',

  // Favorite Store extensions
  FAVORITE_STORE_SET_HUB_POST_ID: 'favorite-store:set-hub-post-id',
  FAVORITE_STORE_SET_HUB_PRIVATE: 'favorite-store:set-hub-private',

  // Analyze Filter Store extensions
  ANALYZE_FILTER_STORE_SET_HUB_POST_ID: 'analyze-filter-store:set-hub-post-id',
  ANALYZE_FILTER_STORE_SET_HUB_PRIVATE: 'analyze-filter-store:set-hub-private',

  // Key Label Store (renderer → main → renderer)
  KEY_LABEL_STORE_LIST: 'key-label-store:list',
  KEY_LABEL_STORE_GET: 'key-label-store:get',
  KEY_LABEL_STORE_IMPORT: 'key-label-store:import',
  KEY_LABEL_STORE_REORDER: 'key-label-store:reorder',

  // Key Label Hub (renderer → main → renderer) [filled in T3]
  KEY_LABEL_HUB_LIST: 'key-label-hub:list',
  KEY_LABEL_HUB_DETAIL: 'key-label-hub:detail',
  KEY_LABEL_HUB_DOWNLOAD: 'key-label-hub:download',
  KEY_LABEL_HUB_UPLOAD: 'key-label-hub:upload',
  KEY_LABEL_HUB_UPDATE: 'key-label-hub:update',
  KEY_LABEL_HUB_SYNC: 'key-label-hub:sync',
  KEY_LABEL_HUB_TIMESTAMPS: 'key-label-hub:timestamps',
  KEY_LABEL_HUB_DELETE: 'key-label-hub:delete',

  // Theme Pack Store (renderer ↔ main)
  THEME_PACK_STORE_LIST: 'theme-pack-store:list',
  THEME_PACK_STORE_GET: 'theme-pack-store:get',
  THEME_PACK_STORE_RENAME: 'theme-pack-store:rename',
  THEME_PACK_STORE_DELETE: 'theme-pack-store:delete',
  THEME_PACK_STORE_SET_HUB_POST_ID: 'theme-pack-store:set-hub-post-id',
  THEME_PACK_STORE_HAS_NAME: 'theme-pack-store:has-name',
  THEME_PACK_STORE_REORDER: 'theme-pack-store:reorder',
  THEME_PACK_IMPORT: 'theme-pack:import',
  THEME_PACK_IMPORT_APPLY: 'theme-pack:import-apply',
  THEME_PACK_EXPORT: 'theme-pack:export',
  THEME_PACK_CHANGED: 'theme-pack:changed',

  // Hub theme posts (renderer → main → renderer)
  HUB_LIST_THEME_POSTS: 'hub:list-theme-posts',
  HUB_DOWNLOAD_THEME_POST: 'hub:download-theme-post',
  HUB_UPLOAD_THEME_POST: 'hub:upload-theme-post',
  HUB_UPDATE_THEME_POST: 'hub:update-theme-post',
  HUB_DELETE_THEME_POST: 'hub:delete-theme-post',
  HUB_THEME_PACK_TIMESTAMPS: 'hub:theme-pack-timestamps',

  // Window management (renderer → main)
  WINDOW_SET_COMPACT_MODE: 'window:set-compact-mode',
  WINDOW_SET_ASPECT_RATIO: 'window:set-aspect-ratio',
  WINDOW_SET_ALWAYS_ON_TOP: 'window:set-always-on-top',
  WINDOW_SET_OPACITY: 'window:set-opacity',
  WINDOW_SET_MIN_SIZE: 'window:set-min-size',
  WINDOW_IS_ALWAYS_ON_TOP_SUPPORTED: 'window:is-always-on-top-supported',
  WINDOW_SHOW: 'window:show',
  WINDOW_HIDE: 'window:hide',
  WINDOW_STARTED_HIDDEN: 'window:started-hidden',
  WINDOW_IS_VISIBLE: 'window:is-visible',

  // Window visibility (main → renderer)
  WINDOW_VISIBILITY_CHANGED: 'window:visibility-changed',

  // Tray status (renderer → main)
  TRAY_STATUS_UPDATE: 'tray:status-update',

  // In-app update (main → renderer; the Tauri build only)
  UPDATE_PROGRESS: 'update:progress',
} as const
