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

  // Pipette Settings Store (renderer → main → renderer)
  PIPETTE_SETTINGS_GET: 'pipette-settings:get',
  PIPETTE_SETTINGS_SET: 'pipette-settings:set',

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

  // Window management (renderer → main)
  WINDOW_SET_COMPACT_MODE: 'window:set-compact-mode',
  WINDOW_SET_ASPECT_RATIO: 'window:set-aspect-ratio',
  WINDOW_SET_ALWAYS_ON_TOP: 'window:set-always-on-top',
  WINDOW_IS_ALWAYS_ON_TOP_SUPPORTED: 'window:is-always-on-top-supported',
} as const
