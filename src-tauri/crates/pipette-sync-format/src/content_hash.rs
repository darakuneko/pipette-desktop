// SPDX-License-Identifier: GPL-2.0-or-later
//! SHA-256 digests in the lowercase hex form Node's
//! `createHash('sha256').update(text).digest('hex')` produces.

use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256 of the concatenation of `parts`, with no separator.
pub fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}

/// Hash of an entry body's text (snapshots, analyze filters and the other entry
/// stores): the SHA-256 of its UTF-8 bytes exactly as stored. The text is not
/// normalized, so whitespace and key order change the hash.
pub fn content_hash(text: &str) -> String {
    sha256_hex(&[text.as_bytes()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_the_empty_string() {
        assert_eq!(content_hash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn concatenates_parts_without_a_separator() {
        assert_eq!(sha256_hex(&[b"ab", b"c"]), content_hash("abc"));
    }
}
