//! The committed artifact and its recorded digest cannot drift apart.
//!
//! `../examples/forbidden_tag_dependency.wasm` is a binary in a repository that
//! reviews text, and `…​.wasm.sha256` beside it is the string a `customRules`
//! row pins it by — the mechanism that makes "the law CI ran is the law review
//! saw" checkable (`../../../docs/adr/0002-custom-rules-one-contract.md`). Two
//! files that must agree and no gate comparing them is a pair that silently
//! stops agreeing the first time one of them is rebuilt alone, and the failure
//! surfaces in a CONSUMER's tree as a load error naming a hash nobody here can
//! explain.
//!
//! ## Why SHA-256 is written out below
//!
//! This crate depends on serde and serde_json and means to keep it at that
//! (`../Cargo.toml` argues why). A digest crate for one test would be a third
//! dependency, and shelling out to `sha256sum` would put a system binary in the
//! test's path — so the algorithm is here, held honest by the two published
//! test vectors it is checked against before it is trusted with the artifact. A
//! digest implementation nothing verifies is the worst of both: it would agree
//! with itself no matter what it computed.

use std::path::{Path, PathBuf};

/// The 64 round constants of SHA-256 (FIPS 180-4 §4.2.2).
///
/// Laid out eight to a row, the way the standard prints them, so a reader can
/// check the table against the publication rather than against a column of 64
/// unrelated numbers — which is what rustfmt makes of it, hence the skip.
#[rustfmt::skip]
const ROUND_CONSTANTS: [u32; 64] = [
    0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4, 0xab1c_5ed5,
    0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174,
    0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
    0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967,
    0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85,
    0xa2bf_e8a1, 0xa81a_664b, 0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
    0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
    0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
];

/// The SHA-256 of `message`, as the 64 lowercase hex characters a policy row's
/// `sha256` field holds.
fn sha256_hex(message: &[u8]) -> String {
    let mut state: [u32; 8] = [
        0x6a09_e667,
        0xbb67_ae85,
        0x3c6e_f372,
        0xa54f_f53a,
        0x510e_527f,
        0x9b05_688c,
        0x1f83_d9ab,
        0x5be0_cd19,
    ];

    let mut padded = message.to_vec();
    let bit_length = (message.len() as u64) * 8;
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_length.to_be_bytes());

    for block in padded.chunks_exact(64) {
        let mut schedule = [0_u32; 64];
        for (word, bytes) in schedule.iter_mut().zip(block.chunks_exact(4)) {
            *word = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for index in 16..64 {
            let left = schedule[index - 15];
            let right = schedule[index - 2];
            let sigma0 = left.rotate_right(7) ^ left.rotate_right(18) ^ (left >> 3);
            let sigma1 = right.rotate_right(17) ^ right.rotate_right(19) ^ (right >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(sigma0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(sigma1);
        }

        let mut working = state;
        for (constant, word) in ROUND_CONSTANTS.iter().zip(&schedule) {
            let sum1 = working[4].rotate_right(6)
                ^ working[4].rotate_right(11)
                ^ working[4].rotate_right(25);
            let choose = (working[4] & working[5]) ^ (!working[4] & working[6]);
            let temp1 = working[7]
                .wrapping_add(sum1)
                .wrapping_add(choose)
                .wrapping_add(*constant)
                .wrapping_add(*word);
            let sum0 = working[0].rotate_right(2)
                ^ working[0].rotate_right(13)
                ^ working[0].rotate_right(22);
            let majority =
                (working[0] & working[1]) ^ (working[0] & working[2]) ^ (working[1] & working[2]);
            let temp2 = sum0.wrapping_add(majority);

            working[7] = working[6];
            working[6] = working[5];
            working[5] = working[4];
            working[4] = working[3].wrapping_add(temp1);
            working[3] = working[2];
            working[2] = working[1];
            working[1] = working[0];
            working[0] = temp1.wrapping_add(temp2);
        }
        for (slot, value) in state.iter_mut().zip(working) {
            *slot = slot.wrapping_add(value);
        }
    }

    state.iter().map(|word| format!("{word:08x}")).collect()
}

fn package_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

#[test]
fn the_digest_agrees_with_the_published_test_vectors() {
    // FIPS 180-4's own examples. Without these, every assertion below would be
    // this file agreeing with itself.
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
}

#[test]
fn the_committed_artifact_hashes_to_the_recorded_digest() {
    let artifact = package_path("examples/forbidden_tag_dependency.wasm");
    let bytes = std::fs::read(&artifact)
        .unwrap_or_else(|error| panic!("{} could not be read: {error}", artifact.display()));

    let recorded_path = package_path("examples/forbidden_tag_dependency.wasm.sha256");
    let recorded = std::fs::read_to_string(&recorded_path)
        .unwrap_or_else(|error| panic!("{} could not be read: {error}", recorded_path.display()));
    let recorded = recorded.trim();

    assert_eq!(
        sha256_hex(&bytes),
        recorded,
        "the committed artifact and its recorded digest have drifted apart — rebuild both with \
         ./rebuild-example.sh rather than editing either one"
    );
    assert_eq!(recorded.len(), 64, "a sha256 is 64 hex characters");
    assert!(
        recorded
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "the recorded digest must be lowercase hex, which is how a policy row spells one"
    );
}

#[test]
fn the_committed_artifact_is_a_webassembly_module() {
    // A four-byte check that catches the failures a digest cannot describe: a
    // truncated file, a text placeholder, a pointer left by a large-file
    // filter. All three would hash consistently and load as nothing.
    let bytes = std::fs::read(package_path("examples/forbidden_tag_dependency.wasm"))
        .expect("the committed artifact");
    assert_eq!(
        &bytes[..8],
        &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
        "the artifact does not open with the wasm magic and version 1"
    );
}
