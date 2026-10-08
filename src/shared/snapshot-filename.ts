// SPDX-License-Identifier: GPL-2.0-or-later
// Snapshot file names. Every snapshot of one keyboard shares a folder that
// sync merges across PCs, so the name carries the entry id: two snapshots
// saved in the same millisecond with the same device name (on one PC or on
// two) never share a file. Names written without the id
// (`${deviceName}_${timestamp}.pipette`) stay valid as they are.

const SNAPSHOT_FILE_EXTENSION = '.pipette'

/** `${safeDeviceName}_${timestamp}_${id}.pipette`. The device name comes
 *  first and the timestamp second so `extractDeviceNameFromFilename`
 *  (`keyboard-meta.ts`) reads both this form and the one without the id. */
export function buildSnapshotFilename(safeDeviceName: string, timestamp: string, id: string): string {
  return `${safeDeviceName}_${timestamp}_${id}${SNAPSHOT_FILE_EXTENSION}`
}

/** The file name shown for a snapshot with no label: the stored name
 *  without the `_${id}` part, which means nothing to the user. A name
 *  without the id is returned as it is. */
export function snapshotFilenameForDisplay(filename: string, id: string): string {
  const idSuffix = `_${id}${SNAPSHOT_FILE_EXTENSION}`
  if (!id || !filename.endsWith(idSuffix)) return filename
  return `${filename.slice(0, -idSuffix.length)}${SNAPSHOT_FILE_EXTENSION}`
}
