use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use uuid::Uuid;

use crate::workspace::{self, ToolRoot};

use super::diff::{
    make_preview, DiffSide, PreviewLimits, ReviewPreview, MAX_DIFF_BYTES, MAX_RECORD_HUNK_CHARS,
};
use super::layout::{
    before_path, hash_bytes, hash_file, metadata_path, now_micros, read_meta, relative_path,
    root_identity, snapshot_dir, snapshot_location, write_meta, SessionRoots,
};
use super::model::{
    FileMutationPreview, ReviewChange, ReviewChangeOperation, ReviewChangeState,
    ReviewChangeStatus, ReviewDiffLimit, RollbackOutcome, SnapshotMeta,
};

/// The bytes one record retains. It matches the comparison ceiling, so a file
/// small enough to compare is also small enough to roll back.
pub(super) const MAX_SNAPSHOT_BYTES: u64 = MAX_DIFF_BYTES;

#[derive(Debug)]
pub struct PendingChange {
    snapshot_dir: PathBuf,
    before_path: PathBuf,
    resolved: PathBuf,
    session_id: String,
    message_id: String,
    snapshot_id: String,
    path: String,
    root: Option<String>,
    operation: ReviewChangeOperation,
    before_exists: bool,
    before_hash: Option<String>,
    before_copied: bool,
}

/// What one `Write` or `Edit` call already observed about the file it changed,
/// so the durable record can reuse that comparison instead of repeating it.
///
/// The evidence is internal to the host: it never crosses the IPC boundary.
/// It is only trusted when both hashes match the record's own captured state
/// and the preview was rendered under the same hunk cap (see
/// [`finalize_change`]); otherwise the record is computed from a fresh read.
#[derive(Debug, Clone)]
pub struct FileMutationEvidence {
    /// The bytes the tool observed before it wrote; `None` when the file did
    /// not exist, which is also what the record stores.
    pub before_hash: Option<String>,
    /// The hash of the bytes the tool wrote; `None` when it deleted the file.
    pub after_hash: Option<String>,
    /// The hunk-char ceiling the preview was rendered under.
    pub hunk_char_budget: usize,
    /// The per-call preview the tool already computed for its own result.
    pub preview: FileMutationPreview,
}

pub(super) fn tool_operation(tool_name: &str) -> Option<ReviewChangeOperation> {
    match tool_name {
        "Write" => Some(ReviewChangeOperation::Write),
        "Edit" => Some(ReviewChangeOperation::Edit),
        _ => None,
    }
}

/// Capture the pre-tool file without making review a prerequisite for tool
/// success. A missing or unreadable old file simply produces a non-reversible
/// review record after the tool completes.
pub fn prepare_change(
    data_dir: &Path,
    session_id: &str,
    message_id: &str,
    workspace_root: Option<&Path>,
    scratch_root: Option<&Path>,
    tool_name: &str,
    args: &Value,
) -> Result<Option<PendingChange>> {
    let Some(operation) = tool_operation(tool_name) else {
        return Ok(None);
    };
    let Some(root) = workspace_root else {
        return Ok(None);
    };
    let Some(input) = args.get("path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Ok((resolved, root_kind)) = workspace::resolve_tool_path(root, scratch_root, input) else {
        return Ok(None);
    };
    if root_kind != ToolRoot::Workspace {
        return Ok(None);
    }

    let snapshot_id = Uuid::new_v4().to_string();
    let snapshot_dir = snapshot_dir(data_dir, session_id, &snapshot_id)?;
    fs::create_dir_all(&snapshot_dir)?;
    let before_path = before_path(&snapshot_dir);
    let metadata = fs::metadata(&resolved).ok();
    let before_exists = metadata.as_ref().is_some_and(|value| value.is_file());
    // One read provides both the hash and the snapshot copy, so a write
    // between them cannot make the record describe bytes it never retained.
    let mut before_hash = None;
    let mut before_copied = false;
    if before_exists {
        if metadata
            .as_ref()
            .is_some_and(|value| value.len() <= MAX_SNAPSHOT_BYTES)
        {
            if let Ok(bytes) = fs::read(&resolved) {
                if bytes.len() as u64 <= MAX_SNAPSHOT_BYTES {
                    if let Ok(()) = fs::write(&before_path, &bytes) {
                        before_hash = Some(hash_bytes(&bytes));
                        before_copied = true;
                    }
                }
            }
        }
        if before_hash.is_none() {
            // Too large to retain, or unreadable for the copy: the guard still
            // describes the bytes the tool is about to act on.
            before_hash = hash_file(&resolved).ok();
        }
    }
    let path = relative_path(root, &resolved);

    Ok(Some(PendingChange {
        snapshot_dir,
        before_path,
        resolved,
        session_id: session_id.to_string(),
        message_id: message_id.to_string(),
        snapshot_id,
        path,
        // The path is relative to this root, so the record has to carry it: a
        // project group's second folder can hold the same relative name.
        root: root_identity(root),
        operation,
        before_exists,
        before_hash,
        before_copied,
    }))
}

pub fn discard_change(pending: PendingChange) {
    let _ = fs::remove_dir_all(pending.snapshot_dir);
}

/// What one read of a side produced: the bytes retained for the comparison
/// when they fit, and the hash of the file that was actually read.
enum SideBytes {
    /// The side does not exist, so it reads as no lines at all.
    Absent,
    Retained(Vec<u8>),
    /// The side exists but is over the comparison ceiling, so only its hash is
    /// known.
    Oversize(String),
    Unreadable,
}

impl SideBytes {
    fn hash(&self) -> Option<String> {
        match self {
            SideBytes::Retained(bytes) => Some(hash_bytes(bytes)),
            SideBytes::Oversize(hash) => Some(hash.clone()),
            SideBytes::Absent | SideBytes::Unreadable => None,
        }
    }

    fn diff_side(self) -> DiffSide {
        match self {
            SideBytes::Retained(bytes) => DiffSide::Present(bytes),
            SideBytes::Absent => DiffSide::Present(Vec::new()),
            SideBytes::Oversize(_) => DiffSide::TooLarge,
            SideBytes::Unreadable => DiffSide::Missing,
        }
    }
}

fn read_side(path: Option<&Path>, exists: bool) -> SideBytes {
    if !exists {
        return SideBytes::Absent;
    }
    let Some(path) = path else {
        return SideBytes::Unreadable;
    };
    let Ok(metadata) = fs::metadata(path) else {
        return SideBytes::Unreadable;
    };
    if !metadata.is_file() {
        return SideBytes::Unreadable;
    }
    if metadata.len() > MAX_SNAPSHOT_BYTES {
        return match hash_file(path) {
            Ok(hash) => SideBytes::Oversize(hash),
            Err(_) => SideBytes::Unreadable,
        };
    }
    match fs::read(path) {
        Ok(bytes) if bytes.len() as u64 <= MAX_SNAPSHOT_BYTES => SideBytes::Retained(bytes),
        // The file grew past the ceiling between the metadata read and the
        // read itself, so only its hash is retained.
        Ok(_) => match hash_file(path) {
            Ok(hash) => SideBytes::Oversize(hash),
            Err(_) => SideBytes::Unreadable,
        },
        Err(_) => SideBytes::Unreadable,
    }
}

pub fn finalize_change(
    pending: &PendingChange,
    evidence: Option<&FileMutationEvidence>,
) -> Result<ReviewChange> {
    let after_exists = pending.resolved.is_file();
    let after = read_side(Some(pending.resolved.as_path()), after_exists);
    let after_hash = after.hash();
    if after_exists && after_hash.is_none() {
        return Err(anyhow!("read review target after tool execution"));
    }
    let before = read_side(
        pending
            .before_copied
            .then_some(pending.before_path.as_path()),
        pending.before_exists,
    );
    // The retained copy has to hold the bytes the record claims to have
    // captured; otherwise the record would describe a baseline that never
    // existed and the row says so instead of inventing a comparison. A file
    // too large to retain has no copy to check, so the comparison reports its
    // size limit instead of claiming the baseline raced.
    let baseline_raced = pending.before_copied
        && pending.before_exists
        && pending.before_hash.is_some()
        && before.hash().as_deref() != pending.before_hash.as_deref();
    let preview = match evidence {
        Some(evidence)
            if !baseline_raced
                && evidence.before_hash == pending.before_hash
                && evidence.after_hash == after_hash
                && evidence.hunk_char_budget == MAX_RECORD_HUNK_CHARS =>
        {
            preview_of(evidence)
        }
        _ if baseline_raced => ReviewPreview::limited(ReviewDiffLimit::BaselineUnavailable),
        _ => make_preview(
            before.diff_side(),
            after.diff_side(),
            MAX_RECORD_HUNK_CHARS,
            &mut PreviewLimits::file(Instant::now()),
        ),
    };
    let status = match (pending.before_exists, after_exists) {
        (false, true) => ReviewChangeStatus::Added,
        (true, false) => ReviewChangeStatus::Deleted,
        _ => ReviewChangeStatus::Modified,
    };
    // Existing files remain reversible even when the tool deleted them; new
    // files need to exist after the tool so rollback can remove them.
    let reversible = if pending.before_exists {
        pending.before_copied
    } else {
        after_exists
    };
    let meta = SnapshotMeta {
        version: 1,
        session_id: pending.session_id.clone(),
        message_id: pending.message_id.clone(),
        path: pending.path.clone(),
        root: pending.root.clone(),
        created_at: Some(now_micros()),
        operation: pending.operation,
        before_exists: pending.before_exists,
        before_hash: pending.before_hash.clone(),
        after_exists,
        after_hash,
        reversible,
        state: ReviewChangeState::Active,
    };
    write_meta(&metadata_path(&pending.snapshot_dir), &meta)?;
    Ok(ReviewChange {
        version: 1,
        snapshot_id: pending.snapshot_id.clone(),
        message_id: pending.message_id.clone(),
        path: pending.path.clone(),
        operation: pending.operation,
        status,
        state: ReviewChangeState::Active,
        additions: preview.additions,
        deletions: preview.deletions,
        hunks: preview.hunks,
        binary: preview.binary,
        truncated: preview.truncated,
        reason: preview.reason,
        reversible,
    })
}

/// The comparison a tool call already performed, in the shape a record stores.
fn preview_of(evidence: &FileMutationEvidence) -> ReviewPreview {
    ReviewPreview {
        binary: evidence.preview.binary,
        truncated: evidence.preview.truncated,
        reason: evidence.preview.reason,
        additions: evidence.preview.additions,
        deletions: evidence.preview.deletions,
        hunks: evidence.preview.hunks.clone(),
    }
}

pub(super) fn restore_before(target: &Path, before: &Path) -> Result<()> {
    let bytes = fs::read(before).context("read review rollback snapshot")?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err(anyhow!("review rollback snapshot exceeds the size limit"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(target, bytes).context("restore review rollback snapshot")?;
    Ok(())
}

pub fn rollback_change(
    data_dir: &Path,
    session_id: &str,
    snapshot_id: &str,
    roots: &SessionRoots,
) -> Result<RollbackOutcome> {
    let dir = snapshot_dir(data_dir, session_id, snapshot_id)?;
    let mut meta = read_meta(data_dir, session_id, snapshot_id)?;
    let root = meta.root.clone();
    let unavailable = || RollbackOutcome {
        status: "unavailable",
        snapshot_id: snapshot_id.to_string(),
        message_id: meta.message_id.clone(),
        path: meta.path.clone(),
        root: root.clone(),
    };
    if meta.state == ReviewChangeState::RolledBack {
        return Ok(RollbackOutcome {
            status: "alreadyRolledBack",
            snapshot_id: snapshot_id.to_string(),
            message_id: meta.message_id.clone(),
            path: meta.path.clone(),
            root: root.clone(),
        });
    }
    if !meta.reversible {
        return Ok(unavailable());
    }
    // The record's own root has to still be one of this session's roots; a
    // group folder that was removed cannot redirect the write elsewhere.
    let location = snapshot_location(roots, &meta);
    let Some(target) = location.target else {
        return Ok(unavailable());
    };
    let current_exists = target.is_file();
    let current_hash = if current_exists {
        hash_file(&target).ok()
    } else {
        None
    };
    let unchanged = match (&meta.after_hash, current_exists) {
        (Some(expected), true) => current_hash.as_deref() == Some(expected.as_str()),
        (None, false) => true,
        _ => false,
    };
    if !unchanged {
        return Ok(RollbackOutcome {
            status: "conflict",
            snapshot_id: snapshot_id.to_string(),
            message_id: meta.message_id,
            path: meta.path,
            root,
        });
    }
    if meta.before_exists {
        restore_before(&target, &before_path(&dir))?;
    } else if target.exists() {
        if !target.is_file() {
            return Ok(unavailable());
        }
        fs::remove_file(&target).context("remove created file during rollback")?;
    }
    meta.state = ReviewChangeState::RolledBack;
    write_meta(&metadata_path(&dir), &meta)?;
    Ok(RollbackOutcome {
        status: "rolledBack",
        snapshot_id: snapshot_id.to_string(),
        message_id: meta.message_id,
        path: meta.path,
        root,
    })
}
