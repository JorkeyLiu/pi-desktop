use super::diff::{
    make_preview, DiffRequest, DiffSide, DiffWork, PreviewLimits, MAX_DIFF_BYTES, MAX_DIFF_LINES,
    MAX_RECORD_HUNK_CHARS, MAX_REQUEST_DIFF_BYTES, MAX_REQUEST_DIFF_TOKENS,
};
use super::layout::{
    metadata_path, now_micros, read_meta, root_identity, session_review_dir, snapshot_dir,
    write_meta,
};
use super::session::{file_changes_with_request, MAX_REVIEW_FILES};
use super::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};
use tempfile::tempdir;

fn prepare(
    data: &Path,
    workspace_root: &Path,
    session: &str,
    message: &str,
    path: &str,
) -> PendingChange {
    prepare_change(
        data,
        session,
        message,
        Some(workspace_root),
        None,
        "Edit",
        &json!({ "path": path }),
    )
    .unwrap()
    .unwrap()
}

fn roots_of(root: &Path) -> SessionRoots {
    SessionRoots::single(root.to_path_buf())
}

fn numbered_lines(count: usize) -> String {
    (0..count).map(|index| format!("line {index}\n")).collect()
}

#[test]
fn records_line_changes_and_rolls_back_without_git() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\ntwo\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\nthree\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    assert_eq!(change.status, ReviewChangeStatus::Modified);
    assert_eq!(change.additions, Some(1));
    assert_eq!(change.deletions, Some(1));
    assert!(change.reversible);
    assert!(!change.truncated);
    assert_eq!(change.reason, None);
    assert!(!change.hunks.is_empty());

    let result = rollback_change(
        data.path(),
        "s1",
        &change.snapshot_id,
        &roots_of(workspace.path()),
    )
    .unwrap();
    assert_eq!(result.status, "rolledBack");
    assert_eq!(
        result.root.as_deref(),
        root_identity(workspace.path()).as_deref()
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "one\ntwo\n");
    let repeated = rollback_change(
        data.path(),
        "s1",
        &change.snapshot_id,
        &roots_of(workspace.path()),
    )
    .unwrap();
    assert_eq!(repeated.status, "alreadyRolledBack");
}

#[test]
fn refuses_to_overwrite_a_later_edit() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "before\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "after\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    fs::write(&target, "later\n").unwrap();
    let result = rollback_change(
        data.path(),
        "s1",
        &change.snapshot_id,
        &roots_of(workspace.path()),
    )
    .unwrap();
    assert_eq!(result.status, "conflict");
    assert_eq!(fs::read_to_string(&target).unwrap(), "later\n");
}

#[test]
fn added_file_rollback_removes_the_file() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "new.txt");
    fs::write(workspace.path().join("new.txt"), "new\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    assert_eq!(change.status, ReviewChangeStatus::Added);
    let result = rollback_change(
        data.path(),
        "s1",
        &change.snapshot_id,
        &roots_of(workspace.path()),
    )
    .unwrap();
    assert_eq!(result.status, "rolledBack");
    assert!(!workspace.path().join("new.txt").exists());
}

#[test]
fn deleted_file_rollback_restores_previous_bytes() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("removed.txt");
    fs::write(&target, "keep me\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "removed.txt");
    fs::remove_file(&target).unwrap();
    let change = finalize_change(&pending, None).unwrap();
    assert_eq!(change.status, ReviewChangeStatus::Deleted);
    assert_eq!(change.additions, Some(0));
    assert_eq!(change.deletions, Some(1));

    let result = rollback_change(
        data.path(),
        "s1",
        &change.snapshot_id,
        &roots_of(workspace.path()),
    )
    .unwrap();
    assert_eq!(result.status, "rolledBack");
    assert_eq!(fs::read_to_string(&target).unwrap(), "keep me\n");
}

#[test]
fn a_long_file_with_one_edited_line_reports_its_real_hunk() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("big.txt");
    let original = numbered_lines(6_000);
    fs::write(&target, &original).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "big.txt");
    fs::write(
        &target,
        original.replace("line 4321\n", "line 4321 changed\n"),
    )
    .unwrap();

    let change = finalize_change(&pending, None).unwrap();
    assert!(!change.truncated, "a bounded change is not truncated");
    assert!(!change.binary);
    assert_eq!(change.additions, Some(1));
    assert_eq!(change.deletions, Some(1));
    assert_eq!(change.hunks.len(), 1);
    assert!(change.hunks[0]
        .lines
        .iter()
        .any(|line| line.line_type == "add" && line.text == "line 4321 changed"));
    assert!(change.hunks[0]
        .lines
        .iter()
        .any(|line| line.line_type == "del" && line.text == "line 4321"));
}

#[test]
fn separated_edits_in_a_long_file_keep_exact_counts() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("big.txt");
    let original = numbered_lines(8_000);
    fs::write(&target, &original).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "big.txt");
    let edited = original
        .replace("line 100\n", "line 100 changed\n")
        .replace("line 7900\n", "line 7900 changed\n");
    fs::write(&target, edited).unwrap();

    let change = finalize_change(&pending, None).unwrap();
    assert!(!change.truncated);
    assert_eq!(change.additions, Some(2));
    assert_eq!(change.deletions, Some(2));
    assert_eq!(change.hunks.len(), 2);
}

#[test]
fn adjacent_edits_share_one_hunk_and_distant_ones_do_not() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    let original = numbered_lines(80);
    fs::write(&target, &original).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(
        &target,
        original
            .replace("line 10\n", "line 10 changed\n")
            .replace("line 11\n", "line 11 changed\n"),
    )
    .unwrap();
    let adjacent = finalize_change(&pending, None).unwrap();
    assert_eq!(adjacent.additions, Some(2));
    assert_eq!(adjacent.deletions, Some(2));
    assert_eq!(adjacent.hunks.len(), 1);

    let other = tempdir().unwrap();
    let other_workspace = tempdir().unwrap();
    let other_target = other_workspace.path().join("src.txt");
    fs::write(&other_target, &original).unwrap();
    let pending = prepare(other.path(), other_workspace.path(), "s1", "m1", "src.txt");
    fs::write(
        &other_target,
        original
            .replace("line 10\n", "line 10 changed\n")
            .replace("line 60\n", "line 60 changed\n"),
    )
    .unwrap();
    let distant = finalize_change(&pending, None).unwrap();
    assert_eq!(distant.hunks.len(), 2);
}

#[test]
fn a_whole_rewrite_keeps_exact_counts_without_hunks() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("big.txt");
    fs::write(&target, numbered_lines(4_000)).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "big.txt");
    let rewritten: String = (0..4_000).map(|index| format!("other {index}\n")).collect();
    fs::write(&target, rewritten).unwrap();

    let change = finalize_change(&pending, None).unwrap();
    assert!(change.truncated);
    // The engine's own edit script is exact, so a rewrite reports its real
    // counts instead of withholding them behind a complexity limit.
    assert_eq!(change.additions, Some(4_000));
    assert_eq!(change.deletions, Some(4_000));
    assert!(change.hunks.is_empty());
    assert_eq!(change.reason, Some(ReviewDiffLimit::DiffTooLarge));
}

#[test]
fn a_long_file_with_one_edited_line_records_a_real_hunk() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("long.txt");
    let original: String = (0..40_000)
        .map(|index| format!("long line {index} with some payload\n"))
        .collect();
    assert!(
        original.len() > 1_000_000,
        "a 1.34 MB file is the shape users hit"
    );
    fs::write(&target, &original).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "long.txt");
    let edited = original.replacen(
        "long line 20000 with some payload",
        "long line 20000 edited",
        1,
    );
    fs::write(&target, edited).unwrap();

    let change = finalize_change(&pending, None).unwrap();
    assert_eq!(change.reason, None, "1.34 MB is inside the input ceiling");
    assert_eq!(change.additions, Some(1));
    assert_eq!(change.deletions, Some(1));
    assert_eq!(change.hunks.len(), 1);
    assert!(change
        .hunks
        .iter()
        .flat_map(|hunk| hunk.lines.iter())
        .any(|line| line.text == "long line 20000 edited"));
}

#[test]
fn a_binary_change_is_reported_as_binary() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("blob.bin");
    fs::write(&target, [0_u8, 1, 2, 3]).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "blob.bin");
    fs::write(&target, [0_u8, 9, 9, 9]).unwrap();

    let change = finalize_change(&pending, None).unwrap();
    assert!(change.binary);
    assert!(!change.truncated);
    assert_eq!(change.additions, None);
    assert!(change.hunks.is_empty());
}

#[test]
fn an_oversized_file_reports_the_byte_limit() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("huge.txt");
    let line = "x".repeat(1_024);
    let mut payload = String::new();
    while payload.len() as u64 <= MAX_DIFF_BYTES {
        payload.push_str(&line);
        payload.push('\n');
    }
    fs::write(&target, &payload).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "huge.txt");
    fs::write(&target, payload.replacen('x', "y", 1)).unwrap();

    let change = finalize_change(&pending, None).unwrap();
    assert!(change.truncated);
    assert_eq!(change.reason, Some(ReviewDiffLimit::FileTooLarge));
    assert_eq!(change.additions, None);
}

/// A review record must stay small enough that the renderer's 64 KiB display
/// trim never reaches its identity fields.
#[test]
fn a_record_keeps_its_identity_fields_under_the_display_cap() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("huge-hunks.txt");
    let long = "y".repeat(300);
    let mut original = String::new();
    let mut edited = String::new();
    for index in 0..400 {
        original.push_str(&format!("{index} {long}\n"));
        edited.push_str(&format!("{index} {long} changed\n"));
    }
    fs::write(&target, &original).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "huge-hunks.txt");
    fs::write(&target, &edited).unwrap();

    let change = finalize_change(&pending, None).unwrap();
    assert!(change.truncated);
    assert_eq!(change.reason, Some(ReviewDiffLimit::DiffTooLarge));
    assert_eq!(change.additions, Some(400), "counts stay exact");
    assert_eq!(change.deletions, Some(400));
    let record = serde_json::to_value(&change).unwrap();
    let record_chars = serde_json::to_string(&record).unwrap().chars().count();
    assert!(
        record_chars < 64 * 1024,
        "a review record must survive display trimming: {record_chars}"
    );
    assert_eq!(record["snapshotId"], json!(change.snapshot_id));
    assert_eq!(record["path"], json!("huge-hunks.txt"));
}

#[test]
fn one_file_row_covers_every_edit_of_the_file() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    let first = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    let first = finalize_change(&first, None).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\nTWO\nTHREE\n").unwrap();
    let second = finalize_change(&second, None).unwrap();

    let files = file_changes(data.path(), "s1", &roots_of(workspace.path())).files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, ReviewChangeStatus::Modified);
    assert_eq!(files[0].additions, Some(2));
    assert_eq!(files[0].deletions, Some(2));
    assert_eq!(
        files[0].snapshot_ids,
        vec![first.snapshot_id.clone(), second.snapshot_id.clone()]
    );
    assert!(files[0].reversible);
}

#[test]
fn a_file_that_ends_up_as_it_started_is_not_a_changed_file() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\ntwo\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\nchanged\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    assert_eq!(change.additions, Some(1));
    fs::write(&target, "one\ntwo\n").unwrap();

    assert!(file_changes(data.path(), "s1", &roots_of(workspace.path()))
        .files
        .is_empty());
}

#[test]
fn the_baseline_stays_the_first_recorded_bytes_not_git_head() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    // The user's own uncommitted work is already in the file before the
    // conversation touches it; only the topic's change belongs in the row.
    fs::write(&target, "user work\nkeep\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "user work\nkeep\ntopic\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    assert_eq!(change.additions, Some(1));

    let files = file_changes(data.path(), "s1", &roots_of(workspace.path())).files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].additions, Some(1));
    assert_eq!(files[0].deletions, Some(0));
    // Only the topic's own line is added; the user's earlier bytes are
    // context, never part of the change.
    assert!(files[0].hunks[0]
        .lines
        .iter()
        .filter(|line| line.line_type != "context")
        .all(|line| line.text == "topic"));
}

#[test]
fn every_touched_file_gets_exactly_one_row() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let first_target = workspace.path().join("a.txt");
    fs::write(&first_target, "a\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "a.txt");
    fs::write(&first_target, "a changed\n").unwrap();
    finalize_change(&pending, None).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m2", "b.txt");
    fs::write(workspace.path().join("b.txt"), "b\n").unwrap();
    finalize_change(&pending, None).unwrap();

    let files = file_changes(data.path(), "s1", &roots_of(workspace.path())).files;
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].path, "a.txt");
    assert_eq!(files[0].status, ReviewChangeStatus::Modified);
    assert_eq!(files[1].path, "b.txt");
    assert_eq!(files[1].status, ReviewChangeStatus::Added);
    assert_eq!(files[1].additions, Some(1));
    assert_eq!(files[0].root, root_identity(workspace.path()));
}

#[test]
fn file_rollback_restores_the_first_baseline_after_several_edits() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\ntwo\n").unwrap();
    let first = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\nTWO\n").unwrap();
    let first = finalize_change(&first, None).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    let second = finalize_change(&second, None).unwrap();
    assert!(first.additions.is_some() && second.additions.is_some());
    let roots = roots_of(workspace.path());

    let outcome = rollback_file(data.path(), "s1", &roots, None, "src.txt").unwrap();
    assert_eq!(outcome.status, "rolledBack");
    assert_eq!(outcome.rolled_back.len(), 2);
    assert_eq!(fs::read_to_string(&target).unwrap(), "one\ntwo\n");

    let repeated = rollback_file(data.path(), "s1", &roots, None, "src.txt").unwrap();
    assert_eq!(repeated.status, "alreadyRolledBack");
    assert!(file_changes(data.path(), "s1", &roots).files.is_empty());
}

#[test]
fn file_rollback_never_overwrites_bytes_it_did_not_record() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\n").unwrap();
    let first = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\ntwo\n").unwrap();
    finalize_change(&first, None).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    finalize_change(&second, None).unwrap();
    fs::write(&target, "edited outside the app\n").unwrap();
    let roots = roots_of(workspace.path());

    let outcome = rollback_file(data.path(), "s1", &roots, None, "src.txt").unwrap();
    assert_eq!(outcome.status, "conflict");
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "edited outside the app\n"
    );
}

#[test]
fn file_rollback_removes_a_file_the_topic_created() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let first = prepare(data.path(), workspace.path(), "s1", "m1", "new.txt");
    fs::write(workspace.path().join("new.txt"), "new\n").unwrap();
    finalize_change(&first, None).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "new.txt");
    fs::write(workspace.path().join("new.txt"), "new\nmore\n").unwrap();
    finalize_change(&second, None).unwrap();
    let roots = roots_of(workspace.path());

    let outcome = rollback_file(data.path(), "s1", &roots, None, "new.txt").unwrap();
    assert_eq!(outcome.status, "rolledBack");
    assert!(!workspace.path().join("new.txt").exists());
}

#[test]
fn a_pruned_baseline_snapshot_stays_explicitly_unavailable() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\n").unwrap();
    let first = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\ntwo\n").unwrap();
    let first = finalize_change(&first, None).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    finalize_change(&second, None).unwrap();
    fs::remove_file(
        snapshot_dir(data.path(), "s1", &first.snapshot_id)
            .unwrap()
            .join("meta.json"),
    )
    .unwrap();
    let roots = roots_of(workspace.path());

    let outcome_files = file_changes(data.path(), "s1", &roots);
    assert_eq!(outcome_files.unreadable_records, 1);
    assert!(
        outcome_files.truncated,
        "the answer states it is incomplete"
    );
    // The removed record cannot be attributed to a file any more, so no row
    // is invented for it; what remains is bounded to the retained records
    // and cannot claim rollback.
    assert_eq!(outcome_files.files.len(), 1);
    assert!(!outcome_files.files[0].reversible);
    assert_eq!(outcome_files.files[0].additions, Some(1));

    let outcome = rollback_file(data.path(), "s1", &roots, None, "src.txt").unwrap();
    assert_eq!(outcome.status, "unavailable");
    assert_eq!(fs::read_to_string(&target).unwrap(), "one\ntwo\nthree\n");
}

#[test]
fn another_sessions_snapshot_is_never_read() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\ntwo\n").unwrap();
    finalize_change(&pending, None).unwrap();

    let roots = roots_of(workspace.path());
    let files = file_changes(data.path(), "s2", &roots).files;
    assert!(
        files.is_empty(),
        "another session's directory is not scanned"
    );
    let outcome = rollback_file(data.path(), "s2", &roots, None, "src.txt").unwrap();
    assert_eq!(outcome.status, "unavailable");
    assert_eq!(fs::read_to_string(&target).unwrap(), "one\ntwo\n");
}

/// The panel must not merge two project roots that share a relative name.
#[test]
fn two_roots_with_the_same_relative_name_stay_distinct() {
    let data = tempdir().unwrap();
    let root_a = tempdir().unwrap();
    let root_b = tempdir().unwrap();
    fs::write(root_a.path().join("shared.ts"), "a0\n").unwrap();
    let pending = prepare(data.path(), root_a.path(), "s1", "m1", "shared.ts");
    fs::write(root_a.path().join("shared.ts"), "a1\n").unwrap();
    let first = finalize_change(&pending, None).unwrap();
    fs::write(root_b.path().join("shared.ts"), "b0\n").unwrap();
    let pending = prepare(data.path(), root_b.path(), "s1", "m2", "shared.ts");
    fs::write(root_b.path().join("shared.ts"), "b1\n").unwrap();
    let second = finalize_change(&pending, None).unwrap();
    assert_eq!(first.path, second.path, "both records use a relative name");

    let roots = SessionRoots::new(
        root_a.path().to_path_buf(),
        vec![root_b.path().to_path_buf()],
    );
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 2, "each root's file is its own row: {files:?}");
    assert!(
        files
            .iter()
            .all(|file| file.additions == Some(1) && file.deletions == Some(1)),
        "each row counts its own root's edit: {files:?}"
    );
    assert_eq!(files[0].root, root_identity(root_a.path()));
    assert_eq!(files[1].root, root_identity(root_b.path()));
}

/// Rolling back a file that a secondary root deleted must never recreate it
/// under the primary root.
#[test]
fn a_secondary_root_rollback_never_writes_the_primary_root() {
    let data = tempdir().unwrap();
    let root_a = tempdir().unwrap();
    let root_b = tempdir().unwrap();
    fs::write(root_b.path().join("gone.ts"), "keep me\n").unwrap();
    let pending = prepare(data.path(), root_b.path(), "s1", "m1", "gone.ts");
    fs::remove_file(root_b.path().join("gone.ts")).unwrap();
    let change = finalize_change(&pending, None).unwrap();
    let roots = SessionRoots::new(
        root_a.path().to_path_buf(),
        vec![root_b.path().to_path_buf()],
    );

    let outcome = rollback_file(
        data.path(),
        "s1",
        &roots,
        root_identity(root_b.path()).as_deref(),
        "gone.ts",
    )
    .unwrap();

    assert_eq!(outcome.status, "rolledBack");
    assert_eq!(
        fs::read_to_string(root_b.path().join("gone.ts")).unwrap(),
        "keep me\n",
        "the secondary root's bytes come back: {outcome:?}"
    );
    assert!(
        !root_a.path().join("gone.ts").exists(),
        "the primary root never gains a file the conversation did not touch"
    );
    assert_eq!(change.status, ReviewChangeStatus::Deleted);

    // The per-tool rollback resolves through the same recorded root.
    let target = root_b.path().join("gone.ts");
    assert!(target.exists());
}

/// A record whose root is no longer one of the session's roots is reported,
/// never resolved against another tree.
#[test]
fn a_record_from_a_removed_root_is_not_attributed_elsewhere() {
    let data = tempdir().unwrap();
    let root_a = tempdir().unwrap();
    let root_b = tempdir().unwrap();
    fs::write(root_a.path().join("note.ts"), "a0\n").unwrap();
    let pending = prepare(data.path(), root_a.path(), "s1", "m1", "note.ts");
    fs::write(root_a.path().join("note.ts"), "a1\n").unwrap();
    finalize_change(&pending, None).unwrap();

    // The session only has the other root now.
    let roots = roots_of(root_b.path());
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].reason, Some(ReviewDiffLimit::WorkspaceUnavailable));
    assert_eq!(files[0].additions, None, "no guess is counted as a diff");
    assert!(!files[0].reversible);
    assert_eq!(files[0].root, root_identity(root_a.path()));

    let outcome = rollback_file(data.path(), "s1", &roots, None, "note.ts").unwrap();
    assert_eq!(outcome.status, "unavailable");
    assert_eq!(
        fs::read_to_string(root_a.path().join("note.ts")).unwrap(),
        "a1\n"
    );
    assert!(!root_b.path().join("note.ts").exists());
}

/// A record from before roots were stored cannot be attributed in a session
/// with two roots, and is not guessed.
#[test]
fn a_legacy_record_without_a_root_is_unavailable_in_a_multi_root_session() {
    let data = tempdir().unwrap();
    let root_a = tempdir().unwrap();
    let root_b = tempdir().unwrap();
    fs::write(root_a.path().join("legacy.ts"), "a0\n").unwrap();
    let pending = prepare(data.path(), root_a.path(), "s1", "m1", "legacy.ts");
    fs::write(root_a.path().join("legacy.ts"), "a1\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    // Rewrite the record as the older format did, without a root.
    let dir = snapshot_dir(data.path(), "s1", &change.snapshot_id).unwrap();
    let mut meta: Value =
        serde_json::from_slice(&fs::read(dir.join("meta.json")).unwrap()).unwrap();
    meta.as_object_mut().unwrap().remove("root");
    fs::write(dir.join("meta.json"), serde_json::to_vec(&meta).unwrap()).unwrap();

    let roots = SessionRoots::new(
        root_a.path().to_path_buf(),
        vec![root_b.path().to_path_buf()],
    );
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].reason, Some(ReviewDiffLimit::WorkspaceUnavailable));
    assert!(!files[0].reversible);
    let outcome = rollback_file(data.path(), "s1", &roots, None, "legacy.ts").unwrap();
    assert_eq!(outcome.status, "unavailable");
    assert_eq!(
        fs::read_to_string(root_a.path().join("legacy.ts")).unwrap(),
        "a1\n"
    );

    // With a single root the older record is unambiguous again.
    let single = roots_of(root_a.path());
    let files = file_changes(data.path(), "s1", &single).files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].additions, Some(1));
    assert!(files[0].reversible);
}

/// The record's operation is stored in the shared contract vocabulary, and a
/// record written before that casing existed still reads back: its counts, its
/// diff and its rollback survive. A value outside the vocabulary is not a review
/// operation and stays rejected instead of being guessed at.
#[test]
fn a_record_written_with_the_old_operation_spelling_is_still_read() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\ntwo\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    assert_eq!(change.operation, ReviewChangeOperation::Edit);
    let dir = snapshot_dir(data.path(), "s1", &change.snapshot_id).unwrap();
    let meta_path = dir.join("meta.json");
    let mut meta: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    assert_eq!(meta["operation"], json!("edit"));

    // Rewrite the record as hosts wrote it before the contract casing.
    meta["operation"] = json!("Edit");
    fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
    let roots = roots_of(workspace.path());
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].additions, Some(1));
    assert!(files[0].reversible);
    let outcome = rollback_change(data.path(), "s1", &change.snapshot_id, &roots).unwrap();
    assert_eq!(outcome.status, "rolledBack");
    assert_eq!(fs::read_to_string(&target).unwrap(), "one\n");

    // A value outside the vocabulary leaves the record unreadable rather than
    // turning into a row with an invented operation.
    let mut meta: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    meta["operation"] = json!("wipe");
    fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
    let outcome = file_changes(data.path(), "s1", &roots);
    assert_eq!(outcome.unreadable_records, 1);
    assert!(outcome.files.is_empty());
}

/// A long conversation's first edit can sit outside the renderer's message
/// window. The baseline is still the first recorded bytes, and a file
/// rollback restores them rather than a mid-conversation state.
#[test]
fn a_tail_only_renderer_window_keeps_the_first_recorded_baseline() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");

    fs::write(&target, "one\ntwo\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\nTWO\n").unwrap();
    let first = finalize_change(&pending, None).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    let second = finalize_change(&pending, None).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m3", "src.txt");
    fs::write(&target, "one\nTWO\nthree\nfour\n").unwrap();
    let third = finalize_change(&pending, None).unwrap();

    // The host never sees the renderer's window: it scans the session.
    let roots = roots_of(workspace.path());
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 1);
    assert_eq!(
        files[0].additions,
        Some(3),
        "the row spans every edit: {files:?}"
    );
    assert_eq!(files[0].deletions, Some(1));
    assert_eq!(
        files[0].snapshot_ids,
        vec![
            first.snapshot_id.clone(),
            second.snapshot_id.clone(),
            third.snapshot_id.clone()
        ]
    );

    let outcome = rollback_file(data.path(), "s1", &roots, None, "src.txt").unwrap();
    assert_eq!(outcome.status, "rolledBack");
    assert_eq!(outcome.rolled_back.len(), 3);
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "one\ntwo\n",
        "rollback restores the conversation's first baseline, not a page's"
    );
}

/// A record written while the ordering field held milliseconds still sorts
/// after an older record that stores microseconds, so the first baseline and
/// the latest-hash guard stay chronological across both forms.
#[test]
fn a_millisecond_record_keeps_its_chronological_place() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\nTWO\n").unwrap();
    let first = finalize_change(&pending, None).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    let second = finalize_change(&pending, None).unwrap();

    // The older record stores microseconds, the newer one milliseconds.
    let base = now_micros() - 10_000_000;
    let rewrite = |id: &str, created_at: i64| {
        let dir = snapshot_dir(data.path(), "s1", id).unwrap();
        let mut meta = read_meta(data.path(), "s1", id).unwrap();
        meta.created_at = Some(created_at);
        write_meta(&metadata_path(&dir), &meta).unwrap();
    };
    rewrite(&first.snapshot_id, base);
    rewrite(&second.snapshot_id, (base + 5_000_000) / 1000);

    let roots = roots_of(workspace.path());
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 1);
    assert_eq!(
        files[0].additions,
        Some(2),
        "the first record is still the baseline: {files:?}"
    );
    assert_eq!(
        files[0].snapshot_ids,
        vec![first.snapshot_id.clone(), second.snapshot_id.clone()]
    );

    let outcome = rollback_file(data.path(), "s1", &roots, None, "src.txt").unwrap();
    assert_eq!(outcome.status, "rolledBack");
    assert_eq!(fs::read_to_string(&target).unwrap(), "one\n");
}

/// A long session that also has a file whose only record precedes a hundred
/// later messages still lists that file.
#[test]
fn a_file_edited_before_a_long_tail_is_still_listed() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("early.txt");
    fs::write(&target, "before\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "early.txt");
    fs::write(&target, "after\n").unwrap();
    finalize_change(&pending, None).unwrap();
    // Many later tool records in the same session (a long conversation).
    for index in 0..120 {
        let name = format!("later-{index}.txt");
        let pending = prepare(
            data.path(),
            workspace.path(),
            "s1",
            &format!("m-later-{index}"),
            &name,
        );
        fs::write(workspace.path().join(&name), "x\n").unwrap();
        finalize_change(&pending, None).unwrap();
    }
    let roots = roots_of(workspace.path());
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 121);
    assert_eq!(files[0].path, "early.txt");
    assert_eq!(files[0].additions, Some(1));
}

/// The request's input budget is shared: the ledger charges each admitted
/// file exactly once, so a session larger than the budget states the limit
/// instead of silently dropping rows or miscounting them.
#[test]
fn the_request_budget_stops_work_and_says_so() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    // Lines, not bytes, are what a comparison costs, so two ordinary-sized
    // files already spend nearly the whole request's line budget.
    for index in 0..2 {
        let name = format!("wide-{index}.txt");
        let before = "a\n".repeat(MAX_DIFF_LINES - 1);
        fs::write(workspace.path().join(&name), &before).unwrap();
        let pending = prepare(
            data.path(),
            workspace.path(),
            "s1",
            &format!("m-{index}"),
            &name,
        );
        fs::write(workspace.path().join(&name), format!("{before}b\n")).unwrap();
        finalize_change(&pending, None).unwrap();
    }
    // One more ordinary file is beyond what the ledger has left.
    let target = workspace.path().join("later.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m-late", "later.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    finalize_change(&pending, None).unwrap();

    let outcome = file_changes(data.path(), "s1", &roots_of(workspace.path()));
    assert!(
        outcome.truncated,
        "the answer states that its work was bounded: reasons={:?}",
        outcome
            .files
            .iter()
            .map(|file| file.reason)
            .collect::<Vec<_>>()
    );
    let limited: Vec<&ReviewFileChange> = outcome
        .files
        .iter()
        .filter(|file| file.reason == Some(ReviewDiffLimit::RequestBudgetExceeded))
        .collect();
    assert!(
        !limited.is_empty(),
        "over-budget rows name their reason: {outcome:?}"
    );
    for row in limited {
        assert_eq!(row.additions, None, "an uncomputed row is never zero");
        assert_eq!(row.deletions, None);
        assert!(row.hunks.is_empty());
    }
}

/// A request with no lines left stops before touching the next file at all.
/// The second file is unreadable, so a request that read it would have to say
/// the baseline is unavailable; the budget row proves it was never opened.
#[cfg(unix)]
#[test]
fn an_exhausted_request_does_not_read_the_next_file() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let first = workspace.path().join("a.txt");
    fs::write(&first, "one\ntwo\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "a.txt");
    fs::write(&first, "one\nTWO\n").unwrap();
    finalize_change(&pending, None).unwrap();

    let next = workspace.path().join("b.txt");
    fs::write(&next, "secret\ntext\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m2", "b.txt");
    fs::write(&next, "secret\nchanged\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    // Pin the visit order: this record is newer than the first, so the second
    // file is reached only after the request already spent its line budget.
    let dir = snapshot_dir(data.path(), "s1", &change.snapshot_id).unwrap();
    let mut meta: Value =
        serde_json::from_slice(&fs::read(dir.join("meta.json")).unwrap()).unwrap();
    meta["createdAt"] = json!(now_micros() + 1_000);
    fs::write(dir.join("meta.json"), serde_json::to_vec(&meta).unwrap()).unwrap();
    fs::set_permissions(&next, fs::Permissions::from_mode(0o000)).unwrap();
    let roots = roots_of(workspace.path());

    // The same unreadable file under a request that still has budget is read,
    // which is what makes the row below evidence that nothing was read.
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 2);
    assert_eq!(files[1].path, "b.txt");
    assert_eq!(files[1].reason, Some(ReviewDiffLimit::BaselineUnavailable));

    // The first file's two sides hold four lines, so this ledger is spent
    // exactly when the next file is reached.
    let now = Instant::now();
    let request = DiffRequest::with_budget(now + Duration::from_secs(1), MAX_REQUEST_DIFF_BYTES, 4);
    let outcome = file_changes_with_request(data.path(), "s1", &roots, request);
    fs::set_permissions(&next, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(outcome.truncated);
    assert_eq!(outcome.files.len(), 2);
    assert_eq!(outcome.files[0].path, "a.txt");
    assert_eq!(outcome.files[0].additions, Some(1));
    assert_eq!(outcome.files[0].reason, None);
    assert_eq!(outcome.files[1].path, "b.txt");
    assert_eq!(
        outcome.files[1].reason,
        Some(ReviewDiffLimit::RequestBudgetExceeded),
        "an exhausted request reads nothing: {outcome:?}"
    );
    assert_eq!(outcome.files[1].additions, None);
    assert_eq!(outcome.files[1].deletions, None);
    assert!(outcome.files[1].hunks.is_empty());
}

/// The request's byte admission is decided from metadata, before either side
/// is read: a file the ledger cannot afford is never opened.
#[cfg(unix)]
#[test]
fn a_request_without_byte_room_reports_the_budget_before_reading() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    finalize_change(&pending, None).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o000)).unwrap();
    let roots = roots_of(workspace.path());

    // One byte left cannot cover the two sides' metadata sizes, so the row is
    // decided before a read would have raised `BaselineUnavailable` instead.
    let now = Instant::now();
    let request =
        DiffRequest::with_budget(now + Duration::from_secs(1), 1, MAX_REQUEST_DIFF_TOKENS);
    let outcome = file_changes_with_request(data.path(), "s1", &roots, request);
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(outcome.truncated);
    assert_eq!(outcome.files.len(), 1);
    assert_eq!(
        outcome.files[0].reason,
        Some(ReviewDiffLimit::RequestBudgetExceeded)
    );
    assert_eq!(outcome.files[0].additions, None);
    assert!(outcome.files[0].hunks.is_empty());
}

/// More files than the answer carries are counted, not silently dropped.
#[test]
fn a_session_larger_than_the_row_cap_is_marked_truncated() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    for index in 0..(MAX_REVIEW_FILES + 2) {
        let name = format!("f-{index}.txt");
        let pending = prepare(
            data.path(),
            workspace.path(),
            "s1",
            &format!("m-{index}"),
            &name,
        );
        fs::write(workspace.path().join(&name), "x\n").unwrap();
        finalize_change(&pending, None).unwrap();
    }
    let outcome = file_changes(data.path(), "s1", &roots_of(workspace.path()));
    assert_eq!(outcome.files.len(), MAX_REVIEW_FILES);
    assert!(outcome.truncated);
}

/// A record whose metadata is unreadable is reported, never invented.
#[test]
fn an_unreadable_record_is_counted_instead_of_invented() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    fs::write(workspace.path().join("src.txt"), "x\n").unwrap();
    finalize_change(&pending, None).unwrap();

    let broken = session_review_dir(data.path(), "s1")
        .unwrap()
        .join("broken-record");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join("meta.json"), b"{not json").unwrap();

    let outcome = file_changes(data.path(), "s1", &roots_of(workspace.path()));
    assert_eq!(outcome.unreadable_records, 1);
    assert_eq!(outcome.files.len(), 1);
}

/// A record claiming another session inside this session's directory is not
/// read, and never becomes a row.
#[test]
fn a_forged_session_record_is_refused() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("forged.txt");
    fs::write(&target, "x\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "forged.txt");
    fs::write(&target, "y\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    let dir = snapshot_dir(data.path(), "s1", &change.snapshot_id).unwrap();
    let mut meta: Value =
        serde_json::from_slice(&fs::read(dir.join("meta.json")).unwrap()).unwrap();
    meta["sessionId"] = json!("someone-else");
    fs::write(dir.join("meta.json"), serde_json::to_vec(&meta).unwrap()).unwrap();

    let outcome = file_changes(data.path(), "s1", &roots_of(workspace.path()));
    assert!(outcome.files.is_empty());
    assert_eq!(outcome.unreadable_records, 1);
}

/// A record whose path escapes its root is refused by the resolver.
#[test]
fn a_record_whose_path_escapes_its_root_is_refused() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("inside.txt");
    fs::write(&target, "x\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "inside.txt");
    fs::write(&target, "y\n").unwrap();
    let change = finalize_change(&pending, None).unwrap();
    let dir = snapshot_dir(data.path(), "s1", &change.snapshot_id).unwrap();
    let mut meta: Value =
        serde_json::from_slice(&fs::read(dir.join("meta.json")).unwrap()).unwrap();
    meta["path"] = json!("../outside.txt");
    fs::write(dir.join("meta.json"), serde_json::to_vec(&meta).unwrap()).unwrap();

    let roots = roots_of(workspace.path());
    let outcome = file_changes(data.path(), "s1", &roots);
    assert!(outcome
        .files
        .iter()
        .all(|file| file.additions.is_none() && !file.reversible));
    let result = rollback_file(data.path(), "s1", &roots, None, "../outside.txt").unwrap();
    assert_eq!(result.status, "unavailable");
    assert!(!workspace
        .path()
        .parent()
        .unwrap()
        .join("outside.txt")
        .exists());
}

#[test]
fn write_preview_reports_creation_as_added() {
    let preview = preview_write_diff(
        "created.txt".to_string(),
        "workspace".to_string(),
        WritePreviewStatus::Added,
        Some(&[]),
        b"one\ntwo\n",
    );
    assert_eq!(preview.operation, FileMutationOperation::Write);
    assert_eq!(preview.status, EditDiffStatus::Added);
    assert_eq!(preview.additions, Some(2));
    assert_eq!(preview.deletions, Some(0));
    assert!(!preview.hunks.is_empty());
    assert!(!preview.truncated);
    assert_eq!(preview.reason, None);
}

#[test]
fn write_preview_without_baseline_omits_counts() {
    let preview = preview_write_diff(
        "unknown.txt".to_string(),
        "workspace".to_string(),
        WritePreviewStatus::Modified,
        None,
        b"one\n",
    );
    assert_eq!(preview.operation, FileMutationOperation::Write);
    assert_eq!(preview.additions, None);
    assert_eq!(preview.deletions, None);
    assert!(preview.hunks.is_empty());
    assert!(preview.truncated);
    assert_eq!(preview.reason, Some(ReviewDiffLimit::BaselineUnavailable));
}

/// The per-call preview applies the same side byte ceiling the durable record
/// does, so a huge Write reports the limit instead of comparing bytes no review
/// can carry.
#[test]
fn a_per_call_preview_refuses_a_side_over_the_byte_ceiling() {
    let oversized = vec![b'x'; (MAX_DIFF_BYTES as usize) + 1];
    let preview = preview_write_diff(
        "huge.txt".to_string(),
        "workspace".to_string(),
        WritePreviewStatus::Modified,
        Some(&oversized),
        b"one\\n",
    );
    assert!(preview.truncated);
    assert_eq!(preview.reason, Some(ReviewDiffLimit::FileTooLarge));
    assert_eq!(preview.additions, None);
    assert_eq!(preview.deletions, None);
    assert!(preview.hunks.is_empty());
}

/// A reservation is reconciled with what a read actually held: a file that grew
/// past its reservation cannot push the request beyond its input ceiling.
#[test]
fn a_reservation_overshoot_is_reconciled_against_the_request() {
    let now = Instant::now();
    let mut request = DiffRequest::with_budget(now + Duration::from_secs(1), 32, 10);
    assert!(request.admit(now, 16).is_some());
    assert!(
        request.settle(16, 10),
        "an undershoot returns the difference"
    );
    assert!(
        request.settle(10, 18),
        "an overshoot inside the ceiling is charged"
    );
    assert!(
        !request.settle(0, 40),
        "a side that grew past the ceiling is refused instead of compared"
    );
    assert!(
        request.is_exhausted(now),
        "the refused overshoot spends the rest"
    );
}

#[test]
fn edit_preview_covers_only_its_own_statuses() {
    let modified = preview_edit_diff(
        "source.txt".to_string(),
        "workspace".to_string(),
        EditPreviewStatus::Modified,
        b"one\n",
        Some(b"two\n"),
    );
    assert_eq!(modified.operation, FileMutationOperation::Edit);
    assert_eq!(modified.status, EditDiffStatus::Modified);
    let deleted = preview_edit_diff(
        "gone.txt".to_string(),
        "workspace".to_string(),
        EditPreviewStatus::Deleted,
        b"one\n",
        None,
    );
    assert_eq!(deleted.operation, FileMutationOperation::Edit);
    assert_eq!(deleted.status, EditDiffStatus::Deleted);
    assert_eq!(deleted.additions, Some(0));
    assert_eq!(deleted.deletions, Some(1));
    let moved = preview_edit_diff(
        "dest.txt".to_string(),
        "workspace".to_string(),
        EditPreviewStatus::Moved,
        b"one\n",
        Some(b"one\n"),
    );
    assert_eq!(moved.operation, FileMutationOperation::Edit);
    assert_eq!(moved.status, EditDiffStatus::Moved);
}

#[test]
fn preview_operation_has_no_delete_and_keeps_wire_spelling() {
    let edit = serde_json::to_value(FileMutationOperation::Edit).unwrap();
    let write = serde_json::to_value(FileMutationOperation::Write).unwrap();
    assert_eq!(edit, serde_json::json!("edit"));
    assert_eq!(write, serde_json::json!("write"));
    let preview = preview_write_diff(
        "created.txt".to_string(),
        "workspace".to_string(),
        WritePreviewStatus::Added,
        Some(&[]),
        b"one\n",
    );
    let value = serde_json::to_value(&preview).unwrap();
    assert_eq!(value["version"], serde_json::json!(1));
    assert_eq!(value["operation"], serde_json::json!("write"));
    assert_eq!(value["status"], serde_json::json!("added"));
}

/// The request ledger charges input once and refuses what it cannot afford, so
/// one file never hides a later row behind a second charge.
#[test]
fn the_request_ledger_charges_input_once() {
    let now = Instant::now();
    let mut request = DiffRequest::new(now);
    assert!(request.admit(now, MAX_REQUEST_DIFF_BYTES).is_some());
    assert!(
        request.admit(now, 1).is_none(),
        "the request cannot afford a byte beyond what it was given"
    );
    assert!(request.is_exhausted(now));

    let mut request = DiffRequest::new(now);
    assert!(request.spend_tokens(MAX_REQUEST_DIFF_TOKENS));
    assert!(!request.spend_tokens(1), "the line budget is finite");
    assert!(request.is_exhausted(now));

    // A request whose clock already passed admits nothing at all.
    let mut expired = DiffRequest::new(now - Duration::from_secs(1));
    assert!(expired.is_exhausted(now));
    assert!(expired.admit(now, 0).is_none());
}

/// A comparison whose own clock already passed names a complex file and
/// withholds its counts: the engine's coarse script is not trusted evidence.
#[test]
fn an_expired_file_deadline_reports_a_complex_diff() {
    let preview = make_preview(
        DiffSide::Present(b"one\ntwo\n".to_vec()),
        DiffSide::Present(b"one\nTWO\n".to_vec()),
        MAX_RECORD_HUNK_CHARS,
        &mut PreviewLimits::file(Instant::now() - Duration::from_secs(1)),
    );
    assert!(preview.truncated);
    assert_eq!(preview.reason, Some(ReviewDiffLimit::DiffTooComplex));
    assert_eq!(preview.additions, None);
    assert_eq!(preview.deletions, None);
    assert!(preview.hunks.is_empty());
}

/// The same expiry when the request's deadline is the binding one names the
/// request's budget, not a complex file.
#[test]
fn an_expired_request_deadline_reports_the_request_budget() {
    let now = Instant::now();
    let mut request = DiffRequest::new(now);
    let work = DiffWork::with_deadline(now - Duration::from_secs(1), true);
    let mut limits = PreviewLimits::request(work, &mut request);
    let preview = make_preview(
        DiffSide::Present(b"one\ntwo\n".to_vec()),
        DiffSide::Present(b"one\nTWO\n".to_vec()),
        MAX_RECORD_HUNK_CHARS,
        &mut limits,
    );
    assert!(preview.truncated);
    assert_eq!(preview.reason, Some(ReviewDiffLimit::RequestBudgetExceeded));
    assert_eq!(preview.additions, None);
    assert!(preview.hunks.is_empty());
}

/// The line ceiling is enforced before tokenization, so a pathological side is
/// refused instead of allocating one slice per line.
#[test]
fn a_side_with_too_many_lines_is_refused_before_tokenizing() {
    let text = "x\n".repeat(MAX_DIFF_LINES + 1);
    let preview = make_preview(
        DiffSide::Present(text.into_bytes()),
        DiffSide::Present(b"x\n".to_vec()),
        MAX_RECORD_HUNK_CHARS,
        &mut PreviewLimits::file(Instant::now()),
    );
    assert!(preview.truncated);
    assert_eq!(preview.reason, Some(ReviewDiffLimit::FileTooLarge));
    assert_eq!(preview.additions, None);
    assert!(preview.hunks.is_empty());
}

fn tool_options(allow_external_paths: bool) -> crate::tools::ToolExecutionOptions<'static> {
    crate::tools::ToolExecutionOptions {
        timeout_ms: None,
        bash_options: None,
        allow_external_paths,
        hashline: None,
    }
}

/// The tag an `Edit` requires, as a user gets it from a fresh read.
async fn read_tag(workspace: &Path, path: &str) -> String {
    let read = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace),
        None,
        "Read",
        &json!({ "path": path }),
        tool_options(false),
    )
    .await;
    assert!(read.result.ok, "read failed: {:?}", read.result.content);
    read.result.content["tag"]
        .as_str()
        .expect("a read returns a tag")
        .to_string()
}

/// The durable record reuses the comparison the tool already computed when the
/// bytes still identify the same before and after state.
#[tokio::test]
async fn the_record_reuses_the_tools_comparison_when_the_hashes_match() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    let tag = read_tag(workspace.path(), "src.txt").await;
    let outcome = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        None,
        "Edit",
        &json!({ "path": "src.txt", "tag": tag, "ops": "PUT 2.=2:\n+changed" }),
        tool_options(false),
    )
    .await;
    assert!(
        outcome.result.ok,
        "edit failed: {:?}",
        outcome.result.content
    );
    let evidence = outcome
        .evidence
        .clone()
        .expect("a workspace edit carries evidence");
    assert_eq!(evidence.preview.additions, Some(1));
    assert_eq!(evidence.preview.deletions, Some(1));
    // A marker inside the tool's own preview proves the record stored that
    // comparison rather than repeating it.
    let mut marked = evidence;
    marked.preview.additions = Some(97);
    marked.preview.deletions = Some(98);
    marked.preview.hunks = vec![ReviewDiffHunk {
        header: "@@ tool comparison @@".to_string(),
        lines: Vec::new(),
    }];
    let change = finalize_change(&pending, Some(&marked)).unwrap();
    assert_eq!(change.additions, Some(97));
    assert_eq!(change.deletions, Some(98));
    assert_eq!(change.hunks[0].header, "@@ tool comparison @@");
}

/// A file edited again between the tool call and the record is described from
/// the bytes on disk, never from the tool's now-stale comparison.
#[tokio::test]
async fn the_record_recomputes_when_the_file_changed_after_the_tool() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    let tag = read_tag(workspace.path(), "src.txt").await;
    let outcome = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        None,
        "Edit",
        &json!({ "path": "src.txt", "tag": tag, "ops": "PUT 2.=2:\n+changed" }),
        tool_options(false),
    )
    .await;
    assert!(outcome.result.ok);
    let evidence = outcome.evidence.expect("a workspace edit carries evidence");
    assert_eq!(evidence.preview.additions, Some(1));
    // A concurrent writer changes the file after the tool returned.
    fs::write(&target, "one\nCHANGED\nfour\n").unwrap();
    let change = finalize_change(&pending, Some(&evidence)).unwrap();
    assert_eq!(
        change.additions,
        Some(2),
        "the record compares the bytes it found, not the tool's memory"
    );
    assert_eq!(change.deletions, Some(2));
}

/// A user's concurrent edit between the snapshot and the tool must not move the
/// record's baseline: the evidence no longer matches the captured bytes, so the
/// record falls back to its own read.
#[tokio::test]
async fn the_record_keeps_its_baseline_when_the_tool_saw_other_bytes() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
    // The user's own edit lands between the snapshot and the tool call.
    fs::write(&target, "one\ntwo\nthree\nuser\n").unwrap();
    let tag = read_tag(workspace.path(), "src.txt").await;
    let outcome = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        None,
        "Edit",
        &json!({ "path": "src.txt", "tag": tag, "ops": "PUT 2.=2:\n+changed" }),
        tool_options(false),
    )
    .await;
    assert!(outcome.result.ok);
    let evidence = outcome.evidence.expect("a workspace edit carries evidence");
    assert_eq!(
        evidence.preview.additions,
        Some(1),
        "the tool compared against the bytes it actually saw"
    );
    let change = finalize_change(&pending, Some(&evidence)).unwrap();
    assert_eq!(
        change.additions,
        Some(2),
        "the row still starts from the bytes the record captured"
    );
    assert_eq!(change.deletions, Some(1));
}

/// Only a workspace mutation feeds the durable review record; scratch and
/// explicitly approved external writes keep their per-call preview without
/// gaining review evidence.
#[tokio::test]
async fn only_a_workspace_mutation_carries_record_evidence() {
    let workspace = tempdir().unwrap();
    let scratch = tempdir().unwrap();
    let outside = tempdir().unwrap();

    let created = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        Some(scratch.path()),
        "Write",
        &json!({ "path": "new.txt", "content": "one\ntwo\n" }),
        tool_options(false),
    )
    .await;
    assert!(created.result.ok, "{:?}", created.result.content);
    let evidence = created
        .evidence
        .expect("a workspace write carries evidence");
    assert_eq!(evidence.preview.status, EditDiffStatus::Added);
    assert_eq!(evidence.preview.additions, Some(2));

    let modified = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        Some(scratch.path()),
        "Write",
        &json!({ "path": "new.txt", "content": "one\nTWO\nthree\n" }),
        tool_options(false),
    )
    .await;
    assert!(modified.result.ok, "{:?}", modified.result.content);
    let evidence = modified
        .evidence
        .expect("a workspace write carries evidence");
    assert_eq!(evidence.preview.status, EditDiffStatus::Modified);
    assert_eq!(evidence.preview.additions, Some(2));
    assert_eq!(evidence.preview.deletions, Some(1));

    let target = workspace.path().join("gone.txt");
    fs::write(&target, "gone\n").unwrap();
    let tag = read_tag(workspace.path(), "gone.txt").await;
    let deleted = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        Some(scratch.path()),
        "Edit",
        &json!({ "path": "gone.txt", "tag": tag, "ops": "REM" }),
        tool_options(false),
    )
    .await;
    assert!(deleted.result.ok, "{:?}", deleted.result.content);
    let evidence = deleted
        .evidence
        .expect("a workspace delete carries evidence");
    assert_eq!(evidence.preview.status, EditDiffStatus::Deleted);
    assert_eq!(evidence.preview.deletions, Some(1));
    assert!(!target.exists());

    let source = workspace.path().join("from.txt");
    fs::write(&source, "keep\n").unwrap();
    let tag = read_tag(workspace.path(), "from.txt").await;
    let moved = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        Some(scratch.path()),
        "Edit",
        &json!({ "path": "from.txt", "tag": tag, "ops": "MV moved.txt" }),
        tool_options(false),
    )
    .await;
    assert!(moved.result.ok, "{:?}", moved.result.content);
    let evidence = moved.evidence.expect("a workspace move carries evidence");
    assert_eq!(evidence.preview.status, EditDiffStatus::Moved);
    assert!(workspace.path().join("moved.txt").is_file());

    // Scratch and approved external writes get the same line evidence in their
    // own result, but no record evidence.
    let scratch_file = scratch.path().join("note.txt");
    let scratch_write = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        Some(scratch.path()),
        "Write",
        &json!({ "path": scratch_file.to_str().unwrap(), "content": "note\n" }),
        tool_options(false),
    )
    .await;
    assert!(
        scratch_write.result.ok,
        "{:?}",
        scratch_write.result.content
    );
    assert!(scratch_write.evidence.is_none());
    assert_eq!(
        scratch_write.result.content["root"].as_str(),
        Some("scratch"),
        "a scratch write keeps its own root label"
    );
    assert!(scratch_write.result.content.get("editDiff").is_some());

    let outside_file = outside.path().join("out.txt");
    let external_write = crate::tools::execute_tool_with_evidence_path_access(
        Some(workspace.path()),
        Some(scratch.path()),
        "Write",
        &json!({ "path": outside_file.to_str().unwrap(), "content": "out\n" }),
        tool_options(true),
    )
    .await;
    assert!(
        external_write.result.ok,
        "{:?}",
        external_write.result.content
    );
    assert!(external_write.evidence.is_none());
    assert_eq!(
        external_write.result.content["root"].as_str(),
        Some("external")
    );
    assert!(external_write.result.content.get("editDiff").is_some());
    assert!(outside_file.is_file());
}
