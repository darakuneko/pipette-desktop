// SPDX-License-Identifier: GPL-2.0-or-later
// Sync > Typing > Device: pulls the day files Drive holds for a remote
// device that are not yet in the local per-day tree.

/** Fetches every cloud day of `(uid, machineHash)` missing locally, one
 * after another. Both listings are UTC days (the cloud listing and the
 * local day files), so they are compared as such; the daily-summary
 * list groups by local calendar day and cannot be used here. A failure is
 * swallowed: the caller then lists what is local. */
export async function fetchMissingRemoteDays(uid: string, machineHash: string): Promise<void> {
  try {
    const [cloudDays, localDays] = await Promise.all([
      window.vialAPI.typingAnalyticsListRemoteCloudDays(uid, machineHash),
      window.vialAPI.typingAnalyticsListLocalDeviceDays(uid, machineHash),
    ])
    const known = new Set(localDays)
    for (const day of cloudDays) {
      if (!known.has(day)) await window.vialAPI.typingAnalyticsFetchRemoteDay(uid, machineHash, day)
    }
  } catch {
    /* network errors surface via the summaries being empty */
  }
}
