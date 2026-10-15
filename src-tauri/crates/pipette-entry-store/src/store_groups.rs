// SPDX-License-Identifier: GPL-2.0-or-later
//! The field groups of each entry store, as STORE_GROUPS in
//! src/main/sync/entry-clocks.ts. Every device must agree on them: the
//! merge moves a field with the clock of its group.

use crate::entry::MetaGroup;

/// The index-based entry stores.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EntryStore {
    Favorites,
    Snapshots,
    AnalyzeFilters,
    KeyLabels,
    TypingTestTexts,
    I18nPacks,
    ThemePacks,
    RunLogs,
}

/// How a v1 entry (no `clocks`) gets its body clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum V1BodyClockRule {
    /// `savedAt` moves with every body save (immutable bodies, or a new
    /// filename and `savedAt` on every save).
    SavedAt,
    /// The body is overwritten in place and `updatedAt` also moves on
    /// renames, so v1 cannot tell them apart: `updatedAt ?? savedAt`.
    UpdatedAtOrSavedAt,
    /// The body lives in its own sync unit (packs): the index body clock
    /// starts at the epoch and the body unit sets it.
    Epoch,
}

/// Where the entry id sits in a body filename (see
/// [`crate::id_body_filename`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilenameIdRule {
    /// `{stem}_{id}{ext}`: snapshots `{device}_{ts}_{id}.pipette`, run logs
    /// `{ts}_{id}.json`; favorites and analyze filters get the id appended
    /// to their `{…}_{ts}_{random}.json` names.
    Suffix,
    /// `{id}_{ts}.json` (key labels, typing-test texts).
    Prefix,
    /// `packs/{id}.json` (i18n and theme packs).
    Fixed,
}

/// The groups of one store.
#[derive(Debug)]
pub struct StoreGroupDef {
    /// Fields of the body group. Documents the store's shape; the body
    /// group is every field outside the other groups, so a field added
    /// later still travels with the body.
    pub body: &'static [&'static str],
    /// Fields that travel with the winning `created` clock.
    pub created_fields: &'static [&'static str],
    pub name: Option<&'static [&'static str]>,
    pub hub: Option<&'static [&'static str]>,
    pub enabled: Option<&'static [&'static str]>,
    pub v1_body_clock: V1BodyClockRule,
    pub filename_id: FilenameIdRule,
    /// Extension of the store's body files.
    pub body_ext: &'static str,
    /// The store saves over one filename in place, so equal body clocks and
    /// fields can still hide different bytes: the merge breaks that tie by
    /// the body's hash ([`crate::body_hash`]).
    pub hash_body: bool,
}

impl StoreGroupDef {
    /// The fields of a meta group, when the store has it.
    pub fn meta(&self, group: MetaGroup) -> Option<&'static [&'static str]> {
        match group {
            MetaGroup::Name => self.name,
            MetaGroup::Hub => self.hub,
            MetaGroup::Enabled => self.enabled,
        }
    }

    /// Whether a field belongs to the created group or a meta group.
    pub(crate) fn claims(&self, field: &str) -> bool {
        self.created_fields.contains(&field)
            || MetaGroup::ALL.iter().any(|&g| self.meta(g).is_some_and(|fields| fields.contains(&field)))
    }
}

/// Fields no group owns: identity, the clocks themselves and the derived /
/// delete markers the merge computes.
pub const RESERVED_FIELDS: [&str; 4] = ["id", "clocks", "updatedAt", "deletedAt"];

const HUB_LINK: &[&str] = &["hubPostId", "hubPrivate"];
const HUB_CACHE: &[&str] = &["hubPostId", "hubUpdatedAt", "uploaderName"];

// `savedAt` sits in the body group where the store rewrites it on every
// body save (key labels, typing-test texts, run logs re-saved by id) and in
// the created group where it is the first save time (every other store).

static FAVORITES: StoreGroupDef = StoreGroupDef {
    body: &["filename"],
    created_fields: &["savedAt"],
    name: Some(&["label"]),
    hub: Some(HUB_LINK),
    enabled: None,
    v1_body_clock: V1BodyClockRule::SavedAt,
    filename_id: FilenameIdRule::Suffix,
    body_ext: ".json",
    hash_body: false,
};

static SNAPSHOTS: StoreGroupDef = StoreGroupDef {
    body: &["filename", "vilVersion"],
    created_fields: &["savedAt"],
    name: Some(&["label"]),
    hub: Some(HUB_LINK),
    enabled: None,
    v1_body_clock: V1BodyClockRule::UpdatedAtOrSavedAt,
    filename_id: FilenameIdRule::Suffix,
    body_ext: ".pipette",
    hash_body: true,
};

static ANALYZE_FILTERS: StoreGroupDef = StoreGroupDef {
    body: &["filename", "summary"],
    created_fields: &["savedAt"],
    name: Some(&["label"]),
    hub: Some(HUB_LINK),
    enabled: None,
    v1_body_clock: V1BodyClockRule::UpdatedAtOrSavedAt,
    filename_id: FilenameIdRule::Suffix,
    body_ext: ".json",
    hash_body: true,
};

static KEY_LABELS: StoreGroupDef = StoreGroupDef {
    body: &["filename", "savedAt"],
    created_fields: &[],
    name: Some(&["name"]),
    hub: Some(HUB_CACHE),
    enabled: None,
    v1_body_clock: V1BodyClockRule::SavedAt,
    filename_id: FilenameIdRule::Prefix,
    body_ext: ".json",
    hash_body: false,
};

static TYPING_TEST_TEXTS: StoreGroupDef = StoreGroupDef {
    body: &["filename", "savedAt", "wordCount", "lineCount", "source"],
    created_fields: &[],
    name: Some(&["name"]),
    hub: None,
    enabled: None,
    v1_body_clock: V1BodyClockRule::SavedAt,
    filename_id: FilenameIdRule::Prefix,
    body_ext: ".json",
    hash_body: false,
};

static I18N_PACKS: StoreGroupDef = StoreGroupDef {
    body: &[
        "filename",
        "version",
        "coverage",
        "matchedBaseVersion",
        "dangerousKeyCount",
        "appVersionAtImport",
    ],
    created_fields: &["savedAt"],
    name: Some(&["name"]),
    hub: Some(HUB_CACHE),
    enabled: Some(&["enabled"]),
    v1_body_clock: V1BodyClockRule::Epoch,
    filename_id: FilenameIdRule::Fixed,
    body_ext: ".json",
    hash_body: false,
};

static THEME_PACKS: StoreGroupDef = StoreGroupDef {
    body: &["filename", "version"],
    created_fields: &["savedAt"],
    name: Some(&["name"]),
    hub: Some(HUB_CACHE),
    enabled: None,
    v1_body_clock: V1BodyClockRule::Epoch,
    filename_id: FilenameIdRule::Fixed,
    body_ext: ".json",
    hash_body: false,
};

static RUN_LOGS: StoreGroupDef = StoreGroupDef {
    body: &["filename", "startedAt", "savedAt"],
    created_fields: &[],
    name: None,
    hub: None,
    enabled: None,
    v1_body_clock: V1BodyClockRule::SavedAt,
    filename_id: FilenameIdRule::Suffix,
    body_ext: ".json",
    hash_body: false,
};

impl EntryStore {
    pub const ALL: [EntryStore; 8] = [
        EntryStore::Favorites,
        EntryStore::Snapshots,
        EntryStore::AnalyzeFilters,
        EntryStore::KeyLabels,
        EntryStore::TypingTestTexts,
        EntryStore::I18nPacks,
        EntryStore::ThemePacks,
        EntryStore::RunLogs,
    ];

    pub fn groups(self) -> &'static StoreGroupDef {
        match self {
            EntryStore::Favorites => &FAVORITES,
            EntryStore::Snapshots => &SNAPSHOTS,
            EntryStore::AnalyzeFilters => &ANALYZE_FILTERS,
            EntryStore::KeyLabels => &KEY_LABELS,
            EntryStore::TypingTestTexts => &TYPING_TEST_TEXTS,
            EntryStore::I18nPacks => &I18N_PACKS,
            EntryStore::ThemePacks => &THEME_PACKS,
            EntryStore::RunLogs => &RUN_LOGS,
        }
    }

    /// The store's name in the Electron build (`EntryStore` of
    /// entry-clocks.ts).
    pub fn name(self) -> &'static str {
        match self {
            EntryStore::Favorites => "favorites",
            EntryStore::Snapshots => "snapshots",
            EntryStore::AnalyzeFilters => "analyzeFilters",
            EntryStore::KeyLabels => "keyLabels",
            EntryStore::TypingTestTexts => "typingTestTexts",
            EntryStore::I18nPacks => "i18nPacks",
            EntryStore::ThemePacks => "themePacks",
            EntryStore::RunLogs => "runLogs",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|store| store.name() == name)
    }
}
