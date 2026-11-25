//! Fixtures and measurements for the production review diff.
//!
//! The module measures the shipped pipeline (`preview_edit_diff`: decode,
//! tokenize, engine, bounds, render) rather than a bare engine, so a number
//! here describes what a user's review row actually costs. Run the measured
//! table with `cargo test -p host-core measured_diff_fixtures -- --ignored
//! --nocapture`. The environment (CPU, OS, toolchain, release vs debug) is
//! recorded by the caller; these numbers are not a universal guarantee.

use std::time::{Duration, Instant};

use crate::review::{EditPreviewStatus, FileMutationPreview};

/// Line-based document with a stable unique prefix per line.
fn document(prefix: &str, count: usize) -> String {
    let mut text = String::with_capacity(count * 24);
    for index in 0..count {
        text.push_str(&format!("{prefix} line {index} with some payload\n"));
    }
    text
}

/// Replace one line of a document in place.
fn with_edited_line(text: &str, line: usize, replacement: &str) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    let target = line.min(lines.len().saturating_sub(1));
    lines[target] = replacement;
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

struct Fixture {
    name: &'static str,
    before: String,
    after: String,
}

fn fixtures() -> Vec<Fixture> {
    let small_before = document("small", 60);
    let small_after = with_edited_line(&small_before, 30, "small line 30 edited");

    let sparse_before = document("sparse", 5_000);
    let mut sparse_after = sparse_before
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    for index in [10, 900, 2_400, 4_100] {
        sparse_after[index] = format!("sparse line {index} edited");
    }
    let mut sparse_after = sparse_after.join("\n");
    sparse_after.push('\n');

    // No unique anchor line on either side: a histogram/Myers pathology.
    let mut repeat_before = String::new();
    let mut repeat_after = String::new();
    for index in 0..20_000 {
        repeat_before.push_str(if index % 3 == 0 { "a\n" } else { "b\n" });
        repeat_after.push_str(if index % 3 == 1 { "a\n" } else { "b\n" });
    }

    let rewrite_before = document("rewrite", 4_000);
    let rewrite_after = document("rewritten", 4_000);

    // 1.34 MB file with a single edited line: the shape users hit most.
    let long = document("long", 40_000);
    let long_after = with_edited_line(&long, 10_000, "long line 10000 edited");

    let crlf_before = "alpha\r\nbeta\r\ngamma\r\n".to_string();
    let crlf_after = "alpha\nbeta\ngamma\n".to_string();

    vec![
        Fixture {
            name: "small_edit",
            before: small_before,
            after: small_after,
        },
        Fixture {
            name: "sparse_edits",
            before: sparse_before,
            after: sparse_after,
        },
        Fixture {
            name: "repeat_lines",
            before: repeat_before,
            after: repeat_after,
        },
        Fixture {
            name: "all_rewrite",
            before: rewrite_before,
            after: rewrite_after,
        },
        Fixture {
            name: "doc_1_34mb",
            before: long,
            after: long_after,
        },
        Fixture {
            name: "crlf_only",
            before: crlf_before,
            after: crlf_after,
        },
    ]
}

fn preview(before: &str, after: &str) -> FileMutationPreview {
    crate::review::preview_edit_diff(
        "fixture.txt".to_string(),
        "workspace".to_string(),
        EditPreviewStatus::Modified,
        before.as_bytes(),
        Some(after.as_bytes()),
    )
}

/// Median wall-clock of one full pipeline run.
fn median_ms(before: &str, after: &str, iterations: usize) -> Duration {
    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        let preview = preview(before, after);
        std::hint::black_box(&preview);
        samples.push(started.elapsed());
    }
    samples.sort();
    samples[samples.len() / 2]
}

#[test]
#[ignore]
fn measured_diff_fixtures() {
    println!("fixture\tbytes\tlines\tms\tadditions\tdeletions\treason");
    for fixture in fixtures() {
        let ms = median_ms(&fixture.before, &fixture.after, 7);
        let preview = preview(&fixture.before, &fixture.after);
        println!(
            "{}\t{}\t{}\t{:.3}\t{:?}\t{:?}\t{:?}",
            fixture.name,
            fixture.before.len(),
            fixture.before.lines().count(),
            ms.as_secs_f64() * 1_000.0,
            preview.additions,
            preview.deletions,
            preview.reason,
        );
    }
}

/// The most common user shape: a long file with one edited line keeps its
/// exact counts and hunk instead of reporting a size limit.
#[test]
fn a_1_34_mb_tiny_edit_keeps_its_hunk() {
    let fixture = fixtures()
        .into_iter()
        .find(|fixture| fixture.name == "doc_1_34mb")
        .expect("fixture");
    assert!(fixture.before.len() > 1_000_000);
    let preview = preview(&fixture.before, &fixture.after);
    assert_eq!(preview.reason, None);
    assert_eq!(preview.additions, Some(1));
    assert_eq!(preview.deletions, Some(1));
    assert_eq!(preview.hunks.len(), 1);
    assert!(preview.hunks[0]
        .lines
        .iter()
        .any(|line| line.line_type == "add"));
}

/// A whole rewrite keeps exact counts but no body, as before.
#[test]
fn a_whole_rewrite_keeps_counts_without_hunks() {
    let fixture = fixtures()
        .into_iter()
        .find(|fixture| fixture.name == "all_rewrite")
        .expect("fixture");
    let preview = preview(&fixture.before, &fixture.after);
    assert_eq!(preview.additions, Some(4_000));
    assert_eq!(preview.deletions, Some(4_000));
    assert!(preview.hunks.is_empty());
    assert_eq!(
        preview.reason,
        Some(crate::review::ReviewDiffLimit::DiffTooLarge)
    );
}

/// A file without unique anchors resolves inside the per-file deadline.
#[test]
fn repeated_lines_resolve_within_the_file_deadline() {
    let fixture = fixtures()
        .into_iter()
        .find(|fixture| fixture.name == "repeat_lines")
        .expect("fixture");
    let preview = preview(&fixture.before, &fixture.after);
    assert_eq!(preview.reason, None);
    let (additions, deletions) = (preview.additions.unwrap(), preview.deletions.unwrap());
    assert!(additions > 0 && deletions > 0);
    assert!(additions < 20_000 && deletions < 20_000);
}

/// CRLF and LF text compare as the same lines: a line-ending-only rewrite has
/// no line change, exactly as `str::lines()` reads both.
#[test]
fn a_crlf_only_change_has_no_line_change() {
    let fixture = fixtures()
        .into_iter()
        .find(|fixture| fixture.name == "crlf_only")
        .expect("fixture");
    let preview = preview(&fixture.before, &fixture.after);
    assert_eq!(preview.reason, None);
    assert_eq!(preview.additions, Some(0));
    assert_eq!(preview.deletions, Some(0));
    assert!(preview.hunks.is_empty());
}

/// The same bytes always produce the same counts and hunk bodies.
#[test]
fn the_pipeline_is_deterministic() {
    let fixture = fixtures()
        .into_iter()
        .find(|fixture| fixture.name == "sparse_edits")
        .expect("fixture");
    let first = preview(&fixture.before, &fixture.after);
    let second = preview(&fixture.before, &fixture.after);
    assert_eq!(first.additions, second.additions);
    assert_eq!(first.deletions, second.deletions);
    assert_eq!(
        first
            .hunks
            .iter()
            .map(|hunk| hunk.header.clone())
            .collect::<Vec<_>>(),
        second
            .hunks
            .iter()
            .map(|hunk| hunk.header.clone())
            .collect::<Vec<_>>()
    );
}
