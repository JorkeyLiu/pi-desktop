use super::diff::{make_preview, DiffSide, PreviewLimits, MAX_RECORD_HUNK_CHARS};
use super::*;
use serde_json::json;
use std::fs;
use std::time::{Duration, Instant};
use tempfile::tempdir;

fn preview(before: &[u8], after: &[u8]) -> diff::ReviewPreview {
    make_preview(
        DiffSide::Present(before.to_vec()),
        DiffSide::Present(after.to_vec()),
        MAX_RECORD_HUNK_CHARS,
        &mut PreviewLimits::file(Instant::now()),
    )
}

fn assert_nul_text_change(after: &[u8]) {
    let result = preview(b"plain\n", after);
    assert!(!result.binary, "valid UTF-8 with NUL is text: {after:?}");
    assert!(!result.truncated);
    assert_eq!(result.reason, None);
    assert_eq!(result.additions, Some(1));
    assert_eq!(result.deletions, Some(1));
    assert_eq!(result.hunks.len(), 1);
    let lines: Vec<_> = result.hunks[0]
        .lines
        .iter()
        .map(|line| (line.line_type.as_str(), line.text.as_str()))
        .collect();
    assert_eq!(
        lines,
        vec![
            ("del", "plain"),
            (
                "add",
                std::str::from_utf8(after)
                    .unwrap()
                    .strip_suffix('\n')
                    .unwrap_or(std::str::from_utf8(after).unwrap())
            ),
        ],
        "raw NUL participates in the hunk without transcoding"
    );
}

#[test]
fn valid_utf8_nul_is_text_at_every_line_position() {
    for after in [
        b"\0start\n".as_slice(),
        b"mid\0dle\n".as_slice(),
        b"end\0\n".as_slice(),
        b"two\0nul\0s\n".as_slice(),
        b"\0\n".as_slice(),
        "parent\0/workspace/source.txt\n".as_bytes(),
    ] {
        assert_nul_text_change(after);
    }
}

#[test]
fn nul_only_line_is_counted_and_kept_raw() {
    let result = preview(b"\0", b"\0\n");
    assert!(!result.binary);
    assert_eq!(result.additions, Some(0));
    assert_eq!(result.deletions, Some(0));
    assert!(result.hunks.is_empty());

    let result = preview(b"", b"\0");
    assert!(!result.binary);
    assert_eq!(result.additions, Some(1));
    assert_eq!(result.deletions, Some(0));
    assert_eq!(result.hunks[0].header, "@@ -1,0 +1,1 @@");
    assert_eq!(result.hunks[0].lines[0].text, "\0");
    assert_eq!(
        serde_json::to_value(&result.hunks[0].lines[0].text).unwrap(),
        json!("\0")
    );
}

#[test]
fn invalid_utf8_and_unsupported_utf16_remain_binary() {
    for (before, after) in [
        (b"plain\n".as_slice(), b"bad\xff\n".as_slice()),
        (b"bad\xff\n".as_slice(), b"plain\n".as_slice()),
        (b"plain\n".as_slice(), b"\xff\xfea\0b\0".as_slice()),
        (b"plain\n".as_slice(), b"\xfe\xff\0a\0b".as_slice()),
        (b"\xff\xfea\0".as_slice(), b"\xfe\xff\0a".as_slice()),
    ] {
        let result = preview(before, after);
        assert!(
            result.binary,
            "unsupported bytes must stay binary: {after:?}"
        );
        assert!(!result.truncated);
        assert_eq!(result.additions, None);
        assert_eq!(result.deletions, None);
        assert!(result.hunks.is_empty());
    }
}

#[test]
fn expired_deadline_prevents_decode_classification_and_counts() {
    for after in [
        b"changed\n".as_slice(),
        b"changed\0\n".as_slice(),
        b"bad\xff\n".as_slice(),
    ] {
        let result = make_preview(
            DiffSide::Present(b"before\n".to_vec()),
            DiffSide::Present(after.to_vec()),
            MAX_RECORD_HUNK_CHARS,
            &mut PreviewLimits::file(Instant::now() - Duration::from_secs(1)),
        );
        assert!(!result.binary);
        assert!(result.truncated);
        assert_eq!(result.reason, Some(ReviewDiffLimit::DiffTooComplex));
        assert_eq!(result.additions, None);
        assert_eq!(result.deletions, None);
        assert!(result.hunks.is_empty());
    }
}

#[test]
fn nul_review_rollback_restores_exact_bytes() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("nul.txt");
    let before = b"first\0line\r\nlast\0";
    fs::write(&target, before).unwrap();
    let pending = prepare_change(
        data.path(),
        "s1",
        "m1",
        Some(workspace.path()),
        None,
        "Edit",
        &json!({ "path": "nul.txt" }),
    )
    .unwrap()
    .unwrap();
    let after = b"first\0line\r\nlast\0changed\0\n";
    fs::write(&target, after).unwrap();
    let change = finalize_change(&pending, None).unwrap();
    assert!(!change.binary);
    assert_eq!(change.additions, Some(1));
    assert_eq!(change.deletions, Some(1));
    assert_eq!(change.hunks.len(), 1);
    assert!(change.hunks[0]
        .lines
        .iter()
        .any(|line| line.line_type == "add" && line.text == "last\0changed\0"));
    assert_eq!(fs::read(&target).unwrap(), after);

    let outcome = rollback_change(
        data.path(),
        "s1",
        &change.snapshot_id,
        &SessionRoots::single(workspace.path().to_path_buf()),
    )
    .unwrap();
    assert_eq!(outcome.status, "rolledBack");
    assert_eq!(fs::read(&target).unwrap(), before);
}

#[test]
fn nul_does_not_change_crlf_or_eof_line_semantics() {
    let crlf = preview(b"a\0\r\nb\r\n", b"a\0\nb\n");
    assert!(!crlf.binary);
    assert_eq!(crlf.additions, Some(0));
    assert_eq!(crlf.deletions, Some(0));
    assert!(crlf.hunks.is_empty());

    let eof = preview(b"a\0\n", b"a\0");
    assert!(!eof.binary);
    assert_eq!(eof.additions, Some(0));
    assert_eq!(eof.deletions, Some(0));
    assert!(eof.hunks.is_empty());
}
