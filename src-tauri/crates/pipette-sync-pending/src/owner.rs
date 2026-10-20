// SPDX-License-Identifier: GPL-2.0-or-later
//! The Google account the pending units belong to. The active units always belong
//! to the owner (nobody while signed out); another account's units wait in
//! its held set, which no upload reads, until that account signs in again.
//! Local data itself is shared by every account; only the record of what
//! still has to be sent is kept apart.
//!
//! The changes a sign-in or sign-out makes before it switches tokens are
//! written first and put back when the write fails (the `*_durably`
//! methods), so the tokens are switched only once the ownership is on disk.

use pipette_js_json::JsString;

use crate::{PendingStore, State, file, lock};

impl State {
    fn owned_by(&self, sub: &str) -> bool {
        self.owner.as_ref().is_some_and(|owner| owner.as_str() == Some(sub))
    }

    /// Moves the active units to the held set of `owner`.
    fn hold_active_for(&mut self, owner: JsString) {
        let units: Vec<JsString> = self.units.drain(..).map(|(unit, _)| unit).collect();
        let held = self.held.entry(owner.clone()).or_default();
        held.extend(units);
        if held.is_empty() {
            self.held.shift_remove(&owner);
        }
    }

    /// Makes `sub` the owner of the active units. Units of another owner are
    /// held for it first, units held for `sub` become active again with new
    /// generations, and units changed while signed out go to `sub`. `None`
    /// (signed out, or an account whose tokens carry no id) changes nothing.
    /// Whether anything changed.
    fn adopt(&mut self, sub: Option<&str>) -> bool {
        let Some(sub) = sub else { return false };
        let held_for_sub = self.held.contains_key(sub);
        if self.owned_by(sub) && !held_for_sub {
            return false;
        }
        if let Some(owner) = self.owner.take()
            && owner.as_str() != Some(sub)
        {
            self.hold_active_for(owner);
        }
        self.owner = Some(JsString::from(sub));
        if let Some(units) = self.held.shift_remove(sub) {
            for unit in units {
                self.mark(unit);
            }
        }
        true
    }
}

impl PendingStore {
    /// The account the active units were changed under.
    pub fn owner(&self) -> Option<JsString> {
        lock(&self.shared.state).owner.clone()
    }

    /// The units held for each other account, in the order they were held.
    pub fn held(&self) -> Vec<(JsString, Vec<JsString>)> {
        let state = lock(&self.shared.state);
        state.held.iter().map(|(sub, units)| (sub.clone(), units.iter().cloned().collect())).collect()
    }

    /// Hands the pending units to the account `sub` the stored tokens belong
    /// to; written now and told to the listener when anything changed.
    /// Whether anything did.
    pub fn adopt_for_account(&self, sub: Option<&str>) -> bool {
        let changed = lock(&self.shared.state).adopt(sub);
        if changed {
            self.commit_state();
        }
        changed
    }

    /// Marks `unit` pending for `owner`, the account a pass ran as: held for
    /// it when another account has signed in since the pass started. Not
    /// told to the listener while the unit stays active; the pass tells it
    /// ([`Self::broadcast_status`]).
    pub fn mark_pending_for(&self, owner: Option<&str>, unit: &str) {
        let ticket = {
            let mut state = lock(&self.shared.state);
            match owner {
                Some(owner) if !state.owned_by(owner) => {
                    if !state.held.entry(JsString::from(owner)).or_default().insert(JsString::from(unit)) {
                        return;
                    }
                    None
                }
                _ => {
                    if state.units.contains_key(unit) {
                        return;
                    }
                    Some(self.mark_pending(&mut state, JsString::from(unit)))
                }
            }
        };
        match ticket {
            Some(ticket) => self.schedule_write(ticket),
            None => self.commit_state(),
        }
    }

    /// Gives ownerless units to `sub`, the account still signed in, before
    /// its tokens are replaced or removed: with no pass since the launch they
    /// were never handed over. Nothing changes while an owner is set or for
    /// `None`.
    pub fn claim_ownerless_durably(&self, sub: Option<&str>) -> std::io::Result<()> {
        self.change_ownership_durably(|state| match sub {
            Some(sub) if state.owner.is_none() => {
                state.owner = Some(JsString::from(sub));
                true
            }
            _ => false,
        })
    }

    /// Hands the units to `sub`, the account a sign-in stores tokens for,
    /// written before the tokens are.
    pub fn adopt_durably(&self, sub: Option<&str>) -> std::io::Result<()> {
        self.change_ownership_durably(|state| state.adopt(sub))
    }

    /// Holds the owner's units for its next sign-in and leaves the units
    /// ownerless, written before a sign-out removes the tokens: changes made
    /// from here on belong to whoever signs in next.
    pub fn hold_for_sign_out_durably(&self) -> std::io::Result<()> {
        self.change_ownership_durably(|state| {
            let Some(owner) = state.owner.take() else { return false };
            state.hold_active_for(owner);
            true
        })
    }

    /// Applies `change` (which returns whether it changed anything) and writes
    /// the result. When the write fails, the pending state is put back as it
    /// was and the error returned, so the caller can stop before it switches
    /// tokens.
    fn change_ownership_durably(&self, change: impl FnOnce(&mut State) -> bool) -> std::io::Result<()> {
        let changed = self.with_write_lock(|state| {
            let before = (state.owner.clone(), state.units.clone(), state.held.clone());
            if !change(state) {
                return Ok(false);
            }
            let content = file::content(state.owner.as_ref(), state.units.keys(), &state.held);
            if let Err(err) = self.write_locked(state, &content) {
                (state.owner, state.units, state.held) = before;
                return Err(err);
            }
            Ok(true)
        })?;
        if changed {
            self.broadcast_status();
        }
        Ok(())
    }
}
