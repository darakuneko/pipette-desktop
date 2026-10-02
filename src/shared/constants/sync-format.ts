// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Version of the cloud sync format this app reads and writes. Every sync
 * pass leaves a `sync-format-v{n}.json` marker on Google Drive, and an app
 * stops syncing when Drive holds a marker with a larger `n` than this.
 *
 * Bump it only for a change that would break syncing for older apps (they
 * would misread or overwrite the new data). It is separate from the app
 * version: most releases keep the same value.
 */
export const SYNC_FORMAT_VERSION = 1
