// SPDX-License-Identifier: GPL-2.0-or-later
//! The n-gram range reads (`selectInRangeForUid*` of ngram-statements.ts,
//! `listNgramMinutesInRangeForUid*`): one row per (scope, minute, n-gram),
//! ordered by n-gram id and minute, the histogram decoded.

use crate::query::{Params, ScopeFilters, all, for_device};
use crate::rows::NgramMinuteCellRow;
use crate::{Error, TypingAnalyticsDb, sql};

/// Which n-gram table a read uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gram {
    /// `typing_bigram_minute`, which also has the overlap columns.
    Bigram,
    /// `typing_trigram_minute`.
    Trigram,
}

impl TypingAnalyticsDb {
    pub fn ngram_minutes_in_range(
        &self,
        gram: Gram,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<NgramMinuteCellRow>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let (every, one) = match gram {
            Gram::Bigram => {
                (sql::BIGRAM_SELECT_IN_RANGE_FOR_UID, sql::BIGRAM_SELECT_IN_RANGE_FOR_UID_AND_HASH)
            }
            Gram::Trigram => {
                (sql::TRIGRAM_SELECT_IN_RANGE_FOR_UID, sql::TRIGRAM_SELECT_IN_RANGE_FOR_UID_AND_HASH)
            }
        };
        let sql = for_device(machine_hash.as_ref(), every, one, &mut params);
        all(&self.conn, sql, &params, |row| NgramMinuteCellRow::from_row(row, gram == Gram::Bigram))
    }
}
