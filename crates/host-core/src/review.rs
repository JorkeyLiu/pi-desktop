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
    EditDiffStatus, EditPreviewStatus, FileMutationOperation, FileMutationPreview,
    FileRollbackOutcome, ReviewChange, ReviewChangeOperation, ReviewChangeState,
    ReviewChangeStatus, ReviewDiffHunk, ReviewDiffLimit, ReviewDiffLine, ReviewFileChange,
    ReviewFileRollbackMark, ReviewFilesOutcome, RollbackOutcome, WritePreviewStatus,
};
pub use session::{file_changes, remove_session, rollback_file, sweep};
pub use snapshot::FileMutationEvidence;
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
/// as all lines removed, mirroring the durable record). The `status` takes
/// the edit-only vocabulary, so an `edit`/`added` preview cannot be built.
/// No filesystem read happens here, so nothing outside the already authorized
/// edit target is touched.
pub fn preview_edit_diff(
    path: String,
    root: String,
    status: EditPreviewStatus,
    before: &[u8],
    after: Option<&[u8]>,
) -> FileMutationPreview {
    use diff::{make_preview, DiffSide, PreviewLimits, MAX_DIFF_BYTES, MAX_RECORD_HUNK_CHARS};
    use model::ReviewDiffLimit;
    use std::time::Instant;
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
            &mut PreviewLimits::file(Instant::now()),
        )
    };
    assemble_preview(
        path,
        root,
        FileMutationOperation::Edit,
        status.into(),
        preview,
    )
}

/// Bounded in-memory preview of one `Write` call's actual bytes.
///
/// Like `preview_edit_diff` this writes no snapshot and confers no rollback:
/// workspace, scratch, and explicitly approved external writes get the same
/// per-call line evidence without entering the review aggregates. `before` is
/// the exact bytes the path held before the write: `Some(&[])` when the write
/// created the file (a creation reads as all lines added), and `None` when
/// the previous bytes could not be read, in which case the counts are omitted
/// rather than inferred as zero. The `status` takes the write-only
/// vocabulary, so a `write`/`deleted` or `write`/`moved` preview cannot be
/// built. No filesystem read happens here, so nothing outside the already
/// authorized write target is touched.
pub fn preview_write_diff(
    path: String,
    root: String,
    status: WritePreviewStatus,
    before: Option<&[u8]>,
    after: &[u8],
) -> FileMutationPreview {
    use diff::{make_preview, DiffSide, PreviewLimits, MAX_DIFF_BYTES, MAX_RECORD_HUNK_CHARS};
    use model::ReviewDiffLimit;
    use std::time::Instant;
    let preview = match before {
        None => diff::ReviewPreview::limited(ReviewDiffLimit::BaselineUnavailable),
        Some(before)
            if before.len() as u64 > MAX_DIFF_BYTES || after.len() as u64 > MAX_DIFF_BYTES =>
        {
            diff::ReviewPreview::limited(ReviewDiffLimit::FileTooLarge)
        }
        Some(before) => make_preview(
            DiffSide::Present(before.to_vec()),
            DiffSide::Present(after.to_vec()),
            MAX_RECORD_HUNK_CHARS,
            &mut PreviewLimits::file(Instant::now()),
        ),
    };
    assemble_preview(
        path,
        root,
        FileMutationOperation::Write,
        status.into(),
        preview,
    )
}

fn assemble_preview(
    path: String,
    root: String,
    operation: FileMutationOperation,
    status: EditDiffStatus,
    preview: diff::ReviewPreview,
) -> FileMutationPreview {
    FileMutationPreview {
        version: 1,
        path,
        root,
        operation,
        status,
        additions: preview.additions,
        deletions: preview.deletions,
        hunks: preview.hunks,
        binary: preview.binary,
        truncated: preview.truncated,
        reason: preview.reason,
    }
}

/// The hunk-char ceiling a durable record's preview is rendered under. A
/// tool's per-call evidence is only reusable while it was rendered under the
/// same ceiling.
pub(crate) fn record_hunk_char_budget() -> usize {
    diff::MAX_RECORD_HUNK_CHARS
}

/// The hash one review record keeps as its guard, so a tool's evidence and the
/// record's own read-once bytes agree without a second read.
pub(crate) fn content_hash(bytes: &[u8]) -> String {
    layout::hash_bytes(bytes)
}

#[cfg(test)]
mod nul_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod diff_bench;
