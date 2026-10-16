// SPDX-License-Identifier: GPL-2.0-or-later
//! The units of a flush or a poll pass, a few at a time
//! (`settlePackIndexUnitsFirst` with `pLimit(SYNC_CONCURRENCY)`).

use std::future::Future;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;

use crate::units::pack_index_units_first;

/// Runs `work` on each of `items`, `concurrency` at a time, the pack
/// rosters to the end before the other units; the results in the order
/// they ended. `unit_of` names the unit of an item.
pub(crate) async fn rosters_first<T, R, Fut>(
    items: Vec<T>,
    unit_of: impl Fn(&T) -> &str,
    concurrency: usize,
    work: impl Fn(T) -> Fut,
) -> Vec<R>
where
    Fut: Future<Output = R>,
{
    let (rosters, rest) = pack_index_units_first(items, unit_of);
    let mut results = Vec::new();
    for group in [rosters, rest] {
        let mut waiting = group.into_iter();
        let mut running = FuturesUnordered::new();
        loop {
            while running.len() < concurrency.max(1) {
                let Some(item) = waiting.next() else { break };
                running.push(work(item));
            }
            let Some(result) = running.next().await else { break };
            results.push(result);
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_rosters_run_to_the_end_first() {
        let items = vec!["themes/packs/t1", "i18n/index", "favorites/macro", "themes/index"];
        let done = rosters_first(items, |unit| unit, 1, |unit| async move { unit }).await;
        assert_eq!(done, ["i18n/index", "themes/index", "themes/packs/t1", "favorites/macro"]);
    }
}
