// SPDX-License-Identifier: GPL-2.0-or-later
//! The multipart bodies of the Hub uploads, byte for byte as the recorded
//! goldens hold them: the boundary from the clock, the parts in a fixed
//! order with fixed header lines, field values with their line breaks as
//! spaces, file names as they are, and the closing boundary followed by
//! CRLF.

/// A finished body and its boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultipartBody {
    pub body: Vec<u8>,
    pub boundary: String,
}

/// The boundary of the post, favorite, analytics and private uploads
/// (`----PipetteBoundary${Date.now()}`).
pub fn post_boundary(now_ms: i64) -> String {
    format!("----PipetteBoundary{now_ms}")
}

/// The boundary of the language pack uploads.
pub fn i18n_boundary(now_ms: i64) -> String {
    format!("----PipetteI18nBoundary{now_ms}")
}

/// The boundary of the theme pack uploads.
pub fn theme_boundary(now_ms: i64) -> String {
    format!("----PipetteThemeBoundary{now_ms}")
}

/// `sanitizeFieldValue`: each CRLF, CR or LF as one space.
pub fn sanitize_field_value(value: &str) -> String {
    value.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

/// `MultipartBuilder`.
pub struct MultipartBuilder {
    boundary: String,
    body: Vec<u8>,
}

impl MultipartBuilder {
    pub fn new(boundary: String) -> Self {
        Self { boundary, body: Vec::new() }
    }

    /// `appendField`.
    pub fn field(&mut self, name: &str, value: &str) {
        let part = format!(
            "--{}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{}\r\n",
            self.boundary,
            sanitize_field_value(value)
        );
        self.body.extend_from_slice(part.as_bytes());
    }

    /// `appendFile`.
    pub fn file(&mut self, field: &str, filename: &str, data: &[u8], content_type: &str) {
        let head = format!(
            "--{}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n",
            self.boundary
        );
        self.body.extend_from_slice(head.as_bytes());
        self.body.extend_from_slice(data);
        self.body.extend_from_slice(b"\r\n");
    }

    /// `build`.
    pub fn build(mut self) -> MultipartBody {
        self.body.extend_from_slice(format!("--{}--\r\n", self.boundary).as_bytes());
        MultipartBody { body: self.body, boundary: self.boundary }
    }
}

/// A file of an upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadFile {
    pub name: String,
    pub data: Vec<u8>,
}

/// `HubUploadFiles`: the files of a keymap post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeymapFiles {
    pub vil: UploadFile,
    pub pipette: UploadFile,
    pub c: UploadFile,
    pub pdf: UploadFile,
    pub thumbnail: UploadFile,
}

/// `String(expiresInDays)` as the last field, when there is one.
fn expires_field(builder: &mut MultipartBuilder, expires_in_days: Option<f64>) {
    if let Some(days) = expires_in_days {
        builder.field("expires_in_days", &crate::js::js_number_string(days));
    }
}

/// `buildMultipartBody` of a keymap post: `expires_in_days` for a private
/// upload with an expiry only.
pub fn keymap_post_body(
    boundary: String,
    title: &str,
    keyboard_name: &str,
    files: &KeymapFiles,
    expires_in_days: Option<f64>,
) -> MultipartBody {
    let mut builder = MultipartBuilder::new(boundary);
    builder.field("title", title);
    builder.field("keyboard_name", keyboard_name);
    builder.file("vil", &files.vil.name, &files.vil.data, "application/json");
    builder.file("pipette", &files.pipette.name, &files.pipette.data, "application/json");
    builder.file("c", &files.c.name, &files.c.data, "text/plain");
    builder.file("pdf", &files.pdf.name, &files.pdf.data, "application/pdf");
    builder.file("thumbnail", &files.thumbnail.name, &files.thumbnail.data, "image/jpeg");
    expires_field(&mut builder, expires_in_days);
    builder.build()
}

/// `buildFeatureMultipartBody`: a favorite post.
pub fn feature_post_body(
    boundary: String,
    title: &str,
    post_type: &str,
    json: &UploadFile,
    expires_in_days: Option<f64>,
) -> MultipartBody {
    let mut builder = MultipartBuilder::new(boundary);
    builder.field("title", title);
    builder.field("post_type", post_type);
    builder.file("json", &json.name, &json.data, "application/json");
    expires_field(&mut builder, expires_in_days);
    builder.build()
}

/// `buildAnalyticsMultipartBody`: an analytics post.
pub fn analytics_post_body(
    boundary: String,
    title: &str,
    json: &UploadFile,
    thumbnail: &UploadFile,
    expires_in_days: Option<f64>,
) -> MultipartBody {
    let mut builder = MultipartBuilder::new(boundary);
    builder.field("title", title);
    builder.field("post_type", "analytics");
    builder.file("json", &json.name, &json.data, "application/json");
    builder.file("thumbnail", &thumbnail.name, &thumbnail.data, "image/jpeg");
    expires_field(&mut builder, expires_in_days);
    builder.build()
}

/// `buildI18nMultipartBody` and `buildThemeMultipartBody`: one `json` file.
/// Their inline head and tail give the same bytes as `MultipartBuilder`.
pub fn pack_body(boundary: String, json: &UploadFile) -> MultipartBody {
    let mut builder = MultipartBuilder::new(boundary);
    builder.file("json", &json.name, &json.data, "application/json");
    builder.build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, data: &[u8]) -> UploadFile {
        UploadFile { name: name.to_owned(), data: data.to_vec() }
    }

    #[test]
    fn writes_the_parts_in_order_with_crlf_endings() {
        let files = KeymapFiles {
            vil: file("k.vil", b"{}"),
            pipette: file("k.pipette", b"{1}"),
            c: file("k.c", b"c"),
            pdf: file("k.pdf", &[0, 255]),
            thumbnail: file("k.jpg", b"j"),
        };
        let body = keymap_post_body(post_boundary(42), "a\r\nb\nc", "K\rB", &files, Some(7.0));
        let b = "----PipetteBoundary42";
        let mut expected = format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\na b c\r\n\
             --{b}\r\nContent-Disposition: form-data; name=\"keyboard_name\"\r\n\r\nK B\r\n\
             --{b}\r\nContent-Disposition: form-data; name=\"vil\"; filename=\"k.vil\"\r\nContent-Type: application/json\r\n\r\n{{}}\r\n\
             --{b}\r\nContent-Disposition: form-data; name=\"pipette\"; filename=\"k.pipette\"\r\nContent-Type: application/json\r\n\r\n{{1}}\r\n\
             --{b}\r\nContent-Disposition: form-data; name=\"c\"; filename=\"k.c\"\r\nContent-Type: text/plain\r\n\r\nc\r\n\
             --{b}\r\nContent-Disposition: form-data; name=\"pdf\"; filename=\"k.pdf\"\r\nContent-Type: application/pdf\r\n\r\n"
        )
        .into_bytes();
        expected.extend_from_slice(&[0, 255]);
        expected.extend_from_slice(
            format!(
                "\r\n--{b}\r\nContent-Disposition: form-data; name=\"thumbnail\"; filename=\"k.jpg\"\r\nContent-Type: image/jpeg\r\n\r\nj\r\n\
                 --{b}\r\nContent-Disposition: form-data; name=\"expires_in_days\"\r\n\r\n7\r\n--{b}--\r\n"
            )
            .as_bytes(),
        );
        assert_eq!(body.boundary, b);
        assert_eq!(String::from_utf8_lossy(&body.body), String::from_utf8_lossy(&expected));
        assert_eq!(body.body, expected);
    }

    #[test]
    fn a_pack_body_is_one_json_file_and_names_are_not_escaped() {
        let body = pack_body(i18n_boundary(1), &file("a\"b.json", b"{}"));
        assert_eq!(
            body.body,
            b"------PipetteI18nBoundary1\r\nContent-Disposition: form-data; name=\"json\"; filename=\"a\"b.json\"\r\nContent-Type: application/json\r\n\r\n{}\r\n------PipetteI18nBoundary1--\r\n"
                .to_vec()
        );
        assert_eq!(theme_boundary(5), "----PipetteThemeBoundary5");
    }

    #[test]
    fn the_feature_and_analytics_bodies_put_the_expiry_last() {
        let json = file("f.json", b"[]");
        let public = feature_post_body(post_boundary(1), "t", "macro", &json, None);
        assert!(!String::from_utf8_lossy(&public.body).contains("expires_in_days"));
        let private = analytics_post_body(post_boundary(1), "t", &json, &file("t.jpg", b"x"), Some(1.5));
        let text = String::from_utf8_lossy(&private.body).into_owned();
        assert!(text.contains("name=\"post_type\"\r\n\r\nanalytics\r\n"));
        assert!(
            text.ends_with("name=\"expires_in_days\"\r\n\r\n1.5\r\n------PipetteBoundary1--\r\n"),
            "{text}"
        );
    }
}
