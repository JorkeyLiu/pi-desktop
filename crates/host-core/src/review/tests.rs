use super::diff::MAX_DIFF_BYTES;
use super::layout::{
    metadata_path, now_micros, read_meta, root_identity, session_review_dir, snapshot_dir,
    write_meta,
};
use super::session::MAX_REVIEW_FILES;
use super::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
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
    let change = finalize_change(&pending).unwrap();
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
    let change = finalize_change(&pending).unwrap();
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
    let change = finalize_change(&pending).unwrap();
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
    let change = finalize_change(&pending).unwrap();
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

    let change = finalize_change(&pending).unwrap();
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

    let change = finalize_change(&pending).unwrap();
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
    let adjacent = finalize_change(&pending).unwrap();
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
    let distant = finalize_change(&pending).unwrap();
    assert_eq!(distant.hunks.len(), 2);
}

#[test]
fn a_rewrite_beyond_the_budget_reports_a_limit_not_a_zero_count() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("big.txt");
    fs::write(&target, numbered_lines(4_000)).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "big.txt");
    let rewritten: String = (0..4_000).map(|index| format!("other {index}\n")).collect();
    fs::write(&target, rewritten).unwrap();

    let change = finalize_change(&pending).unwrap();
    assert!(change.truncated);
    assert_eq!(change.additions, None, "unknown counts are not zero");
    assert_eq!(change.deletions, None);
    assert!(change.hunks.is_empty());
    assert_eq!(change.reason, Some(ReviewDiffLimit::DiffTooComplex));
}

#[test]
fn a_binary_change_is_reported_as_binary() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let target = workspace.path().join("blob.bin");
    fs::write(&target, [0_u8, 1, 2, 3]).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m1", "blob.bin");
    fs::write(&target, [0_u8, 9, 9, 9]).unwrap();

    let change = finalize_change(&pending).unwrap();
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

    let change = finalize_change(&pending).unwrap();
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

    let change = finalize_change(&pending).unwrap();
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
    let first = finalize_change(&first).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\nTWO\nTHREE\n").unwrap();
    let second = finalize_change(&second).unwrap();

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
    let change = finalize_change(&pending).unwrap();
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
    let change = finalize_change(&pending).unwrap();
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
    finalize_change(&pending).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m2", "b.txt");
    fs::write(workspace.path().join("b.txt"), "b\n").unwrap();
    finalize_change(&pending).unwrap();

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
    let first = finalize_change(&first).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    let second = finalize_change(&second).unwrap();
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
    finalize_change(&first).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    finalize_change(&second).unwrap();
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
    finalize_change(&first).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "new.txt");
    fs::write(workspace.path().join("new.txt"), "new\nmore\n").unwrap();
    finalize_change(&second).unwrap();
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
    let first = finalize_change(&first).unwrap();
    let second = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\ntwo\nthree\n").unwrap();
    finalize_change(&second).unwrap();
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
    finalize_change(&pending).unwrap();

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
    let first = finalize_change(&pending).unwrap();
    fs::write(root_b.path().join("shared.ts"), "b0\n").unwrap();
    let pending = prepare(data.path(), root_b.path(), "s1", "m2", "shared.ts");
    fs::write(root_b.path().join("shared.ts"), "b1\n").unwrap();
    let second = finalize_change(&pending).unwrap();
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
    let change = finalize_change(&pending).unwrap();
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
    finalize_change(&pending).unwrap();

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
    let change = finalize_change(&pending).unwrap();
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
    let change = finalize_change(&pending).unwrap();
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
    let first = finalize_change(&pending).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    let second = finalize_change(&pending).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m3", "src.txt");
    fs::write(&target, "one\nTWO\nthree\nfour\n").unwrap();
    let third = finalize_change(&pending).unwrap();

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
    let first = finalize_change(&pending).unwrap();
    let pending = prepare(data.path(), workspace.path(), "s1", "m2", "src.txt");
    fs::write(&target, "one\nTWO\nthree\n").unwrap();
    let second = finalize_change(&pending).unwrap();

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
    finalize_change(&pending).unwrap();
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
        finalize_change(&pending).unwrap();
    }
    let roots = roots_of(workspace.path());
    let files = file_changes(data.path(), "s1", &roots).files;
    assert_eq!(files.len(), 121);
    assert_eq!(files[0].path, "early.txt");
    assert_eq!(files[0].additions, Some(1));
}

/// The request's work and output budgets are shared, so an over-limit
/// session states the limit instead of silently dropping rows or miscounting.
#[test]
fn the_request_budget_stops_work_and_says_so() {
    let data = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    // Every line is identical, so the changed region has no unique anchor:
    // a file that cannot be solved exactly cannot fall back cheaply either.
    // Each of these files spends just under the exact-solve ceiling, so
    // together they exceed the request's total work budget.
    for index in 0..30 {
        let name = format!("wide-{index}.txt");
        let lines = "shared\n".repeat(1_300);
        let mut edited = lines.clone();
        edited.insert_str(0, "first\n");
        edited.push_str("last\n");
        fs::write(workspace.path().join(&name), &lines).unwrap();
        let pending = prepare(
            data.path(),
            workspace.path(),
            "s1",
            &format!("m-{index}"),
            &name,
        );
        fs::write(workspace.path().join(&name), edited).unwrap();
        finalize_change(&pending).unwrap();
    }
    let outcome = file_changes(data.path(), "s1", &roots_of(workspace.path()));
    assert!(
        outcome.truncated,
        "the answer states that its work was bounded: rows={} reasons={:?}",
        outcome.files.len(),
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
    // The rows that did fit still carry exact counts.
    assert!(outcome
        .files
        .iter()
        .any(|file| file.additions == Some(2) && file.deletions == Some(0)));
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
        finalize_change(&pending).unwrap();
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
    finalize_change(&pending).unwrap();

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
    let change = finalize_change(&pending).unwrap();
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
    let change = finalize_change(&pending).unwrap();
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
