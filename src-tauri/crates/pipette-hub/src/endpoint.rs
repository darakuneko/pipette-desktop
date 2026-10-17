// SPDX-License-Identifier: GPL-2.0-or-later
//! Every Hub API endpoint the app calls, one to one with the request
//! functions of src/main/hub/*.ts: its method, path and query, the label of
//! its error messages and which of the three ways of reading a response
//! that function uses ([`ReadMode`]).

use pipette_net::{Method, encode_uri_component};

use crate::js::{js_number_string, js_trim};

/// How a response is read, after the shared handling of the status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadMode {
    /// `hubFetch` of hub-client.ts and hub-key-labels.ts: the body must be
    /// the `{ ok, data, error? }` envelope, and `ok: false` fails with
    /// `<label>: <error ?? 'unknown error'>`. A 429 is retried once. Only
    /// hub-client.ts has a class of its own for a 404 (`Hub404Error`);
    /// hub-key-labels.ts reports it as any other failed status.
    Strict { typed_not_found: bool },
    /// `hubFetchJson` of hub-i18n.ts and hub-theme.ts: an object with an
    /// `ok` property is unwrapped as the envelope, any other body is the
    /// result as it is. A 429 is retried once.
    Lenient,
    /// The i18n and key label downloads, which call `fetch` themselves: a
    /// 429 is not retried, and a 2xx body is the result as it is.
    RawDownload,
}

/// The query of a Hub list (`URLSearchParams` in the order the TS sets
/// it): `q` and `name` when non-empty after `trim()`, trimmed; `page` and
/// `per_page` when given.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ListQuery<'a> {
    pub q: Option<&'a str>,
    /// The language and theme pack lists only.
    pub name: Option<&'a str>,
    pub page: Option<f64>,
    pub per_page: Option<f64>,
}

impl ListQuery<'_> {
    fn search(&self) -> String {
        let mut search = form_urlencoded::Serializer::new(String::new());
        for (key, text) in [("q", self.q), ("name", self.name)] {
            if let Some(text) = text {
                let trimmed = js_trim(text);
                if !trimmed.is_empty() {
                    search.append_pair(key, &trimmed);
                }
            }
        }
        for (key, number) in [("page", self.page), ("per_page", self.per_page)] {
            if let Some(number) = number {
                search.append_pair(key, &js_number_string(number));
            }
        }
        search.finish()
    }
}

/// `?<search>` for a non-empty search, as the TS writes
/// `` `${base}${route}${search ? `?${search}` : ''}` ``.
fn with_search(route: &str, search: String) -> String {
    if search.is_empty() { route.to_owned() } else { format!("{route}?{search}") }
}

/// A Hub API endpoint and what its path carries.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Endpoint<'a> {
    // hub-client.ts
    AuthToken,
    AuthMe,
    PatchAuthMe,
    MyPosts {
        page: Option<f64>,
        per_page: Option<f64>,
    },
    MyKeyboardPosts {
        keyboard_name: &'a str,
    },
    PatchPost {
        post_id: &'a str,
    },
    DeletePost {
        post_id: &'a str,
    },
    UploadPost,
    UpdatePost {
        post_id: &'a str,
    },
    UploadPrivatePost,
    /// `kind` goes into the path as it is, not encoded (the TS does not
    /// encode it).
    DeletePrivatePost {
        kind: &'a str,
        id: &'a str,
    },
    UploadFeaturePost,
    UpdateFeaturePost {
        post_id: &'a str,
    },
    UploadPrivateFeaturePost,
    UploadAnalyticsPost,
    UpdateAnalyticsPost {
        post_id: &'a str,
    },
    UploadPrivateAnalyticsPost,
    // hub-i18n.ts
    I18nList(ListQuery<'a>),
    I18nDownload {
        post_id: &'a str,
    },
    I18nTimestamps,
    I18nUpload,
    I18nUpdate {
        post_id: &'a str,
    },
    I18nDelete {
        post_id: &'a str,
    },
    // hub-theme.ts
    ThemeList(ListQuery<'a>),
    ThemeDownload {
        post_id: &'a str,
    },
    ThemeTimestamps,
    ThemeUpload,
    ThemeUpdate {
        post_id: &'a str,
    },
    ThemeDelete {
        post_id: &'a str,
    },
    // hub-key-labels.ts
    KeyLabelList(ListQuery<'a>),
    KeyLabelDetail {
        post_id: &'a str,
    },
    KeyLabelTimestamps,
    KeyLabelDownload {
        post_id: &'a str,
    },
    KeyLabelUpload,
    KeyLabelUpdate {
        post_id: &'a str,
    },
    KeyLabelDelete {
        post_id: &'a str,
    },
}

const FILES: &str = "/api/files";
const PRIVATE_FILES: &str = "/api/private/files";
const I18N_PACKS: &str = "/api/i18n-packs";
const THEME_PACKS: &str = "/api/theme-packs";
const KEY_LABELS: &str = "/api/key-labels";

fn item(route: &str, id: &str) -> String {
    format!("{route}/{}", encode_uri_component(id))
}

impl Endpoint<'_> {
    pub fn method(&self) -> Method {
        use Endpoint::*;
        match self {
            AuthMe
            | MyPosts { .. }
            | MyKeyboardPosts { .. }
            | I18nList(_)
            | I18nDownload { .. }
            | ThemeList(_)
            | ThemeDownload { .. }
            | KeyLabelList(_)
            | KeyLabelDetail { .. }
            | KeyLabelDownload { .. } => Method::Get,
            AuthToken
            | UploadPost
            | UploadPrivatePost
            | UploadFeaturePost
            | UploadPrivateFeaturePost
            | UploadAnalyticsPost
            | UploadPrivateAnalyticsPost
            | I18nTimestamps
            | I18nUpload
            | ThemeTimestamps
            | ThemeUpload
            | KeyLabelTimestamps
            | KeyLabelUpload => Method::Post,
            UpdatePost { .. }
            | UpdateFeaturePost { .. }
            | UpdateAnalyticsPost { .. }
            | I18nUpdate { .. }
            | ThemeUpdate { .. }
            | KeyLabelUpdate { .. } => Method::Put,
            PatchAuthMe | PatchPost { .. } => Method::Patch,
            DeletePost { .. }
            | DeletePrivatePost { .. }
            | I18nDelete { .. }
            | ThemeDelete { .. }
            | KeyLabelDelete { .. } => Method::Delete,
        }
    }

    /// The path and query after the base URL.
    pub fn path(&self) -> String {
        use Endpoint::*;
        match self {
            AuthToken => "/api/auth/token".to_owned(),
            AuthMe | PatchAuthMe => "/api/auth/me".to_owned(),
            MyPosts { page, per_page } => {
                let mut search = form_urlencoded::Serializer::new(String::new());
                for (key, number) in [("page", page), ("per_page", per_page)] {
                    if let Some(number) = number {
                        search.append_pair(key, &js_number_string(*number));
                    }
                }
                with_search(&format!("{FILES}/me"), search.finish())
            }
            MyKeyboardPosts { keyboard_name } => {
                format!("{FILES}/me/keyboard?name={}", encode_uri_component(keyboard_name))
            }
            UploadPost | UploadFeaturePost | UploadAnalyticsPost => FILES.to_owned(),
            PatchPost { post_id }
            | DeletePost { post_id }
            | UpdatePost { post_id }
            | UpdateFeaturePost { post_id }
            | UpdateAnalyticsPost { post_id } => item(FILES, post_id),
            UploadPrivatePost | UploadPrivateFeaturePost | UploadPrivateAnalyticsPost => {
                PRIVATE_FILES.to_owned()
            }
            DeletePrivatePost { kind, id } => format!("/api/private/{kind}/{}", encode_uri_component(id)),
            I18nList(query) => with_search(I18N_PACKS, query.search()),
            I18nDownload { post_id } => format!("{}/download", item(I18N_PACKS, post_id)),
            I18nTimestamps => format!("{I18N_PACKS}/timestamps"),
            I18nUpload => I18N_PACKS.to_owned(),
            I18nUpdate { post_id } | I18nDelete { post_id } => item(I18N_PACKS, post_id),
            ThemeList(query) => with_search(THEME_PACKS, query.search()),
            ThemeDownload { post_id } => format!("{}/download", item(THEME_PACKS, post_id)),
            ThemeTimestamps => format!("{THEME_PACKS}/timestamps"),
            ThemeUpload => THEME_PACKS.to_owned(),
            ThemeUpdate { post_id } | ThemeDelete { post_id } => item(THEME_PACKS, post_id),
            KeyLabelList(query) => {
                // The key label list has no `name`.
                with_search(KEY_LABELS, ListQuery { name: None, ..*query }.search())
            }
            KeyLabelDetail { post_id } | KeyLabelUpdate { post_id } | KeyLabelDelete { post_id } => {
                item(KEY_LABELS, post_id)
            }
            KeyLabelTimestamps => format!("{KEY_LABELS}/timestamps"),
            KeyLabelDownload { post_id } => format!("{}/download", item(KEY_LABELS, post_id)),
            KeyLabelUpload => KEY_LABELS.to_owned(),
        }
    }

    /// The label the TS gives the endpoint's errors (`<label>: …`).
    pub fn label(&self) -> &'static str {
        use Endpoint::*;
        match self {
            AuthToken => "Hub auth failed",
            AuthMe => "Hub fetch auth me failed",
            PatchAuthMe => "Hub patch auth me failed",
            MyPosts { .. } => "Hub fetch my posts failed",
            MyKeyboardPosts { .. } => "Hub fetch keyboard posts failed",
            PatchPost { .. } => "Hub patch failed",
            DeletePost { .. } => "Hub delete failed",
            UploadPost => "Hub upload failed",
            UpdatePost { .. } => "Hub update failed",
            UploadPrivatePost => "Hub private upload failed",
            DeletePrivatePost { .. } => "Hub private delete failed",
            UploadFeaturePost => "Hub feature upload failed",
            UpdateFeaturePost { .. } => "Hub feature update failed",
            UploadPrivateFeaturePost => "Hub private feature upload failed",
            UploadAnalyticsPost => "Hub analytics upload failed",
            UpdateAnalyticsPost { .. } => "Hub analytics update failed",
            UploadPrivateAnalyticsPost => "Hub private analytics upload failed",
            I18nList(_) => "Hub i18n list failed",
            I18nDownload { .. } => "Hub i18n download failed",
            I18nTimestamps => "Hub i18n timestamps fetch failed",
            I18nUpload => "Hub i18n upload failed",
            I18nUpdate { .. } => "Hub i18n update failed",
            I18nDelete { .. } => "Hub i18n delete failed",
            ThemeList(_) => "Hub theme list failed",
            ThemeDownload { .. } => "Hub theme download failed",
            ThemeTimestamps => "Hub theme timestamps fetch failed",
            ThemeUpload => "Hub theme upload failed",
            ThemeUpdate { .. } => "Hub theme update failed",
            ThemeDelete { .. } => "Hub theme delete failed",
            KeyLabelList(_) => "Hub key-label list failed",
            KeyLabelDetail { .. } => "Hub key-label fetch failed",
            KeyLabelTimestamps => "Hub key-label timestamps fetch failed",
            KeyLabelDownload { .. } => "Hub key-label download failed",
            KeyLabelUpload => "Hub key-label upload failed",
            KeyLabelUpdate { .. } => "Hub key-label update failed",
            KeyLabelDelete { .. } => "Hub key-label delete failed",
        }
    }

    pub fn read_mode(&self) -> ReadMode {
        use Endpoint::*;
        match self {
            I18nDownload { .. } | KeyLabelDownload { .. } => ReadMode::RawDownload,
            I18nList(_)
            | I18nTimestamps
            | I18nUpload
            | I18nUpdate { .. }
            | I18nDelete { .. }
            | ThemeList(_)
            | ThemeDownload { .. }
            | ThemeTimestamps
            | ThemeUpload
            | ThemeUpdate { .. }
            | ThemeDelete { .. } => ReadMode::Lenient,
            KeyLabelList(_)
            | KeyLabelDetail { .. }
            | KeyLabelTimestamps
            | KeyLabelUpload
            | KeyLabelUpdate { .. }
            | KeyLabelDelete { .. } => ReadMode::Strict { typed_not_found: false },
            _ => ReadMode::Strict { typed_not_found: true },
        }
    }

    /// Whether the request carries a multipart upload: it gets the longer
    /// overall time limit.
    pub fn is_multipart_upload(&self) -> bool {
        use Endpoint::*;
        matches!(
            self,
            UploadPost
                | UpdatePost { .. }
                | UploadPrivatePost
                | UploadFeaturePost
                | UpdateFeaturePost { .. }
                | UploadPrivateFeaturePost
                | UploadAnalyticsPost
                | UpdateAnalyticsPost { .. }
                | UploadPrivateAnalyticsPost
                | I18nUpload
                | I18nUpdate { .. }
                | ThemeUpload
                | ThemeUpdate { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_queries_are_written_as_url_search_params() {
        let query =
            ListQuery { q: Some("  a b&c  "), name: Some(" "), page: Some(2.0), per_page: Some(20.0) };
        assert_eq!(Endpoint::I18nList(query).path(), "/api/i18n-packs?q=a+b%26c&page=2&per_page=20");
        assert_eq!(Endpoint::ThemeList(ListQuery::default()).path(), "/api/theme-packs");
        let named = ListQuery { name: Some("日本"), page: Some(1.5), ..ListQuery::default() };
        assert_eq!(Endpoint::ThemeList(named).path(), "/api/theme-packs?name=%E6%97%A5%E6%9C%AC&page=1.5");
        assert_eq!(Endpoint::KeyLabelList(named).path(), "/api/key-labels?page=1.5");
        let odd = ListQuery { page: Some(f64::NAN), per_page: Some(f64::INFINITY), ..ListQuery::default() };
        assert_eq!(Endpoint::KeyLabelList(odd).path(), "/api/key-labels?page=NaN&per_page=Infinity");
        assert_eq!(Endpoint::MyPosts { page: None, per_page: Some(5.0) }.path(), "/api/files/me?per_page=5");
        assert_eq!(Endpoint::MyPosts { page: None, per_page: None }.path(), "/api/files/me");
    }

    #[test]
    fn path_segments_are_encoded_but_the_private_kind_is_not() {
        assert_eq!(
            Endpoint::MyKeyboardPosts { keyboard_name: "A B/日" }.path(),
            "/api/files/me/keyboard?name=A%20B%2F%E6%97%A5"
        );
        assert_eq!(Endpoint::UpdatePost { post_id: "a/b" }.path(), "/api/files/a%2Fb");
        assert_eq!(Endpoint::DeletePrivatePost { kind: "x/y", id: "a b" }.path(), "/api/private/x/y/a%20b");
        assert_eq!(Endpoint::I18nDownload { post_id: "p 1" }.path(), "/api/i18n-packs/p%201/download");
        assert_eq!(Endpoint::KeyLabelDownload { post_id: "k" }.path(), "/api/key-labels/k/download");
        assert_eq!(Endpoint::ThemeTimestamps.path(), "/api/theme-packs/timestamps");
    }

    #[test]
    fn the_downloads_read_raw_and_only_hub_client_types_a_404() {
        assert_eq!(Endpoint::I18nDownload { post_id: "x" }.read_mode(), ReadMode::RawDownload);
        assert_eq!(Endpoint::ThemeDownload { post_id: "x" }.read_mode(), ReadMode::Lenient);
        assert_eq!(
            Endpoint::KeyLabelDetail { post_id: "x" }.read_mode(),
            ReadMode::Strict { typed_not_found: false }
        );
        assert_eq!(
            Endpoint::DeletePrivatePost { kind: "post", id: "x" }.read_mode(),
            ReadMode::Strict { typed_not_found: true }
        );
        assert!(Endpoint::ThemeUpdate { post_id: "x" }.is_multipart_upload());
        assert!(!Endpoint::KeyLabelUpload.is_multipart_upload());
        assert_eq!(Endpoint::KeyLabelUpdate { post_id: "x" }.method(), Method::Put);
    }
}
