//! Durable, message-scoped workspace change snapshots.
//!
//! Review evidence is captured at tool execution time instead of being
//! reconstructed from a mutable git working tree. The previous file content
//! lives outside the workspace so a later commit cannot erase the review
//! history, and rollback is guarded by the post-tool content hash.
//!
//! The domain is split by responsibility: the model module holds the serialized
//! shapes, the layout module resolves where a record lives and which root it
//! belongs to, the diff module compares bounded file content, the snapshot
//! module captures and rolls back one tool call, and the session module reads a
//! session's whole history into file rows.

mod diff;
mod layout;
mod model;
mod session;
mod snapshot;

pub use layout::SessionRoots;
#[allow(unused_imports)]
pub use model::{
    EditDiff, EditDiffStatus, FileRollbackOutcome, ReviewChange, ReviewChangeOperation,
    ReviewChangeState, ReviewChangeStatus, ReviewDiffHunk, ReviewDiffLimit, ReviewDiffLine,
    ReviewFileChange, ReviewFileRollbackMark, ReviewFilesOutcome, RollbackOutcome,
};
pub use session::{file_changes, remove_session, rollback_file, sweep};
#[allow(unused_imports)]
pub use snapshot::PendingChange;
pub use snapshot::{discard_change, finalize_change, prepare_change, rollback_change};

/// Bounded in-memory preview of one `Edit` call's actual bytes.
///
/// Unlike `prepare_change`/`finalize_change` this writes no snapshot and
/// confers no rollback: scratch and explicitly approved external edits get
/// the same per-call line evidence as workspace edits without durable review
/// records. `before` is the exact bytes the edit operated on; `after` is the
/// bytes written, or `None` when the edit deleted the file (a deletion reads
/// as all lines removed, mirroring the durable record). No filesystem read
/// happens here, so nothing outside the already authorized edit target is
/// touched.
pub fn preview_edit_diff(
    path: String,
    root: String,
    status: EditDiffStatus,
    before: &[u8],
    after: Option<&[u8]>,
) -> EditDiff {
    use diff::{
        make_preview, DiffBudget, DiffSide, MAX_DIFF_BYTES, MAX_DIFF_WORK, MAX_RECORD_HUNK_CHARS,
    };
    use model::ReviewDiffLimit;
    let preview = if before.len() as u64 > MAX_DIFF_BYTES
        || after.is_some_and(|bytes| bytes.len() as u64 > MAX_DIFF_BYTES)
    {
        diff::ReviewPreview::limited(ReviewDiffLimit::FileTooLarge)
    } else {
        make_preview(
            DiffSide::Present(before.to_vec()),
            after.map_or(DiffSide::Present(Vec::new()), |bytes| {
                DiffSide::Present(bytes.to_vec())
            }),
            MAX_RECORD_HUNK_CHARS,
            &mut DiffBudget::new(MAX_DIFF_WORK),
        )
    };
    EditDiff {
        version: 1,
        path,
        root,
        operation: ReviewChangeOperation::Edit,
        status,
        additions: preview.additions,
        deletions: preview.deletions,
        hunks: preview.hunks,
        binary: preview.binary,
        truncated: preview.truncated,
        reason: preview.reason,
    }
}

#[cfg(test)]
mod tests;
