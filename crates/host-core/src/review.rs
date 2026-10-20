//! Durable, message-scoped workspace change snapshots.
//!
//! Review evidence is captured at tool execution time instead of being
//! reconstructed from a mutable git working tree. The previous file content
//! lives outside the workspace so a later commit cannot erase the review
//! history, and rollback is guarded by the post-tool content hash.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::workspace::{self, ToolRoot};

const REVIEW_DIR: &str = "review-changes";
const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
/// One side of a comparison is read whole, so it keeps a byte ceiling.
const MAX_DIFF_BYTES: u64 = 512 * 1024;
/// Largest changed region solved exactly in one pass: line pairs, not the file.
const MAX_DIFF_CELLS: usize = 2_000_000;
/// Total line work one diff may spend, anchor searches included.
const MAX_DIFF_WORK: usize = 24_000_000;
/// Hunk bodies above this many lines are dropped; exact counts are kept.
const MAX_DIFF_OUTPUT_LINES: usize = 8_000;
/// A review record's hunk text stays far below the renderer's display cap, so a
/// re-read transcript keeps its identity fields.
const MAX_RECORD_HUNK_CHARS: usize = 48 * 1024;
/// Hunk text one `review.files` response may carry across all rows.
const MAX_RESPONSE_HUNK_CHARS: usize = 512 * 1024;
/// Line work one `review.files` request may spend across all files.
const MAX_REQUEST_DIFF_WORK: usize = 48_000_000;
/// Deepest anchor bisection before the comparison reports its budget.
const MAX_ANCHOR_DEPTH: usize = 64;
/// Snapshot directories one request may scan.
const MAX_SESSION_SNAPSHOTS: usize = 8_192;
/// File rows one request may return.
const MAX_REVIEW_FILES: usize = 512;
const CONTEXT_LINES: usize = 3;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReviewChangeOperation {
    Write,
    Edit,
    Delete,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewChangeStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewChangeState {
    Active,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffLine {
    #[serde(rename = "type")]
    line_type: String,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffHunk {
    header: String,
    lines: Vec<ReviewDiffLine>,
}

/// Why a comparison carries no trustworthy line evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewDiffLimit {
    /// One side exceeds the readable byte ceiling.
    FileTooLarge,
    /// The changed region exceeds the comparison budget.
    DiffTooComplex,
    /// The hunk body exceeds the render ceiling; counts stay exact.
    DiffTooLarge,
    /// The earlier bytes were not retained, so nothing can be compared.
    BaselineUnavailable,
    /// The file could not be read or resolved.
    Unreadable,
    /// The record does not name a workspace root the session still has, so it
    /// cannot be attributed to one tree without guessing.
    WorkspaceUnavailable,
    /// The request's total comparison work was already spent.
    RequestBudgetExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChange {
    pub version: u8,
    pub snapshot_id: String,
    pub message_id: String,
    pub path: String,
    pub operation: ReviewChangeOperation,
    pub status: ReviewChangeStatus,
    pub state: ReviewChangeState,
    /// Omitted when the comparison could not count the change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
    pub hunks: Vec<ReviewDiffHunk>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ReviewDiffLimit>,
    pub reversible: bool,
}

/// One file's net change for the session, from the bytes the topic first saw to
/// the working tree as it is now. Per-tool records stay on their messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFileChange {
    pub version: u8,
    /// The workspace root this file belongs to, so two project folders that
    /// share a relative path stay distinct.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub path: String,
    pub status: ReviewChangeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
    pub hunks: Vec<ReviewDiffHunk>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ReviewDiffLimit>,
    pub reversible: bool,
    pub rolled_back: bool,
    /// The snapshots this net change is built from, oldest first.
    pub snapshot_ids: Vec<String>,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

/// One `review.files` answer. The host owns the file set, so a partial list is
/// stated rather than inferred from what a renderer window happened to hold.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFilesOutcome {
    pub files: Vec<ReviewFileChange>,
    /// More files or records exist than this answer carries.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// Snapshot records under the session that could not be read at all.
    #[serde(skip_serializing_if = "is_zero")]
    pub unreadable_records: usize,
}

/// One file's rollback marks, so the caller can mirror them onto messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFileRollbackMark {
    pub snapshot_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRollbackOutcome {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub path: String,
    pub rolled_back: Vec<ReviewFileRollbackMark>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackOutcome {
    pub status: &'static str,
    pub snapshot_id: String,
    pub message_id: String,
    pub path: String,
    /// The workspace root the path was resolved in, so the caller can
    /// invalidate the right edit target.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMeta {
    version: u8,
    session_id: String,
    message_id: String,
    path: String,
    /// The workspace root the path is relative to. Absent on records written
    /// before roots were recorded, which are only usable when the session has a
    /// single root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    /// Wall-clock microseconds when the record was finalized, used to order a
    /// file's history without relying on the renderer's window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
    operation: ReviewChangeOperation,
    before_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    before_hash: Option<String>,
    after_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    after_hash: Option<String>,
    reversible: bool,
    state: ReviewChangeState,
}

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

#[derive(Debug, Clone)]
enum DiffOp {
    Equal(String),
    Add(String),
    Del(String),
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn session_review_dir(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    if !safe_component(session_id) {
        return Err(anyhow!("invalid session id"));
    }
    Ok(data_dir.join(REVIEW_DIR).join(session_id))
}

fn snapshot_dir(data_dir: &Path, session_id: &str, snapshot_id: &str) -> Result<PathBuf> {
    if !safe_component(snapshot_id) {
        return Err(anyhow!("invalid snapshot id"));
    }
    Ok(session_review_dir(data_dir, session_id)?.join(snapshot_id))
}

fn metadata_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

/// The canonical spelling of a workspace root, used as a record's root
/// identity and to compare a recorded root with the session's live roots.
fn root_identity(root: &Path) -> Option<String> {
    if !root.is_absolute() {
        return None;
    }
    Some(
        canonical_or_lexical(root)
            .to_string_lossy()
            .replace('\\', "/"),
    )
}

fn canonical_or_lexical(path: &Path) -> PathBuf {
    workspace::simple_canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_root(left: &Path, right: &str) -> bool {
    if right.is_empty() {
        return false;
    }
    canonical_or_lexical(left) == canonical_or_lexical(Path::new(right))
}

/// Microseconds since the epoch. Every record is finalized by its own tool call,
/// so two records of one file are separated by file I/O rather than by a clock
/// tick; a same-microsecond tie falls back to the record id in `scan_session`.
/// Milliseconds would let two edits of one file tie, and the tie-break could
/// then hand back a baseline taken after the conversation's first write.
fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_micros() as i64)
        .unwrap_or(0)
}

/// The workspace roots a session may write into: its primary root plus any
/// other root of the same project group, exactly as tool calls resolved them.
///
/// A snapshot records the root its path is relative to. Reading or rolling one
/// back is only allowed inside a root this list holds, so a group folder that
/// was removed, a forged record, or two folders that share a relative name can
/// never redirect a write.
#[derive(Debug, Clone)]
pub struct SessionRoots {
    primary: PathBuf,
    all: Vec<PathBuf>,
}

#[allow(dead_code)]
impl SessionRoots {
    /// The session's primary root (its project, worktree, or scratch dir).
    pub fn primary(&self) -> &Path {
        &self.primary
    }
}

impl SessionRoots {
    pub fn new(primary: PathBuf, extra: Vec<PathBuf>) -> Self {
        let mut all = vec![primary.clone()];
        for root in extra {
            if !all
                .iter()
                .any(|known| same_root(known, &root.to_string_lossy()))
            {
                all.push(root);
            }
        }
        Self { primary, all }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn single(primary: PathBuf) -> Self {
        Self {
            all: vec![primary.clone()],
            primary,
        }
    }

    fn only_root(&self) -> Option<&Path> {
        (self.all.len() == 1).then(|| self.all[0].as_path())
    }

    /// The root a record belongs to, or `None` when that cannot be proven.
    fn resolve(&self, meta: &SnapshotMeta) -> Option<PathBuf> {
        match meta.root.as_deref() {
            Some(root) => self
                .all
                .iter()
                .find(|known| same_root(known, root))
                .cloned(),
            // A record written before roots were stored is only unambiguous
            // when the session has exactly one root; otherwise it is not
            // resolved rather than guessed.
            None => self.only_root().map(Path::to_path_buf),
        }
    }
}

/// Where one snapshot record's file lives.
#[derive(Debug, Clone)]
struct SnapshotLocation {
    root: Option<String>,
    target: Option<PathBuf>,
}

fn snapshot_location(roots: &SessionRoots, meta: &SnapshotMeta) -> SnapshotLocation {
    let display_root = meta.root.clone().or_else(|| {
        roots
            .only_root()
            .map(|root| root.to_string_lossy().replace('\\', "/"))
    });
    let target = roots
        .resolve(meta)
        .and_then(|root| workspace::resolve_in_workspace(&root, &meta.path).ok());
    SnapshotLocation {
        root: display_root,
        target,
    }
}
fn before_path(dir: &Path) -> PathBuf {
    dir.join("before")
}

fn relative_path(root: &Path, path: &Path) -> String {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path.strip_prefix(&canonical_root)
        .or_else(|_| path.strip_prefix(root))
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)
        .with_context(|| format!("open file for review hash: {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn write_meta(path: &Path, meta: &SnapshotMeta) -> Result<()> {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(meta)?)?;
    fs::rename(&temp, path)?;
    Ok(())
}

fn read_meta(data_dir: &Path, session_id: &str, snapshot_id: &str) -> Result<SnapshotMeta> {
    let dir = snapshot_dir(data_dir, session_id, snapshot_id)?;
    let bytes = fs::read(metadata_path(&dir))
        .with_context(|| format!("review snapshot not found: {snapshot_id}"))?;
    let meta: SnapshotMeta = serde_json::from_slice(&bytes)?;
    if meta.session_id != session_id || meta.message_id.trim().is_empty() {
        return Err(anyhow!("review snapshot does not belong to this session"));
    }
    Ok(meta)
}

fn tool_operation(tool_name: &str) -> Option<ReviewChangeOperation> {
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
    let before_hash = if before_exists {
        hash_file(&resolved).ok()
    } else {
        None
    };
    let before_copied = before_exists
        && metadata
            .as_ref()
            .is_some_and(|value| value.len() <= MAX_SNAPSHOT_BYTES)
        && fs::copy(&resolved, &before_path).is_ok();
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

enum DiffSide {
    Present(Vec<u8>),
    TooLarge,
    Missing,
}

/// Read one side of a comparison. A missing earlier side means the snapshot
/// bytes were not retained, which is different from a file that never existed.
fn read_diff_side(path: Option<&Path>, exists: bool) -> DiffSide {
    if !exists {
        return DiffSide::Present(Vec::new());
    }
    let Some(path) = path else {
        return DiffSide::Missing;
    };
    let Ok(metadata) = fs::metadata(path) else {
        return DiffSide::Missing;
    };
    if !metadata.is_file() {
        return DiffSide::Missing;
    }
    if metadata.len() > MAX_DIFF_BYTES {
        return DiffSide::TooLarge;
    }
    match fs::read(path) {
        Ok(bytes) => DiffSide::Present(bytes),
        Err(_) => DiffSide::Missing,
    }
}

/// Line work one comparison may spend. A long file with a small edit finishes
/// after the common prefix/suffix trim and never reaches this budget.
#[derive(Clone, Copy)]
struct DiffBudget {
    remaining: usize,
    /// The ceiling this child slice was given, so a parent can bill its use.
    limit: usize,
}

impl DiffBudget {
    fn new(limit: usize) -> Self {
        Self {
            remaining: limit,
            limit,
        }
    }

    /// A slice of this budget for one file, never larger than `cap`.
    fn capped(&mut self, cap: usize) -> DiffBudget {
        DiffBudget::new(self.remaining.min(cap))
    }

    /// Bill the parent for what the child slice actually spent.
    fn settle(&mut self, child: DiffBudget) {
        let used = child.limit.saturating_sub(child.remaining);
        self.remaining = self.remaining.saturating_sub(used);
    }

    fn take(&mut self, cost: usize) -> bool {
        if cost > self.remaining {
            self.remaining = 0;
            false
        } else {
            self.remaining -= cost;
            true
        }
    }
}

/// Compare two files as line sequences. `None` means the changed region needed
/// more work than the budget allows, so no count from it can be trusted.
fn diff_ops(before: &[String], after: &[String], budget: &mut DiffBudget) -> Option<Vec<DiffOp>> {
    let mut ops = Vec::with_capacity(before.len() + after.len());
    diff_window(
        before,
        0,
        before.len(),
        after,
        0,
        after.len(),
        0,
        budget,
        &mut ops,
    )?;
    Some(ops)
}

#[allow(clippy::too_many_arguments)]
fn diff_window(
    before: &[String],
    mut before_start: usize,
    before_end: usize,
    after: &[String],
    mut after_start: usize,
    after_end: usize,
    depth: usize,
    budget: &mut DiffBudget,
    ops: &mut Vec<DiffOp>,
) -> Option<()> {
    while before_start < before_end
        && after_start < after_end
        && before[before_start] == after[after_start]
    {
        ops.push(DiffOp::Equal(before[before_start].clone()));
        before_start += 1;
        after_start += 1;
    }
    let mut before_tail = before_end;
    let mut after_tail = after_end;
    while before_tail > before_start
        && after_tail > after_start
        && before[before_tail - 1] == after[after_tail - 1]
    {
        before_tail -= 1;
        after_tail -= 1;
    }

    let before_len = before_tail - before_start;
    let after_len = after_tail - after_start;
    if before_len == 0 || after_len == 0 {
        if !budget.take(before_len + after_len + 1) {
            return None;
        }
        for line in &before[before_start..before_tail] {
            ops.push(DiffOp::Del(line.clone()));
        }
        for line in &after[after_start..after_tail] {
            ops.push(DiffOp::Add(line.clone()));
        }
    } else {
        let cells = (before_len + 1).saturating_mul(after_len + 1);
        if cells <= MAX_DIFF_CELLS && budget.take(cells) {
            lcs_ops(
                before,
                before_start,
                before_tail,
                after,
                after_start,
                after_tail,
                ops,
            );
        } else {
            // A region that is too large to solve at once is split on a line
            // that occurs exactly once on both sides, so scattered edits in a
            // long file still resolve into real hunks.
            if depth >= MAX_ANCHOR_DEPTH || !budget.take(before_len + after_len) {
                return None;
            }
            let (before_at, after_at) = bisect_anchor(
                before,
                before_start,
                before_tail,
                after,
                after_start,
                after_tail,
            )?;
            diff_window(
                before,
                before_start,
                before_at,
                after,
                after_start,
                after_at,
                depth + 1,
                budget,
                ops,
            )?;
            ops.push(DiffOp::Equal(before[before_at].clone()));
            diff_window(
                before,
                before_at + 1,
                before_tail,
                after,
                after_at + 1,
                after_tail,
                depth + 1,
                budget,
                ops,
            )?;
        }
    }

    for line in &before[before_tail..before_end] {
        ops.push(DiffOp::Equal(line.clone()));
    }
    Some(())
}

#[allow(clippy::too_many_arguments)]
fn lcs_ops(
    before: &[String],
    before_start: usize,
    before_end: usize,
    after: &[String],
    after_start: usize,
    after_end: usize,
    ops: &mut Vec<DiffOp>,
) {
    let old_len = before_end - before_start;
    let new_len = after_end - after_start;
    let mut lcs = vec![vec![0_u32; new_len + 1]; old_len + 1];
    for old in (0..old_len).rev() {
        for new in (0..new_len).rev() {
            lcs[old][new] = if before[before_start + old] == after[after_start + new] {
                lcs[old + 1][new + 1] + 1
            } else {
                lcs[old + 1][new].max(lcs[old][new + 1])
            };
        }
    }

    let mut old = 0;
    let mut new = 0;
    while old < old_len || new < new_len {
        if old < old_len && new < new_len && before[before_start + old] == after[after_start + new]
        {
            ops.push(DiffOp::Equal(before[before_start + old].clone()));
            old += 1;
            new += 1;
        } else if new == new_len || (old < old_len && lcs[old + 1][new] >= lcs[old][new + 1]) {
            ops.push(DiffOp::Del(before[before_start + old].clone()));
            old += 1;
        } else {
            ops.push(DiffOp::Add(after[after_start + new].clone()));
            new += 1;
        }
    }
}

/// The line closest to the middle of the region that occurs exactly once on
/// both sides, so splitting there advances both halves.
#[allow(clippy::too_many_arguments)]
fn bisect_anchor(
    before: &[String],
    before_start: usize,
    before_end: usize,
    after: &[String],
    after_start: usize,
    after_end: usize,
) -> Option<(usize, usize)> {
    use std::collections::HashMap;
    let mut counts: HashMap<&str, (usize, usize, usize)> = HashMap::new();
    for (offset, line) in before[before_start..before_end].iter().enumerate() {
        let entry = counts
            .entry(line.as_str())
            .or_insert((0, 0, before_start + offset));
        entry.0 += 1;
    }
    for line in &after[after_start..after_end] {
        if let Some(entry) = counts.get_mut(line.as_str()) {
            entry.1 += 1;
        }
    }

    let middle = (before_start + before_end) / 2;
    let mut best: Option<(usize, usize, usize)> = None;
    for (offset, line) in after[after_start..after_end].iter().enumerate() {
        let Some(&(before_count, after_count, before_index)) = counts.get(line.as_str()) else {
            continue;
        };
        if before_count != 1 || after_count != 1 {
            continue;
        }
        let distance = before_index.abs_diff(middle);
        if best.is_none_or(|(best_distance, _, _)| distance < best_distance) {
            best = Some((distance, before_index, after_start + offset));
        }
    }
    best.map(|(_, before_index, after_index)| (before_index, after_index))
}

fn line_counts(ops: &[DiffOp]) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    for op in ops {
        match op {
            DiffOp::Add(_) => additions += 1,
            DiffOp::Del(_) => deletions += 1,
            DiffOp::Equal(_) => {}
        }
    }
    (additions, deletions)
}

fn old_line_count(op: &DiffOp) -> usize {
    matches!(op, DiffOp::Equal(_) | DiffOp::Del(_)) as usize
}

fn new_line_count(op: &DiffOp) -> usize {
    matches!(op, DiffOp::Equal(_) | DiffOp::Add(_)) as usize
}

fn make_hunks(ops: &[DiffOp]) -> Vec<ReviewDiffHunk> {
    let changed: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter_map(|(index, op)| (!matches!(op, DiffOp::Equal(_))).then_some(index))
        .collect();
    if changed.is_empty() {
        return Vec::new();
    }

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for index in changed {
        let start = index.saturating_sub(CONTEXT_LINES);
        let end = (index + CONTEXT_LINES + 1).min(ops.len());
        if let Some((_, previous_end)) = ranges.last_mut() {
            if start <= *previous_end {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        ranges.push((start, end));
    }

    let mut hunks = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        let old_before = ops[..start].iter().map(old_line_count).sum::<usize>();
        let new_before = ops[..start].iter().map(new_line_count).sum::<usize>();
        let old_len = ops[start..end].iter().map(old_line_count).sum::<usize>();
        let new_len = ops[start..end].iter().map(new_line_count).sum::<usize>();
        let old_start = old_before + 1;
        let new_start = new_before + 1;
        let lines = ops[start..end]
            .iter()
            .map(|op| match op {
                DiffOp::Equal(text) => ReviewDiffLine {
                    line_type: "context".into(),
                    text: text.clone(),
                },
                DiffOp::Add(text) => ReviewDiffLine {
                    line_type: "add".into(),
                    text: text.clone(),
                },
                DiffOp::Del(text) => ReviewDiffLine {
                    line_type: "del".into(),
                    text: text.clone(),
                },
            })
            .collect();
        hunks.push(ReviewDiffHunk {
            header: format!("@@ -{old_start},{old_len} +{new_start},{new_len} @@"),
            lines,
        });
    }
    hunks
}

/// The evidence one comparison produced. Counts are only present when they are
/// exact; a limit explains why the line evidence is missing.
struct ReviewPreview {
    binary: bool,
    truncated: bool,
    reason: Option<ReviewDiffLimit>,
    additions: Option<usize>,
    deletions: Option<usize>,
    hunks: Vec<ReviewDiffHunk>,
}

impl ReviewPreview {
    fn empty() -> Self {
        Self {
            binary: false,
            truncated: false,
            reason: None,
            additions: None,
            deletions: None,
            hunks: Vec::new(),
        }
    }

    fn limited(reason: ReviewDiffLimit) -> Self {
        Self {
            truncated: true,
            reason: Some(reason),
            ..Self::empty()
        }
    }

    fn binary() -> Self {
        Self {
            binary: true,
            ..Self::empty()
        }
    }
}

fn make_preview(
    before: DiffSide,
    after: DiffSide,
    hunk_char_budget: usize,
    work: &mut DiffBudget,
) -> ReviewPreview {
    let (before, after) = match (before, after) {
        (DiffSide::TooLarge, _) | (_, DiffSide::TooLarge) => {
            return ReviewPreview::limited(ReviewDiffLimit::FileTooLarge)
        }
        (DiffSide::Missing, _) | (_, DiffSide::Missing) => {
            return ReviewPreview::limited(ReviewDiffLimit::BaselineUnavailable)
        }
        (DiffSide::Present(before), DiffSide::Present(after)) => (before, after),
    };
    if before.contains(&0) || after.contains(&0) {
        return ReviewPreview::binary();
    }
    let Ok(before) = String::from_utf8(before) else {
        return ReviewPreview::binary();
    };
    let Ok(after) = String::from_utf8(after) else {
        return ReviewPreview::binary();
    };
    let before_lines: Vec<String> = before.lines().map(str::to_string).collect();
    let after_lines: Vec<String> = after.lines().map(str::to_string).collect();
    let Some(ops) = diff_ops(&before_lines, &after_lines, work) else {
        return ReviewPreview::limited(ReviewDiffLimit::DiffTooComplex);
    };
    let (additions, deletions) = line_counts(&ops);
    let hunks = make_hunks(&ops);
    let hunk_lines: usize = hunks.iter().map(|hunk| hunk.lines.len()).sum();
    let hunk_chars: usize = hunks
        .iter()
        .flat_map(|hunk| hunk.lines.iter())
        .map(|line| line.text.chars().count())
        .sum();
    if hunk_lines > MAX_DIFF_OUTPUT_LINES || hunk_chars > hunk_char_budget {
        // The counts are exact even though the body is not worth sending, and a
        // record that stays this small survives the renderer's display cap with
        // its identity fields intact.
        return ReviewPreview {
            truncated: true,
            reason: Some(ReviewDiffLimit::DiffTooLarge),
            additions: Some(additions),
            deletions: Some(deletions),
            ..ReviewPreview::empty()
        };
    }
    ReviewPreview {
        additions: Some(additions),
        deletions: Some(deletions),
        hunks,
        ..ReviewPreview::empty()
    }
}

pub fn finalize_change(pending: &PendingChange) -> Result<ReviewChange> {
    let after_exists = pending.resolved.is_file();
    let after_hash = if after_exists {
        Some(hash_file(&pending.resolved)?)
    } else {
        None
    };
    let preview = make_preview(
        read_diff_side(
            pending
                .before_copied
                .then_some(pending.before_path.as_path()),
            pending.before_exists,
        ),
        read_diff_side(Some(pending.resolved.as_path()), after_exists),
        MAX_RECORD_HUNK_CHARS,
        &mut DiffBudget::new(MAX_DIFF_WORK),
    );
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

fn restore_before(target: &Path, before: &Path) -> Result<()> {
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

/// One record read back from the session's snapshot directory.
struct ScannedSnapshot {
    id: String,
    meta: SnapshotMeta,
    /// Microsecond order of the record; the file's timestamp stands in for
    /// records written before `created_at` existed, and the record id breaks any
    /// remaining tie so one directory always yields one order.
    order: (i64, String),
}

struct SessionScan {
    entries: Vec<ScannedSnapshot>,
    unreadable: usize,
    truncated: bool,
}

/// The record's write time in microseconds, standing in for records written
/// before the record itself carried one.
fn meta_micros(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_micros() as i64)
        .unwrap_or(0)
}

/// A microsecond timestamp for any date after 2001 stays above this floor, while
/// a millisecond one stays far below it.
const MICROS_FLOOR: i64 = 1_000_000_000_000_000;

/// The instant a record is ordered by, always in microseconds. A record written
/// while this field held milliseconds is scaled, and a record written before the
/// field existed falls back to the file's own timestamp, so one scan never
/// compares two different units and a file's first record stays first.
fn record_micros(created_at: Option<i64>, meta_path: &Path) -> i64 {
    match created_at {
        Some(value) if value >= MICROS_FLOOR => value,
        Some(value) if value > 0 => value.saturating_mul(1000),
        _ => meta_micros(meta_path),
    }
}

/// Read every snapshot this session recorded. The session directory is the
/// authority, so a renderer's message window cannot shorten a file's history.
fn scan_session(data_dir: &Path, session_id: &str) -> SessionScan {
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
struct FileHistory {
    root: Option<String>,
    path: String,
    snapshots: Vec<(String, SnapshotMeta)>,
}

/// one belongs to.
fn group_history(roots: &SessionRoots, scan: SessionScan) -> Vec<FileHistory> {
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

fn hunk_chars(hunks: &[ReviewDiffHunk]) -> usize {
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
struct FileRow {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
}
