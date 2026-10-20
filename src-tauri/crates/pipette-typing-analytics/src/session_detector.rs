// SPDX-License-Identifier: GPL-2.0-or-later
//! Typing sessions per scope: a session runs from
//! its first keystroke until the recording stops, an idle gap of
//! [`SESSION_IDLE_GAP_MS`] or the app quits. The detector hands back the
//! sessions it closes; the flush writes them.

use std::sync::Arc;

use indexmap::IndexMap;
use pipette_entry_store::IdGen;

/// `SESSION_IDLE_GAP_MS`: five minutes without a keystroke ends a session.
pub const SESSION_IDLE_GAP_MS: f64 = 5.0 * 60.0 * 1000.0;

/// A closed session (`FinalizedSession`).
#[derive(Clone, Debug, PartialEq)]
pub struct FinalizedSession {
    pub id: String,
    pub uid: String,
    pub scope_key: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub keystroke_count: u64,
}

pub struct SessionDetector {
    /// The open sessions by scope key, in the order they were first opened
    /// (a session replacing another keeps its place, as a JavaScript `Map`
    /// does).
    sessions: IndexMap<String, FinalizedSession>,
    idle_gap_ms: f64,
    ids: Arc<dyn IdGen>,
}

impl SessionDetector {
    /// A detector whose sessions take their ids from `ids` (`randomUUID`).
    pub fn new(ids: Arc<dyn IdGen>) -> Self {
        Self::with_idle_gap(ids, SESSION_IDLE_GAP_MS)
    }

    pub fn with_idle_gap(ids: Arc<dyn IdGen>, idle_gap_ms: f64) -> Self {
        Self { sessions: IndexMap::new(), idle_gap_ms, ids }
    }

    fn start(&self, uid: &str, scope_key: &str, ts: f64) -> FinalizedSession {
        FinalizedSession {
            id: self.ids.new_id(),
            uid: uid.into(),
            scope_key: scope_key.into(),
            start_ms: ts,
            end_ms: ts,
            keystroke_count: 1,
        }
    }

    /// Counts a keystroke at `ts`. Returns the session an
    /// idle gap closed, if any; the session it opens is not returned.
    ///
    /// A keystroke older than the session's last one counts but does not
    /// move its end back (which would make the next gap look idle); it may
    /// move the start back.
    pub fn record_event(&mut self, uid: &str, scope_key: &str, ts: f64) -> Option<FinalizedSession> {
        let Some(open) = self.sessions.get_mut(scope_key) else {
            let started = self.start(uid, scope_key, ts);
            self.sessions.insert(scope_key.into(), started);
            return None;
        };
        if ts - open.end_ms >= self.idle_gap_ms {
            let started = self.start(uid, scope_key, ts);
            return self.sessions.insert(scope_key.into(), started);
        }
        if ts > open.end_ms {
            open.end_ms = ts;
        }
        if ts < open.start_ms {
            open.start_ms = ts;
        }
        open.keystroke_count += 1;
        None
    }

    /// Every open session, in the order they were opened.
    pub fn close_all(&mut self) -> Vec<FinalizedSession> {
        self.sessions.drain(..).map(|(_, session)| session).collect()
    }

    /// The open sessions of `uid` whose start `closes`
    /// accepts.
    pub fn close_for_uid(&mut self, uid: &str, closes: impl Fn(f64) -> bool) -> Vec<FinalizedSession> {
        let mut closed = Vec::new();
        self.sessions.retain(|_, session| {
            let close = session.uid == uid && closes(session.start_ms);
            if close {
                closed.push(session.clone());
            }
            !close
        });
        closed
    }

    pub fn has_active_session(&self, scope_key: &str) -> bool {
        self.sessions.contains_key(scope_key)
    }

    pub fn has_any_active_session(&self) -> bool {
        !self.sessions.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use pipette_entry_store::RandomUuid;

    use super::*;

    const UID_A: &str = "0xAABB";
    const UID_B: &str = "0xCCDD";
    const SCOPE_A: &str = "machineHash|linux|6.8|0xAABB|0xFEED|0x0000";
    const SCOPE_B: &str = "machineHash|linux|6.8|0xCCDD|0x1234|0x0001";

    fn detector() -> SessionDetector {
        SessionDetector::new(Arc::new(RandomUuid))
    }

    #[test]
    fn starts_a_session_on_the_first_event_of_a_scope() {
        let mut det = detector();
        assert_eq!(det.record_event(UID_A, SCOPE_A, 1_000.0), None);
        assert!(det.has_active_session(SCOPE_A));
    }

    #[test]
    fn extends_the_session_within_the_idle_gap() {
        let mut det = detector();
        det.record_event(UID_A, SCOPE_A, 1_000.0);
        assert_eq!(det.record_event(UID_A, SCOPE_A, 2_000.0), None);
        assert_eq!(det.record_event(UID_A, SCOPE_A, 3_000.0), None);
        let closed = det.close_all();
        assert_eq!(closed.len(), 1);
        assert_eq!((closed[0].keystroke_count, closed[0].start_ms, closed[0].end_ms), (3, 1_000.0, 3_000.0));
        assert_eq!(closed[0].id.len(), 36);
    }

    #[test]
    fn an_idle_gap_closes_the_session_and_opens_another() {
        let mut det = detector();
        det.record_event(UID_A, SCOPE_A, 1_000.0);
        det.record_event(UID_A, SCOPE_A, 2_000.0);
        let after = det.record_event(UID_A, SCOPE_A, 2_000.0 + SESSION_IDLE_GAP_MS).unwrap();
        assert_eq!((after.keystroke_count, after.start_ms, after.end_ms), (2, 1_000.0, 2_000.0));
        assert!(det.has_active_session(SCOPE_A));
        let closed = det.close_all();
        assert_eq!((closed[0].start_ms, closed[0].keystroke_count), (2_000.0 + SESSION_IDLE_GAP_MS, 1));
        assert_ne!(closed[0].id, after.id);
    }

    #[test]
    fn tracks_each_scope_on_its_own() {
        let mut det = detector();
        det.record_event(UID_A, SCOPE_A, 1_000.0);
        det.record_event(UID_B, SCOPE_B, 1_000.0);
        det.record_event(UID_A, SCOPE_A, 2_000.0);
        let closed = det.close_all();
        let counts: Vec<_> = closed.iter().map(|s| (s.uid.as_str(), s.keystroke_count)).collect();
        assert_eq!(counts, [(UID_A, 2), (UID_B, 1)]);
    }

    #[test]
    fn close_for_uid_closes_only_that_keyboard() {
        let mut det = detector();
        det.record_event(UID_A, SCOPE_A, 1_000.0);
        det.record_event(UID_B, SCOPE_B, 1_000.0);
        let closed = det.close_for_uid(UID_A, |_| true);
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].uid, UID_A);
        assert!(det.has_active_session(SCOPE_B));
        assert!(!det.has_active_session(SCOPE_A));
    }

    #[test]
    fn close_for_uid_honours_the_start_filter() {
        let mut det = detector();
        det.record_event(UID_A, SCOPE_A, 1_000.0);
        assert!(det.close_for_uid(UID_A, |start| start > 1_000.0).is_empty());
        assert_eq!(det.close_for_uid(UID_A, |start| start <= 1_000.0).len(), 1);
    }

    #[test]
    fn close_all_empties_the_detector() {
        let mut det = detector();
        det.record_event(UID_A, SCOPE_A, 1_000.0);
        assert_eq!(det.close_all().len(), 1);
        assert!(det.close_all().is_empty());
        assert!(!det.has_active_session(SCOPE_A));
        assert!(!det.has_any_active_session());
    }

    #[test]
    fn honours_a_custom_idle_gap() {
        let mut det = SessionDetector::with_idle_gap(Arc::new(RandomUuid), 100.0);
        det.record_event(UID_A, SCOPE_A, 1_000.0);
        assert_eq!(det.record_event(UID_A, SCOPE_A, 1_050.0), None);
        assert_eq!(det.record_event(UID_A, SCOPE_A, 1_200.0).unwrap().keystroke_count, 2);
    }

    #[test]
    fn a_late_event_does_not_rewind_the_end() {
        let mut det = detector();
        det.record_event(UID_A, SCOPE_A, 1_000.0);
        det.record_event(UID_A, SCOPE_A, 2_000.0 + SESSION_IDLE_GAP_MS);
        det.record_event(UID_A, SCOPE_A, 1_500.0);
        assert_eq!(det.record_event(UID_A, SCOPE_A, 2_000.0 + SESSION_IDLE_GAP_MS + 1_000.0), None);
        let closed = det.close_all();
        let session = &closed[0];
        assert_eq!(session.start_ms, 1_500.0);
        assert_eq!(session.end_ms, 2_000.0 + SESSION_IDLE_GAP_MS + 1_000.0);
        assert_eq!(session.keystroke_count, 3);
    }

    #[test]
    fn keeps_a_session_across_midnight_whole() {
        let mut det = detector();
        let (start, end) = (1_767_311_990_000.0, 1_767_312_240_000.0);
        det.record_event(UID_A, SCOPE_A, start);
        det.record_event(UID_A, SCOPE_A, end);
        let closed = det.close_all();
        assert_eq!((closed[0].start_ms, closed[0].end_ms), (start, end));
    }
}
