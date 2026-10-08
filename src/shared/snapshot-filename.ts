// SPDX-License-Identifier: GPL-2.0-or-later
// Snapshot file names. Every snapshot of one keyboard shares a folder that
// sync merges across PCs, so the name carries the entry id: two snapshots
// saved in the same millisecond with the same device name (on one PC or on
// two) never share a file. Names written without the id
// (`${deviceName}_${timestamp}.pipette`) stay valid as they are.

import { truncateUtf8NamePart, utf8ByteLength } from './utils/utf8-truncate'

const SNAPSHOT_FILE_EXTENSION = '.pipette'

/** UTF-8 bytes the device name may take in a snapshot filename. The rest
 *  (`_` + timestamp + `_` + id + `.pipette`, about 70 bytes) keeps the
 *  whole name within `MAX_BODY_FILENAME_BYTES` (`entry-clocks.ts`). */
export const MAX_SNAPSHOT_DEVICE_NAME_BYTES = 120

/** `safeDeviceName` cut to `MAX_SNAPSHOT_DEVICE_NAME_BYTES` between code
 *  points, without the `_` / `.` / spaces the cut leaves at its end, or
 *  `'keyboard'` when nothing is left. A name within the limit is returned
 *  as it is. */
export function capSnapshotDeviceName(safeDeviceName: string): string {
  if (utf8ByteLength(safeDeviceName) <= MAX_SNAPSHOT_DEVICE_NAME_BYTES) return safeDeviceName
  return truncateUtf8NamePart(safeDeviceName, MAX_SNAPSHOT_DEVICE_NAME_BYTES) || 'keyboard'
}

/** `${safeDeviceName}_${timestamp}_${id}.pipette`, the device name capped
 *  by `capSnapshotDeviceName`. The device name comes first and the
 *  timestamp second so `extractDeviceNameFromFilename` (`keyboard-meta.ts`)
 *  reads both this form and the one without the id. */
export function buildSnapshotFilename(safeDeviceName: string, timestamp: string, id: string): string {
  return `${capSnapshotDeviceName(safeDeviceName)}_${timestamp}_${id}${SNAPSHOT_FILE_EXTENSION}`
}

/** The file name shown for a snapshot with no label: the stored name
 *  without the `_${id}` part, which means nothing to the user. A name
 *  without the id is returned as it is. */
export function snapshotFilenameForDisplay(filename: string, id: string): string {
  const idSuffix = `_${id}${SNAPSHOT_FILE_EXTENSION}`
  if (!id || !filename.endsWith(idSuffix)) return filename
  return `${filename.slice(0, -idSuffix.length)}${SNAPSHOT_FILE_EXTENSION}`
}
