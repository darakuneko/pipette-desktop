// SPDX-License-Identifier: GPL-2.0-or-later
//! The authorization request of `generateAuthUrl`
//! (src/main/sync/google-auth.ts): a PKCE code verifier of 32 random bytes
//! in base64url, its S256 challenge, a state of 16 random bytes in hex, and
//! the URL with the parameters in the same order and encoding
//! (URLSearchParams).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{CLIENT_ID, SCOPE};

/// One authorization attempt's secrets and URL.
pub struct AuthRequest {
    pub url: String,
    pub code_verifier: Zeroizing<String>,
    pub state: String,
}

/// The redirect URI of a loopback listener on `port`.
pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// `randomBytes(32).toString('base64url')`.
pub fn code_verifier(random: &[u8; 32]) -> Zeroizing<String> {
    Zeroizing::new(URL_SAFE_NO_PAD.encode(random))
}

/// The S256 challenge of `verifier`.
pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// `randomBytes(16).toString('hex')`.
pub fn state(random: &[u8; 16]) -> String {
    hex::encode(random)
}

/// The authorization URL at `endpoint` for a listener on `port`.
pub fn auth_url(endpoint: &str, port: u16, challenge: &str, state: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri(port))
        .append_pair("scope", SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .finish();
    format!("{endpoint}?{query}")
}

/// A new request with fresh random values from the OS.
pub fn new_auth_request(endpoint: &str, port: u16) -> Result<AuthRequest, getrandom::Error> {
    let mut verifier_bytes = Zeroizing::new([0u8; 32]);
    let mut state_bytes = [0u8; 16];
    getrandom::fill(verifier_bytes.as_mut_slice())?;
    getrandom::fill(&mut state_bytes)?;
    let code_verifier = code_verifier(&verifier_bytes);
    let state = state(&state_bytes);
    let url = auth_url(endpoint, port, &code_challenge(&code_verifier), &state);
    Ok(AuthRequest { url, code_verifier, state })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_verifier_and_state_have_the_electron_lengths() {
        let request = new_auth_request("https://example.invalid/auth", 8080).unwrap();
        assert_eq!(request.code_verifier.len(), 43);
        assert!(request.code_verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_eq!(request.state.len(), 32);
        assert!(request.state.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    }

    #[test]
    fn each_request_has_its_own_state_and_verifier() {
        let a = new_auth_request("https://example.invalid/auth", 8080).unwrap();
        let b = new_auth_request("https://example.invalid/auth", 8080).unwrap();
        assert_ne!(a.state, b.state);
        assert_ne!(*a.code_verifier, *b.code_verifier);
    }

    #[test]
    fn the_challenge_is_the_s256_of_the_verifier() {
        assert_eq!(code_challenge("pipette-verifier"), "FaCGFc9-DPt9TAC-YqGwnaYl5aeo-jYgnD7_gKWIe_Y");
    }
}
