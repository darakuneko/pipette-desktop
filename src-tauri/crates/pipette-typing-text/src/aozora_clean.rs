// SPDX-License-Identifier: GPL-2.0-or-later
//! `cleanAozoraText` of src/main/aozora/aozora-clean.ts: a decoded Aozora
//! Bunko text to plain text for the Typing Test. Each step matches the
//! regular expression of the TypeScript step by step, written out by hand
//! over UTF-16 code units (no regex engine, whose `\s`, `.` and `^` differ
//! from JavaScript's).

use pipette_entry_store::{is_js_whitespace, trim_js_whitespace};

use crate::units::{
    LF, REPLACEMENT_CHARACTER, bmp, find, find_unit, join_lines, normalize_newlines, push_code_point,
};

/// A gaiji note named a code point past U+10FFFF, on which
/// `String.fromCodePoint` throws (`RangeError: Invalid code point …`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Invalid code point {0}")]
pub struct InvalidCodePoint(pub u32);

/// The legend block's opening rule must start within this many lines of the
/// file, so a pair of dashed rules deep in the body (a scene break) is kept.
const HEADER_SCAN_LIMIT: usize = 30;

const DASH: u16 = b'-' as u16;
const COLOPHON: [u16; 2] = bmp("底本");
const COLONS: [u16; 2] = bmp("：:");
const COLOPHON_INDENT: [u16; 3] = bmp(" \t　");
const END_OF_BODY: [u16; 8] = bmp("［＃本文終わり］");
const WARICHU_OPEN: [u16; 6] = bmp("［＃割り注］");
const WARICHU_CLOSE: [u16; 9] = bmp("［＃割り注終わり］");
const FULLWIDTH_PARENS: [u16; 2] = bmp("（）");
const RUBY_OPEN: u16 = bmp::<1>("《")[0];
const RUBY_CLOSE: u16 = bmp::<1>("》")[0];
const RUBY_START: u16 = bmp::<1>("｜")[0];
const GAIJI_OPEN: [u16; 3] = bmp("※［＃");
const BRACKETS: [u16; 2] = bmp("［］");
const ANNOTATION_OPEN: [u16; 2] = bmp("［＃");
const CODE_POINT_PREFIX: [u16; 2] = bmp("U+");
const REPEAT_VOICED: [u16; 3] = bmp("／″＼");
const REPEAT_VOICED_TO: [u16; 2] = bmp("〴〵");
const REPEAT: [u16; 2] = bmp("／＼");
const REPEAT_TO: [u16; 2] = bmp("〳〵");
const RULE_CHARS: [u16; 4] = bmp("-＝=―");

/// The pipeline of `cleanAozoraText`, step by step.
pub fn clean_aozora_text(raw: &[u16]) -> Result<Vec<u16>, InvalidCodePoint> {
    let text = normalize_newlines(raw);
    let text = remove_header(&text);
    let text = remove_footer(text);
    let text = resolve_warichu(text);
    let text = remove_ruby(&text);
    let text = resolve_gaiji(text)?;
    let text = replace_all(replace_all(text, &REPEAT_VOICED, &REPEAT_VOICED_TO), &REPEAT, &REPEAT_TO);
    let mut text = remove_annotations(text);
    text.retain(|&unit| unit != REPLACEMENT_CHARACTER);
    Ok(trim_edges(&text))
}

fn is_blank(line: &[u16]) -> bool {
    trim_js_whitespace(line).is_empty()
}

/// `/^-{30,}$/`.
fn is_dash_rule(line: &[u16]) -> bool {
    line.len() >= 30 && line.iter().all(|&unit| unit == DASH)
}

/// `removeHeader`: drops the lines before the first blank one (the title
/// and author), then the legend block between two dashed rules when the
/// opening one starts within [`HEADER_SCAN_LIMIT`] lines of the file.
fn remove_header(text: &[u16]) -> Vec<u16> {
    let lines: Vec<&[u16]> = text.split(|&unit| unit == LF).collect();
    let title_end = lines.iter().position(|line| is_blank(line)).unwrap_or(lines.len());
    let body = &lines[title_end..];
    let scan_end = HEADER_SCAN_LIMIT.saturating_sub(title_end);
    let Some(open) = body.iter().take(scan_end).position(|line| is_dash_rule(line)) else {
        return join_lines(body);
    };
    let Some(close) = body.iter().skip(open + 1).position(|line| is_dash_rule(line)) else {
        return join_lines(body);
    };
    join_lines(&[&body[..open], &body[open + close + 2..]].concat())
}

/// A line terminator of a JavaScript regular expression (`^` with `/m`,
/// what `.` does not match).
fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// Whether `/^[ \t　]*底本[：:]/m` matches at the start of `line`.
fn is_colophon_line(line: &[u16]) -> bool {
    let indent = line.iter().position(|unit| !COLOPHON_INDENT.contains(unit)).unwrap_or(line.len());
    let rest = &line[indent..];
    rest.starts_with(&COLOPHON) && rest.get(COLOPHON.len()).is_some_and(|unit| COLONS.contains(unit))
}

/// `removeFooter`: cuts the text at the first line that is the colophon
/// (`底本：`) or holds the end-of-body marker. Both searches of the
/// TypeScript match at a line start, so the earlier of the two is the
/// first line that satisfies either.
fn remove_footer(mut text: Vec<u16>) -> Vec<u16> {
    let mut start = 0;
    loop {
        let end = text[start..]
            .iter()
            .position(|&unit| is_line_terminator(unit))
            .map_or(text.len(), |at| start + at);
        let line = &text[start..end];
        if is_colophon_line(line) || find(line, &END_OF_BODY, 0).is_some() {
            text.truncate(start);
            return text;
        }
        if end == text.len() {
            return text;
        }
        start = end + 1;
    }
}

/// `resolveWarichu`: `［＃割り注］X［＃割り注終わり］` becomes `（X）`, or X
/// when it already is in full-width parentheses.
fn resolve_warichu(text: Vec<u16>) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while let Some(open) = find(&text, &WARICHU_OPEN, i) {
        let content_start = open + WARICHU_OPEN.len();
        // Without a closing marker after this one, none after a later one.
        let Some(close) = find(&text, &WARICHU_CLOSE, content_start) else { break };
        out.extend_from_slice(&text[i..open]);
        let content = &text[content_start..close];
        let wrapped = content.len() >= 2
            && content[0] == FULLWIDTH_PARENS[0]
            && content[content.len() - 1] == FULLWIDTH_PARENS[1];
        if wrapped {
            out.extend_from_slice(content);
        } else {
            out.push(FULLWIDTH_PARENS[0]);
            out.extend_from_slice(content);
            out.push(FULLWIDTH_PARENS[1]);
        }
        i = close + WARICHU_CLOSE.len();
    }
    if i == 0 {
        return text;
    }
    out.extend_from_slice(&text[i..]);
    out
}

/// `removeRuby`: drops `《…》` spans and every `｜`.
fn remove_ruby(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    // Once no `》` follows some `《`, none follows a later one.
    let mut unclosed = false;
    let mut i = 0;
    while i < text.len() {
        let unit = text[i];
        if unit == RUBY_START {
            i += 1;
            continue;
        }
        if unit == RUBY_OPEN && !unclosed {
            match find_unit(text, RUBY_CLOSE, i + 1) {
                Some(close) => {
                    i = close + 1;
                    continue;
                }
                None => unclosed = true,
            }
        }
        out.push(unit);
        i += 1;
    }
    out
}

/// The code point of the first `U+` with 4 to 6 hex digits in a gaiji note
/// (`/U\+([0-9A-Fa-f]{4,6})/`).
fn gaiji_code_point(content: &[u16]) -> Option<u32> {
    let mut from = 0;
    while let Some(at) = find(content, &CODE_POINT_PREFIX, from) {
        let digits: Vec<u32> = content[at + 2..]
            .iter()
            .take(6)
            .map_while(|&unit| char::from_u32(u32::from(unit)).and_then(|c| c.to_digit(16)))
            .collect();
        if digits.len() >= 4 {
            return Some(digits.iter().fold(0, |cp, digit| cp * 16 + digit));
        }
        from = at + 1;
    }
    None
}

/// `resolveGaiji`: `※［＃…］` becomes the code point its `U+XXXX` names, or
/// nothing when it has none (a menkuten reference only).
fn resolve_gaiji(text: Vec<u16>) -> Result<Vec<u16>, InvalidCodePoint> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(open) = find(&text, &GAIJI_OPEN, i) {
        let content_start = open + GAIJI_OPEN.len();
        // Without a `］` after this note, none after a later one.
        let Some(close) = find_unit(&text, BRACKETS[1], content_start) else { break };
        out.extend_from_slice(&text[i..open]);
        if let Some(cp) = gaiji_code_point(&text[content_start..close]) {
            if cp > 0x10_ffff {
                return Err(InvalidCodePoint(cp));
            }
            push_code_point(&mut out, cp);
        }
        i = close + 1;
    }
    if i == 0 {
        return Ok(text);
    }
    out.extend_from_slice(&text[i..]);
    Ok(out)
}

/// `text.replace(/pattern/g, replacement)` for a literal pattern.
fn replace_all(text: Vec<u16>, pattern: &[u16], replacement: &[u16]) -> Vec<u16> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(at) = find(&text, pattern, i) {
        out.extend_from_slice(&text[i..at]);
        out.extend_from_slice(replacement);
        i = at + pattern.len();
    }
    if i == 0 {
        return text;
    }
    out.extend_from_slice(&text[i..]);
    out
}

/// One `replace(/［＃[^［］]*］/g, '')` pass; `None` when nothing matched.
fn remove_innermost_annotations(text: &[u16]) -> Option<Vec<u16>> {
    let mut out = Vec::with_capacity(text.len());
    let mut matched = false;
    let mut i = 0;
    while i < text.len() {
        if text[i..].starts_with(&ANNOTATION_OPEN) {
            let content_start = i + ANNOTATION_OPEN.len();
            let bracket = text[content_start..].iter().position(|unit| BRACKETS.contains(unit));
            if let Some(at) = bracket.filter(|&at| text[content_start + at] == BRACKETS[1]) {
                matched = true;
                i = content_start + at + 1;
                continue;
            }
        }
        out.push(text[i]);
        i += 1;
    }
    matched.then_some(out)
}

/// `removeAnnotations`: strips `［＃…］` from the innermost out until none
/// is left; `［…］` without `＃` stays.
fn remove_annotations(mut text: Vec<u16>) -> Vec<u16> {
    while let Some(next) = remove_innermost_annotations(&text) {
        text = next;
    }
    text
}

/// `/^[-＝=―]+$/` on the trimmed line.
fn is_rule_line(line: &[u16]) -> bool {
    let trimmed = trim_js_whitespace(line);
    !trimmed.is_empty() && trimmed.iter().all(|unit| RULE_CHARS.contains(unit))
}

/// `trimEdges`: drops the rule-only lines, then the blank lines at either
/// end.
fn trim_edges(text: &[u16]) -> Vec<u16> {
    let lines: Vec<&[u16]> = text.split(|&unit| unit == LF).filter(|line| !is_rule_line(line)).collect();
    let start = lines.iter().position(|line| !is_blank(line)).unwrap_or(lines.len());
    let end = lines.iter().rposition(|line| !is_blank(line)).map_or(start, |last| last + 1);
    join_lines(&lines[start..end])
}

/// Whether `text` has anything but whitespace (`text.trim()` is not empty).
pub(crate) fn has_content(text: &[u16]) -> bool {
    text.iter().any(|&unit| !is_js_whitespace(unit))
}

#[cfg(test)]
#[path = "aozora_clean_tests.rs"]
mod tests;
