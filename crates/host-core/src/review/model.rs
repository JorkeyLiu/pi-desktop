use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewChangeOperation {
    /// Records written before the contract casing existed hold `Write`/`Edit`/
    /// `Delete`; the alias keeps them readable while new records serialize in
    /// the shared `write | edit | delete` vocabulary. Unknown values still fail.
    #[serde(alias = "Write")]
    Write,
    #[serde(alias = "Edit")]
    Edit,
    #[serde(alias = "Delete")]
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
    pub(super) line_type: String,
    pub(super) text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffHunk {
    pub(super) header: String,
    pub(super) lines: Vec<ReviewDiffLine>,
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

pub(super) fn is_zero(value: &usize) -> bool {
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
pub(super) struct SnapshotMeta {
    pub(super) version: u8,
    pub(super) session_id: String,
    pub(super) message_id: String,
    pub(super) path: String,
    /// The workspace root the path is relative to. Absent on records written
    /// before roots were recorded, which are only usable when the session has a
    /// single root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) root: Option<String>,
    /// Wall-clock microseconds when the record was finalized, used to order a
    /// file's history without relying on the renderer's window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) created_at: Option<i64>,
    pub(super) operation: ReviewChangeOperation,
    pub(super) before_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) before_hash: Option<String>,
    pub(super) after_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) after_hash: Option<String>,
    pub(super) reversible: bool,
    pub(super) state: ReviewChangeState,
}
