// SPDX-License-Identifier: GPL-2.0-or-later
//! The account, post and private-post routes of the in-memory Hub, as
//! scripts/fake-hub/hub-routes.ts has them (the Hub worker's
//! routes/auth.ts, routes/files.ts and routes/private/files.ts): the same
//! checks in the same order with the same error texts. The Hub's daily and
//! rate limits are left out; a 429 comes only from an injected fault.

use pipette_js_json::Value;

use super::http::{
    Answer, FormValue, Request, authenticate, fail, form_file, form_has, form_text, ok, ok_with, page_of,
    pagination, read_form, read_json_object, string_or_null,
};
use super::object;
use super::state::{Post, PostContent, PostFile, State, User};
use super::validate::{
    feature_json_error, is_reserved_display_name, normalize_display_name, parse_analytics_export,
    parse_expires_in_days, parse_test_id_token, parse_unverified_jwt,
};
use crate::js::{js_length, js_trim};

const MAX_TITLE_LENGTH: usize = 200;
const MAX_KEYBOARD_NAME_LENGTH: usize = 100;
const MAX_FILE_SIZE: usize = 10 * 1024 * 1024;
const MAX_THUMBNAIL_SIZE: usize = 2 * 1024 * 1024;
const MAX_USER_KEYBOARD_POSTS: usize = 30;
const KEYBOARD_FILE_TYPES: [&str; 4] = ["vil", "c", "pdf", "pipette"];
const FEATURE_POST_TYPES: [&str; 5] = ["td", "macro", "combo", "ko", "ark"];

type Form = Vec<(String, FormValue)>;

fn user_response(user: &User) -> Value {
    object([
        ("id", Value::from(user.id.as_str())),
        ("email", Value::from(user.email.as_str())),
        ("display_name", user.display_name.as_deref().map_or(Value::Null, Value::from)),
        ("role", Value::from("user")),
    ])
}

macro_rules! check {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(answer) => return answer,
        }
    };
}

// --- /api/auth -----------------------------------------------------------------

pub fn token(state: &mut State, request: &Request<'_>) -> Answer {
    let body = check!(read_json_object(request));
    let Some(id_token) = body.get("id_token").and_then(Value::as_str).filter(|token| !token.is_empty())
    else {
        return fail(400, "Missing id_token");
    };
    let display_name = body.get("display_name");
    if !matches!(display_name, None | Some(Value::Null | Value::String(_))) {
        return fail(400, "display_name must be a string or null");
    }
    let Some(identity) = parse_test_id_token(id_token).or_else(|| parse_unverified_jwt(id_token)) else {
        return fail(401, "Invalid or expired token");
    };
    let override_name = display_name.map(|value| value.as_str());
    if let Some(value) = override_name
        && normalize_display_name(value).is_none()
    {
        return fail(400, "display_name must not be empty");
    }
    let name = match override_name {
        Some(value) => normalize_display_name(value),
        None => normalize_display_name(identity.name.as_deref()),
    };
    if let Some(name) = &name {
        if is_reserved_display_name(name) {
            return fail(400, "display_name is reserved");
        }
        let existing = state.user_by_email(&identity.email).map(|user| user.id.clone());
        if state.display_name_taken(name, existing.as_deref()) {
            return fail(409, "display_name is already taken");
        }
    }
    // An existing account keeps its display name; only a new one takes it.
    let user = match state.user_by_email(&identity.email) {
        Some(user) => user.clone(),
        None => state.create_user(&identity.email, name),
    };
    if !user.active {
        return fail(403, "Account is deactivated");
    }
    let jwt = state.issue_jwt(&user);
    ok(object([("token", Value::from(jwt)), ("user", user_response(&user))]))
}

pub fn get_me(state: &State, request: &Request<'_>) -> Answer {
    let user = check!(authenticate(state, request));
    ok(user_response(&user))
}

pub fn patch_me(state: &mut State, request: &Request<'_>) -> Answer {
    let user = check!(authenticate(state, request));
    let body = check!(read_json_object(request));
    if body.keys().any(|key| *key != *"display_name") {
        return fail(400, "Unknown field in request body");
    }
    let Some(raw) = body.get("display_name") else { return fail(400, "No fields to update") };
    if !matches!(raw, Value::Null | Value::String(_)) {
        return fail(400, "display_name must be a string or null");
    }
    let Some(name) = normalize_display_name(raw.as_str()) else {
        return fail(400, "display_name must not be empty");
    };
    if is_reserved_display_name(&name) {
        return fail(400, "display_name is reserved");
    }
    if state.display_name_taken(&name, Some(&user.id)) {
        return fail(409, "display_name is already taken");
    }
    let Some(stored) = state.user_by_email_mut(&user.email) else { return fail(404, "User not found") };
    stored.display_name = Some(name);
    let stored = stored.clone();
    ok(user_response(&stored))
}

// --- Uploads -------------------------------------------------------------------

fn title_of(form: &Form) -> Result<String, Answer> {
    let Some(title) = string_or_null(form_text(form, "title")) else {
        return Err(fail(400, "Title is required"));
    };
    if js_length(&title) > MAX_TITLE_LENGTH {
        return Err(fail(400, &format!("Title must be {MAX_TITLE_LENGTH} characters or less")));
    }
    Ok(title)
}

fn ends_with_ignoring_case(name: &str, suffix: &str) -> bool {
    name.to_lowercase().ends_with(suffix)
}

fn thumbnail_of(form: &Form) -> Result<(), Answer> {
    let Some(thumbnail) = form_file(form, "thumbnail") else {
        return Err(fail(400, "Thumbnail (.jpg) is required"));
    };
    if !(ends_with_ignoring_case(&thumbnail.filename, ".jpg")
        || ends_with_ignoring_case(&thumbnail.filename, ".jpeg"))
    {
        return Err(fail(400, "Thumbnail must be a .jpg file"));
    }
    if thumbnail.bytes.len() > MAX_THUMBNAIL_SIZE {
        return Err(fail(400, "Thumbnail exceeds 2MB"));
    }
    Ok(())
}

fn json_file_of(form: &Form) -> Result<&super::http::FormFile, Answer> {
    let Some(json) = form_file(form, "json") else { return Err(fail(400, "JSON file is required")) };
    if json.bytes.len() > MAX_FILE_SIZE {
        return Err(fail(400, "JSON file exceeds 10MB"));
    }
    if !ends_with_ignoring_case(&json.filename, ".json") {
        return Err(fail(400, "JSON file must have .json extension"));
    }
    Ok(json)
}

fn file_entry(file_type: &str, file: &super::http::FormFile) -> PostFile {
    PostFile {
        file_type: file_type.to_owned(),
        original_filename: file.filename.clone(),
        file_size: file.bytes.len(),
    }
}

/// What an upload of `post_type` holds: an analytics post, a feature post
/// or a keyboard post.
fn post_content(
    form: &Form,
    post_type: Option<&str>,
    keyboard_name: Option<String>,
) -> Result<PostContent, Answer> {
    let title = title_of(form)?;
    let plain = |post_type: &str, files, keyboard_name| PostContent {
        title: title.clone(),
        keyboard_name,
        post_type: post_type.to_owned(),
        files,
        keyboard_uid: None,
        total_keystrokes: None,
        range_from_ms: None,
        range_to_ms: None,
    };
    if post_type == Some("analytics") {
        thumbnail_of(form)?;
        let json = json_file_of(form)?;
        let index =
            parse_analytics_export(&String::from_utf8_lossy(&json.bytes)).map_err(|err| fail(400, &err))?;
        return Ok(PostContent {
            title,
            // The keyboard name of an analytics post comes from its export.
            keyboard_name: Some(index.product_name),
            post_type: "analytics".to_owned(),
            files: vec![file_entry("json", json)],
            keyboard_uid: Some(index.keyboard_uid),
            total_keystrokes: Some(index.total_keystrokes),
            range_from_ms: Some(index.range_from_ms),
            range_to_ms: Some(index.range_to_ms),
        });
    }
    if let Some(feature) = post_type.filter(|post_type| FEATURE_POST_TYPES.contains(post_type)) {
        let json = json_file_of(form)?;
        if let Some(err) = feature_json_error(&json.bytes) {
            return Err(fail(400, err));
        }
        return Ok(plain(feature, vec![file_entry("json", json)], keyboard_name));
    }
    thumbnail_of(form)?;
    let mut files = Vec::new();
    for file_type in KEYBOARD_FILE_TYPES {
        let Some(file) = form_file(form, file_type) else {
            return Err(fail(400, &format!("File \"{file_type}\" is required")));
        };
        if file.bytes.len() > MAX_FILE_SIZE {
            return Err(fail(400, &format!("File \"{file_type}\" exceeds 10MB")));
        }
        if !ends_with_ignoring_case(&file.filename, &format!(".{file_type}")) {
            return Err(fail(400, &format!("File \"{file_type}\" must have .{file_type} extension")));
        }
        files.push(file_entry(file_type, file));
    }
    Ok(plain("keyboard", files, keyboard_name))
}

/// The request's account, which must have a display name to upload.
fn uploader(state: &State, request: &Request<'_>) -> Result<User, Answer> {
    let user = authenticate(state, request)?;
    if user.display_name.as_deref().is_some_and(|name| !name.is_empty()) {
        Ok(user)
    } else {
        Err(fail(400, "Display name is required to upload"))
    }
}

/// The form of an upload with its keyboard name.
fn upload_form(request: &Request<'_>) -> Result<(Form, Option<String>), Answer> {
    let form = read_form(request);
    let keyboard_name = string_or_null(form_text(&form, "keyboard_name"));
    if keyboard_name.as_deref().is_some_and(|name| js_length(name) > MAX_KEYBOARD_NAME_LENGTH) {
        return Err(fail(
            400,
            &format!("Keyboard name must be {MAX_KEYBOARD_NAME_LENGTH} characters or less"),
        ));
    }
    Ok((form, keyboard_name))
}

/// The index of the post `id` when its account is active (the Hub joins on
/// active accounts).
fn active_post(state: &State, id: &str) -> Option<usize> {
    let index = state.posts.iter().position(|post| post.id == id)?;
    state.user_by_id(&state.posts[index].uploaded_by).is_some_and(|user| user.active).then_some(index)
}

// --- /api/files ----------------------------------------------------------------

pub fn my_posts(state: &State, request: &Request<'_>) -> Answer {
    let user = check!(authenticate(state, request));
    let (page, per_page) = pagination(request);
    let posts = state.posts_of(&user.id);
    let items = page_of(&posts, page, per_page).into_iter().map(|post| state.public_post(post)).collect();
    ok(object([
        ("items", Value::Array(items)),
        ("total", Value::Number(posts.len() as f64)),
        ("page", Value::Number(page)),
        ("per_page", Value::Number(per_page)),
    ]))
}

pub fn my_keyboard_posts(state: &State, request: &Request<'_>) -> Answer {
    let user = check!(authenticate(state, request));
    let Some(name) = request.query("name").map(js_trim).filter(|name| !name.is_empty()) else {
        return fail(400, "Query parameter \"name\" is required");
    };
    if js_length(&name) > MAX_KEYBOARD_NAME_LENGTH {
        return fail(400, &format!("Keyboard name must be {MAX_KEYBOARD_NAME_LENGTH} characters or less"));
    }
    let posts = state
        .posts_of(&user.id)
        .into_iter()
        .filter(|post| post.content.keyboard_name.as_deref() == Some(name.as_str()))
        .take(MAX_USER_KEYBOARD_POSTS)
        .map(|post| state.public_post(post))
        .collect();
    ok(Value::Array(posts))
}

pub fn get_post(state: &State, id: &str) -> Answer {
    match active_post(state, id) {
        Some(index) => ok(state.public_post(&state.posts[index])),
        None => fail(404, "Post not found"),
    }
}

pub fn create_post(state: &mut State, request: &Request<'_>) -> Answer {
    let user = check!(uploader(state, request));
    let (form, keyboard_name) = check!(upload_form(request));
    let content = check!(post_content(&form, form_text(&form, "post_type"), keyboard_name));
    let post = state.new_post(content, &user.id, None);
    let answer = state.public_post(&post);
    state.posts.push(post);
    ok_with(201, answer)
}

/// The index of the post `id` of the request's account.
fn own_post(state: &State, user: &User, id: &str) -> Result<usize, Answer> {
    let index = active_post(state, id).ok_or_else(|| fail(404, "Post not found"))?;
    if state.posts[index].uploaded_by != user.id {
        return Err(fail(403, "Forbidden"));
    }
    Ok(index)
}

pub fn update_post(state: &mut State, request: &Request<'_>, id: &str) -> Answer {
    let user = check!(uploader(state, request));
    let index = check!(own_post(state, &user, id));
    let (form, keyboard_name) = check!(upload_form(request));
    // The post keeps its type: the form's `post_type` is not read.
    let post_type =
        Some(state.posts[index].content.post_type.clone()).filter(|post_type| post_type != "keyboard");
    let content = check!(post_content(&form, post_type.as_deref(), keyboard_name));
    let stamp = state.stamp(None);
    let post = &mut state.posts[index];
    post.content = content;
    post.updated_at = stamp;
    ok(state.public_post(&state.posts[index]))
}

pub fn patch_post(state: &mut State, request: &Request<'_>, id: &str) -> Answer {
    let user = check!(authenticate(state, request));
    let index = check!(own_post(state, &user, id));
    let body = check!(read_json_object(request));
    let mut title = None;
    let mut keyboard_name = None;
    if body.contains_key("title") {
        let Some(text) = body.get("title").and_then(Value::as_str).filter(|text| !js_trim(text).is_empty())
        else {
            return fail(400, "Title must be a non-empty string");
        };
        let text = js_trim(text);
        if js_length(&text) > MAX_TITLE_LENGTH {
            return fail(400, &format!("Title must be {MAX_TITLE_LENGTH} characters or less"));
        }
        title = Some(text);
    }
    if let Some(value) = body.get("keyboard_name") {
        if !matches!(value, Value::Null | Value::String(_)) {
            return fail(400, "Keyboard name must be a string or null");
        }
        let name = string_or_null(value.as_str());
        if name.as_deref().is_some_and(|name| js_length(name) > MAX_KEYBOARD_NAME_LENGTH) {
            return fail(
                400,
                &format!("Keyboard name must be {MAX_KEYBOARD_NAME_LENGTH} characters or less"),
            );
        }
        keyboard_name = Some(name);
    }
    if title.is_none() && keyboard_name.is_none() {
        return fail(400, "No fields to update");
    }
    let stamp = state.stamp(None);
    let post = &mut state.posts[index];
    if let Some(title) = title {
        post.content.title = title;
    }
    if let Some(name) = keyboard_name {
        post.content.keyboard_name = name;
    }
    post.updated_at = stamp;
    ok(state.public_post(&state.posts[index]))
}

pub fn delete_post(state: &mut State, request: &Request<'_>, id: &str) -> Answer {
    let user = check!(authenticate(state, request));
    let index = check!(own_post(state, &user, id));
    let post = state.posts.remove(index);
    ok(object([("id", Value::from(post.id.as_str()))]))
}

// --- /api/private/files --------------------------------------------------------

pub fn create_private(state: &mut State, request: &Request<'_>) -> Answer {
    let user = check!(uploader(state, request));
    let (form, keyboard_name) = check!(upload_form(request));
    let expires = if form_has(&form, "expires_in_days") {
        Some(form_text(&form, "expires_in_days").ok_or(()))
    } else {
        None
    };
    let days = match parse_expires_in_days(expires) {
        Ok(days) => days,
        Err(err) => return fail(400, &err),
    };
    let content = check!(post_content(&form, form_text(&form, "post_type"), keyboard_name));
    let token = state.private_token();
    let mut post: Post = state.new_post(content, &user.id, None);
    let expires_at = state.expires_at(days);
    post.private = Some((token.clone(), expires_at.clone()));
    let answer = object([
        ("id", Value::from(post.id.as_str())),
        ("token", Value::from(token.as_str())),
        ("url", Value::from(format!("/private/post/{}?token={token}", post.id))),
        ("expires_at", Value::from(expires_at)),
    ]);
    state.private_posts.push(post);
    ok_with(201, answer)
}

pub fn delete_private(state: &mut State, request: &Request<'_>, id: &str) -> Answer {
    let user = check!(authenticate(state, request));
    let Some(index) = state.private_posts.iter().position(|post| post.id == id) else {
        return fail(404, "Not found");
    };
    if state.private_posts[index].uploaded_by != user.id {
        return fail(403, "Forbidden");
    }
    state.private_posts.remove(index);
    ok(object([("id", Value::from(id))]))
}
