// SPDX-License-Identifier: GPL-2.0-or-later
//! The query layer between the commands and the database (the query
//! functions of src/main/typing-analytics/typing-analytics-queries.ts and
//! the argument checks of their IPC handlers).

use pipette_entry_store::is_js_whitespace;
use pipette_typing_analytics_db::ScopeFilters;

/// `normalizeAppScopes` (src/shared/types/analyze-filters.ts): the strings
/// of a filter list trimmed as JavaScript trims, the empty ones and repeats
/// left out, in order. `items` are the string elements of the list the
/// renderer sent; anything that is not a list has none.
pub fn normalize_app_scopes<'a>(items: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let trimmed = item.trim_matches(|c: char| u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace));
        if !trimmed.is_empty() && !out.iter().any(|seen| seen == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    out
}

/// The three filter lists of an Analyze query, each normalized.
pub fn scope_filters<'a>(
    app_names: impl IntoIterator<Item = &'a str>,
    typing_tests: impl IntoIterator<Item = &'a str>,
    run_ids: impl IntoIterator<Item = &'a str>,
) -> ScopeFilters {
    ScopeFilters {
        app_names: normalize_app_scopes(app_names),
        typing_tests: normalize_app_scopes(typing_tests),
        run_ids: normalize_app_scopes(run_ids),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_and_drops_empty_and_repeated_scopes() {
        let items = [" Code ", "Code", "", "\u{3000}\u{feff}", "Slack\n", "\u{85}x"];
        assert_eq!(normalize_app_scopes(items), ["Code", "Slack", "\u{85}x"]);
        assert!(normalize_app_scopes([]).is_empty());
    }
}
