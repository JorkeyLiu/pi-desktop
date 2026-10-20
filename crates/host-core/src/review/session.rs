use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

use super::diff::{
    make_preview, read_diff_side, DiffBudget, DiffSide, ReviewPreview, MAX_DIFF_WORK,
    MAX_RECORD_HUNK_CHARS,
};
use super::layout::{
    before_path, hash_file, metadata_path, read_meta, session_review_dir, snapshot_dir,
    snapshot_location, write_meta, SessionRoots, REVIEW_DIR,
};
use super::model::{
    FileRollbackOutcome, ReviewChangeState, ReviewChangeStatus, ReviewDiffHunk, ReviewDiffLimit,
    ReviewFileChange, ReviewFileRollbackMark, ReviewFilesOutcome, SnapshotMeta,
};
use super::snapshot::restore_before;

/// Hunk text one `review.files` response may carry across all rows.
pub(super) const MAX_RESPONSE_HUNK_CHARS: usize = 512 * 1024;
/// Line work one `review.files` request may spend across all files.
pub(super) const MAX_REQUEST_DIFF_WORK: usize = 48_000_000;
/// Snapshot directories one request may scan.
pub(super) const MAX_SESSION_SNAPSHOTS: usize = 8_192;
/// File rows one request may return.
pub(super) const MAX_REVIEW_FILES: usize = 512;

/// One record read back from the session's snapshot directory.
pub(super) struct ScannedSnapshot {
    id: String,
    meta: SnapshotMeta,
    /// Microsecond order of the record; the file's timestamp stands in for
    /// records written before `created_at` existed, and the record id breaks any
    /// remaining tie so one directory always yields one order.
    order: (i64, String),
}

pub(super) struct SessionScan {
    entries: Vec<ScannedSnapshot>,
    unreadable: usize,
    truncated: bool,
}

/// The record's write time in microseconds, standing in for records written
/// before the record itself carried one.
pub(super) fn meta_micros(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_micros() as i64)
        .unwrap_or(0)
}

/// A microsecond timestamp for any date after 2001 stays above this floor, while
/// a millisecond one stays far below it.
pub(super) const MICROS_FLOOR: i64 = 1_000_000_000_000_000;

/// The instant a record is ordered by, always in microseconds. A record written
/// while this field held milliseconds is scaled, and a record written before the
/// field existed falls back to the file's own timestamp, so one scan never
/// compares two different units and a file's first record stays first.
pub(super) fn record_micros(created_at: Option<i64>, meta_path: &Path) -> i64 {
    match created_at {
        Some(value) if value >= MICROS_FLOOR => value,
        Some(value) if value > 0 => value.saturating_mul(1000),
        _ => meta_micros(meta_path),
    }
}

/// Read every snapshot this session recorded. The session directory is the
/// authority, so a renderer's message window cannot shorten a file's history.
pub(super) fn scan_session(data_dir: &Path, session_id: &str) -> SessionScan {
    let mut scan = SessionScan {
        entries: Vec::new(),
        unreadable: 0,
        truncated: false,
    };
    let Ok(dir) = session_review_dir(data_dir, session_id) else {
        return scan;
    };
    let Ok(read) = fs::read_dir(&dir) else {
        return scan;
    };
    for entry in read.flatten() {
        if scan.entries.len() >= MAX_SESSION_SNAPSHOTS {
            scan.truncated = true;
            break;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let meta_path = metadata_path(&path);
        let Ok(bytes) = fs::read(&meta_path) else {
            // A record whose metadata is gone cannot be attributed to a file,
            // so it is reported as unreadable instead of being invented.
            scan.unreadable += 1;
            continue;
        };
        let Ok(meta): Result<SnapshotMeta, _> = serde_json::from_slice(&bytes) else {
            scan.unreadable += 1;
            continue;
        };
        // A record claiming another session is never read, even from inside
        // this session's directory.
        if meta.session_id != session_id || meta.message_id.trim().is_empty() {
            scan.unreadable += 1;
            continue;
        }
        let order = (record_micros(meta.created_at, &meta_path), id.clone());
        scan.entries.push(ScannedSnapshot { id, meta, order });
    }
    scan.entries
        .sort_by(|left, right| left.order.cmp(&right.order));
    scan
}

/// Every recorded file in the session, oldest record first, with the root each
/// Every record for one file, oldest first, with the root it belongs to.
pub(super) struct FileHistory {
    root: Option<String>,
    path: String,
    snapshots: Vec<(String, SnapshotMeta)>,
}

/// one belongs to.
pub(super) fn group_history(roots: &SessionRoots, scan: SessionScan) -> Vec<FileHistory> {
    let mut groups: Vec<FileHistory> = Vec::new();
    for entry in scan.entries {
        let location = snapshot_location(roots, &entry.meta);
        let root = location.root.clone();
        let index = groups
            .iter()
            .position(|group| group.path == entry.meta.path && group.root == root)
            .unwrap_or_else(|| {
                groups.push(FileHistory {
                    root: root.clone(),
                    path: entry.meta.path.clone(),
                    snapshots: Vec::new(),
                });
                groups.len() - 1
            });
        groups[index].snapshots.push((entry.id, entry.meta));
    }
    groups
}

pub(super) fn hunk_chars(hunks: &[ReviewDiffHunk]) -> usize {
    hunks
        .iter()
        .flat_map(|hunk| hunk.lines.iter())
        .map(|line| line.text.chars().count())
        .sum()
}

/// One `review.files` answer, computed from the session's own records.
///
/// The renderer's message window is not an input: a file's baseline is the
/// oldest record this session wrote for it, so a long conversation that has
/// scrolled out of the transcript is still compared from its first bytes.
pub fn file_changes(data_dir: &Path, session_id: &str, roots: &SessionRoots) -> ReviewFilesOutcome {
    let scan = scan_session(data_dir, session_id);
    let unreadable_records = scan.unreadable;
    let mut truncated = scan.truncated;
    let groups = group_history(roots, scan);
    if groups.len() > MAX_REVIEW_FILES {
        truncated = true;
    }

    // Both budgets are shared by the whole answer: one pathological file cannot
    // starve every later row, and no request may spend unbounded work or send
    // unbounded hunk text.
    let mut work = DiffBudget::new(MAX_REQUEST_DIFF_WORK);
    let mut hunk_chars_left = MAX_RESPONSE_HUNK_CHARS;
    let mut files = Vec::new();
    // An unreadable record means the session's history is incomplete, so no row
    // can promise that its baseline is the conversation's first bytes.
    let baseline_verified = unreadable_records == 0;
    if !baseline_verified {
        truncated = true;
    }

    for group in groups.into_iter().take(MAX_REVIEW_FILES) {
        let Some((baseline_id, baseline)) = group.snapshots.first().cloned() else {
            continue;
        };
        let rolled_back = group
            .snapshots
            .iter()
            .all(|(_, meta)| meta.state == ReviewChangeState::RolledBack);
        let snapshot_ids: Vec<String> = group.snapshots.iter().map(|(id, _)| id.clone()).collect();
        let location = snapshot_location(roots, &baseline);
        let target = match location.target {
            Some(target) => target,
            None => {
                // The record does not name a root this session still has, so
                // the row states that instead of resolving a guess.
                files.push(
                    FileRow {
                        root: group.root,
                        path: baseline.path.clone(),
                        status: ReviewChangeStatus::Modified,
                        preview: ReviewPreview::limited(ReviewDiffLimit::WorkspaceUnavailable),
                        reversible: false,
                        rolled_back,
                        snapshot_ids,
                    }
                    .into_change(),
                );
                continue;
            }
        };

        let after_exists = target.is_file();
        let current_hash = if after_exists {
            hash_file(&target).ok()
        } else {
            None
        };
        if after_exists == baseline.before_exists
            && current_hash.as_deref() == baseline.before_hash.as_deref()
        {
            // The file ends where the conversation found it, so it is not a
            // changed file at all.
            continue;
        }

        let preview = if work.remaining == 0 {
            truncated = true;
            ReviewPreview::limited(ReviewDiffLimit::RequestBudgetExceeded)
        } else {
            let before_side = if !baseline.before_exists {
                DiffSide::Present(Vec::new())
            } else if baseline.reversible {
                match snapshot_dir(data_dir, session_id, &baseline_id) {
                    Ok(dir) => read_diff_side(Some(&before_path(&dir)), true),
                    Err(_) => DiffSide::Missing,
                }
            } else {
                DiffSide::Missing
            };
            // A file may use the whole per-file ceiling only while the request
            // still has it; otherwise the aggregate budget is the constraint and
            // the row names that instead of blaming the file's own size.
            let request_was_short = work.remaining < MAX_DIFF_WORK;
            let mut child = work.capped(MAX_DIFF_WORK);
            let preview = make_preview(
                before_side,
                read_diff_side(Some(&target), after_exists),
                hunk_chars_left.min(MAX_RECORD_HUNK_CHARS),
                &mut child,
            );
            work.settle(child);
            if request_was_short && preview.reason == Some(ReviewDiffLimit::DiffTooComplex) {
                ReviewPreview::limited(ReviewDiffLimit::RequestBudgetExceeded)
            } else {
                preview
            }
        };
        if matches!(
            preview.reason,
            Some(
                ReviewDiffLimit::DiffTooLarge
                    | ReviewDiffLimit::RequestBudgetExceeded
                    | ReviewDiffLimit::WorkspaceUnavailable
            )
        ) || work.remaining == 0
        {
            truncated = true;
        }
        hunk_chars_left = hunk_chars_left.saturating_sub(hunk_chars(&preview.hunks));

        let status = if !baseline.before_exists {
            ReviewChangeStatus::Added
        } else if !after_exists {
            ReviewChangeStatus::Deleted
        } else {
            ReviewChangeStatus::Modified
        };
        let reversible = if baseline.before_exists {
            baseline.reversible
        } else {
            after_exists
        } && baseline_verified;
        files.push(
            FileRow {
                root: group.root,
                path: baseline.path.clone(),
                status,
                preview,
                reversible,
                rolled_back,
                snapshot_ids,
            }
            .into_change(),
        );
    }

    ReviewFilesOutcome {
        files,
        truncated,
        unreadable_records,
    }
}

/// One row's inputs before it becomes the serialized answer.
pub(super) struct FileRow {
    root: Option<String>,
    path: String,
    status: ReviewChangeStatus,
    preview: ReviewPreview,
    reversible: bool,
    rolled_back: bool,
    snapshot_ids: Vec<String>,
}

impl FileRow {
    fn into_change(self) -> ReviewFileChange {
        ReviewFileChange {
            version: 1,
            root: self.root,
            path: self.path,
            status: self.status,
            additions: self.preview.additions,
            deletions: self.preview.deletions,
            hunks: self.preview.hunks,
            binary: self.preview.binary,
            truncated: self.preview.truncated,
            reason: self.preview.reason,
            reversible: self.reversible,
            rolled_back: self.rolled_back,
            snapshot_ids: self.snapshot_ids,
        }
    }
}

/// Restore one file to the bytes the conversation first recorded for it.
///
/// The file is named by its root and relative path, so two project folders that
/// share a relative name never resolve to the same file. The latest recorded
/// post-tool hash still has to match what is on disk, so a later edit outside
/// this conversation is never overwritten.
pub fn rollback_file(
    data_dir: &Path,
    session_id: &str,
    roots: &SessionRoots,
    root: Option<&str>,
    path: &str,
) -> Result<FileRollbackOutcome> {
    let scan = scan_session(data_dir, session_id);
    let unreadable = scan.unreadable;
    let groups = group_history(roots, scan);
    let matches: Vec<&FileHistory> = groups
        .iter()
        .filter(|group| group.path == path)
        .filter(|group| match root {
            Some(root) => group.root.as_deref().is_some_and(|value| value == root),
            None => true,
        })
        .collect();
    let outcome =
        |root: Option<String>, status: &'static str, marks: Vec<ReviewFileRollbackMark>| {
            FileRollbackOutcome {
                status,
                root,
                path: path.to_string(),
                rolled_back: marks,
            }
        };
    // An unreadable record could be an earlier edit of this very file, so the
    // conversation's first bytes cannot be promised; nothing is written.
    if unreadable > 0 {
        return Ok(outcome(root.map(str::to_string), "unavailable", Vec::new()));
    }
    // An ambiguous name is never guessed: one file has to be identifiable.
    if matches.len() != 1 {
        return Ok(outcome(root.map(str::to_string), "unavailable", Vec::new()));
    }
    let group = matches[0];
    let Some((baseline_id, baseline)) = group.snapshots.first().cloned() else {
        return Ok(outcome(group.root.clone(), "unavailable", Vec::new()));
    };
    if baseline.before_exists && !baseline.reversible {
        return Ok(outcome(group.root.clone(), "unavailable", Vec::new()));
    }
    let location = snapshot_location(roots, &baseline);
    let Some(target) = location.target else {
        return Ok(outcome(group.root.clone(), "unavailable", Vec::new()));
    };
    let Some((_, latest)) = group
        .snapshots
        .iter()
        .rev()
        .find(|(_, meta)| meta.state == ReviewChangeState::Active)
    else {
        return Ok(outcome(group.root.clone(), "alreadyRolledBack", Vec::new()));
    };
    let current_exists = target.is_file();
    let current_hash = if current_exists {
        hash_file(&target).ok()
    } else {
        None
    };
    let unchanged = match (&latest.after_hash, current_exists) {
        (Some(expected), true) => current_hash.as_deref() == Some(expected.as_str()),
        (None, false) => true,
        _ => false,
    };
    if !unchanged {
        return Ok(outcome(group.root.clone(), "conflict", Vec::new()));
    }
    if baseline.before_exists {
        let dir = snapshot_dir(data_dir, session_id, &baseline_id)?;
        restore_before(&target, &before_path(&dir))?;
    } else if target.exists() {
        if !target.is_file() {
            return Ok(outcome(group.root.clone(), "unavailable", Vec::new()));
        }
        fs::remove_file(&target).context("remove created file during file rollback")?;
    }

    let mut marks = Vec::new();
    for (snapshot_id, _) in &group.snapshots {
        let dir = snapshot_dir(data_dir, session_id, snapshot_id)?;
        let mut meta = read_meta(data_dir, session_id, snapshot_id)?;
        if meta.state != ReviewChangeState::Active {
            continue;
        }
        meta.state = ReviewChangeState::RolledBack;
        write_meta(&metadata_path(&dir), &meta)?;
        marks.push(ReviewFileRollbackMark {
            snapshot_id: snapshot_id.clone(),
            message_id: meta.message_id,
        });
    }
    Ok(outcome(group.root.clone(), "rolledBack", marks))
}

pub fn remove_session(data_dir: &Path, session_id: &str) {
    if let Ok(dir) = session_review_dir(data_dir, session_id) {
        let _ = fs::remove_dir_all(dir);
    }
}

pub fn sweep(data_dir: &Path, live_session_ids: &std::collections::HashSet<String>) {
    let base = data_dir.join(REVIEW_DIR);
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !live_session_ids.contains(&id) {
            let _ = fs::remove_dir_all(path);
        }
    }
}
