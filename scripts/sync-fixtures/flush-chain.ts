// SPDX-License-Identifier: GPL-2.0-or-later
// Waits for the typing analytics' flush chain to drain, for the generators
// that read a userData tree after sync code ran. A merge of this device's
// own deleted-ranges unit, and the apply queued at the end of a pass,
// write `deleted-ranges-applied.json` in a flush-chain task the sync code
// does not await (typing-deleted-ranges-merge.ts); a tree read before that
// task ends can catch the write's temporary file. The queued apply reads
// the ranges files before it joins the chain, so the drain is repeated a
// few times with a short wait between.

export async function settleFlushChain(): Promise<void> {
  // Imported here, so the module mocks of the calling test file apply.
  const { runOnFlushChain } = await import('../../src/main/typing-analytics/typing-analytics-pipeline')
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await runOnFlushChain(() => undefined)
  }
}
