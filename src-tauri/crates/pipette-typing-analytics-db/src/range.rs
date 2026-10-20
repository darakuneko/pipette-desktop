// SPDX-License-Identifier: GPL-2.0-or-later
//! The range reads: the minute stats, the rollover trend,
//! the Monitor App aggregates, the typing tests and runs, the sessions,
//! the Backspace minutes and the peak records, each over `[since_ms,
//! until_ms)`. `machine_hash` narrows a read to one device; `None` reads
//! every device of the keyboard.
//!
//! The busiest day of the peak records groups by SQLite's `localtime`, so
//! it follows the time zone of the process.

use crate::query::{Params, ScopeFilters, all, first, for_device};
use crate::rows::{
    BksMinuteRow, LongestSession, MinuteStatsRow, NamedTotals, PeakAt, PeakDay, PeakRecords,
    RolloverMinuteRow, SessionRow, TypingTestRun,
};
use crate::{Error, TypingAnalyticsDb, sql};

/// The Monitor App aggregates: one statement whose `@machineHash IS NULL`
/// reads every device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAggregate {
    /// The app names of single-app minutes (`listAppsForUidInRange`).
    Apps,
    /// The typing-test labels (`listTypingTestsForUidInRange`).
    TypingTests,
    /// Every app with an unknown bucket for mixed or unknown minutes
    /// (`getAppUsageForUidInRange`).
    AppUsage,
    /// The apps of single-app minutes with active time
    /// (`getWpmByAppForUidInRange`).
    WpmByApp,
}

impl AppAggregate {
    fn sql(self) -> &'static str {
        match self {
            Self::Apps => sql::SELECT_APPS_FOR_UID_IN_RANGE,
            Self::TypingTests => sql::SELECT_TYPING_TESTS_FOR_UID_IN_RANGE,
            Self::AppUsage => sql::SELECT_APP_USAGE_FOR_UID_IN_RANGE,
            Self::WpmByApp => sql::SELECT_WPM_BY_APP_FOR_UID_IN_RANGE,
        }
    }
}

impl TypingAnalyticsDb {
    /// One row per minute, the scopes sharing it merged, oldest first
    /// (`listMinuteStatsInRangeForUid*`).
    pub fn minute_stats_in_range(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<MinuteStatsRow>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_MINUTE_STATS_IN_RANGE_FOR_UID,
            sql::SELECT_MINUTE_STATS_IN_RANGE_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, MinuteStatsRow::from_row)
    }

    /// The bigram overlap sums per minute, oldest first
    /// (`listRolloverMinutesInRange`).
    pub fn rollover_minutes(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<RolloverMinuteRow>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![
            ("@uid", &uid),
            ("@machineHash", &machine_hash),
            ("@sinceMs", &since_ms),
            ("@untilMs", &until_ms),
        ];
        json.add(&mut params);
        all(&self.conn, sql::SELECT_ROLLOVER_MINUTES, &params, RolloverMinuteRow::from_row)
    }

    /// One of the Monitor App aggregates, by keystrokes, most first.
    pub fn app_aggregate(
        &self,
        aggregate: AppAggregate,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
    ) -> Result<Vec<NamedTotals>, Error> {
        let params: Params<'_> = vec![
            ("@uid", &uid),
            ("@machineHash", &machine_hash),
            ("@sinceMs", &since_ms),
            ("@untilMs", &until_ms),
        ];
        all(&self.conn, aggregate.sql(), &params, NamedTotals::from_row)
    }

    /// The typing-test runs, latest start first, of the given labels (every
    /// label when empty) (`listTypingTestRunsForUidInRange`).
    pub fn typing_test_runs(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        typing_tests: &[String],
    ) -> Result<Vec<TypingTestRun>, Error> {
        let typing_tests = serde_json::to_string(typing_tests)?;
        let params: Params<'_> = vec![
            ("@uid", &uid),
            ("@machineHash", &machine_hash),
            ("@sinceMs", &since_ms),
            ("@untilMs", &until_ms),
            ("@typingTestsJson", &typing_tests),
        ];
        all(&self.conn, sql::SELECT_TYPING_TEST_RUNS_FOR_UID_IN_RANGE, &params, TypingTestRun::from_row)
    }

    /// The sessions that start in the range, oldest first
    /// (`listSessionsInRangeForUid*`).
    pub fn sessions_in_range(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
    ) -> Result<Vec<SessionRow>, Error> {
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_SESSIONS_IN_RANGE_FOR_UID,
            sql::SELECT_SESSIONS_IN_RANGE_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, SessionRow::from_row)
    }

    /// The Backspace presses per minute, minutes without one left out
    /// (`listBksMinuteInRangeForUid*`).
    pub fn backspace_minutes(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<Vec<BksMinuteRow>, Error> {
        let json = filters.json()?;
        let mut params: Params<'_> = vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        json.add(&mut params);
        let sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_BKS_MINUTE_IN_RANGE_FOR_UID,
            sql::SELECT_BKS_MINUTE_IN_RANGE_FOR_UID_AND_HASH,
            &mut params,
        );
        all(&self.conn, sql, &params, BksMinuteRow::from_row)
    }

    /// The peak records (`getPeakRecordsInRangeForUid*`). The filters do not
    /// apply to the longest session: sessions have no app or test tag.
    pub fn peak_records(
        &self,
        uid: &str,
        machine_hash: Option<&str>,
        since_ms: f64,
        until_ms: f64,
        filters: &ScopeFilters,
    ) -> Result<PeakRecords, Error> {
        let json = filters.json()?;
        let mut session_params: Params<'_> =
            vec![("@uid", &uid), ("@sinceMs", &since_ms), ("@untilMs", &until_ms)];
        let session_sql = for_device(
            machine_hash.as_ref(),
            sql::SELECT_LONGEST_SESSION_IN_RANGE_FOR_UID,
            sql::SELECT_LONGEST_SESSION_IN_RANGE_FOR_UID_AND_HASH,
            &mut session_params,
        );
        let mut params = session_params.clone();
        json.add(&mut params);
        let pick = |every: &'static str, one: &'static str| if machine_hash.is_some() { one } else { every };
        Ok(PeakRecords {
            peak_wpm: first(
                &self.conn,
                pick(sql::SELECT_PEAK_WPM_IN_RANGE_FOR_UID, sql::SELECT_PEAK_WPM_IN_RANGE_FOR_UID_AND_HASH),
                &params,
                PeakAt::from_row,
            )?,
            lowest_wpm: first(
                &self.conn,
                pick(
                    sql::SELECT_LOWEST_WPM_IN_RANGE_FOR_UID,
                    sql::SELECT_LOWEST_WPM_IN_RANGE_FOR_UID_AND_HASH,
                ),
                &params,
                PeakAt::from_row,
            )?,
            peak_keystrokes_per_min: first(
                &self.conn,
                pick(sql::SELECT_PEAK_KPM_IN_RANGE_FOR_UID, sql::SELECT_PEAK_KPM_IN_RANGE_FOR_UID_AND_HASH),
                &params,
                PeakAt::from_row,
            )?,
            peak_keystrokes_per_day: first(
                &self.conn,
                pick(sql::SELECT_PEAK_KPD_IN_RANGE_FOR_UID, sql::SELECT_PEAK_KPD_IN_RANGE_FOR_UID_AND_HASH),
                &params,
                PeakDay::from_row,
            )?,
            longest_session: first(&self.conn, session_sql, &session_params, LongestSession::from_row)?,
        })
    }
}
