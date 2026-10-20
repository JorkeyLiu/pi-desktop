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
    FileRollbackOutcome, ReviewChange, ReviewChangeOperation, ReviewChangeState,
    ReviewChangeStatus, ReviewDiffHunk, ReviewDiffLimit, ReviewDiffLine, ReviewFileChange,
    ReviewFileRollbackMark, ReviewFilesOutcome, RollbackOutcome,
};
pub use session::{file_changes, remove_session, rollback_file, sweep};
#[allow(unused_imports)]
pub use snapshot::PendingChange;
pub use snapshot::{discard_change, finalize_change, prepare_change, rollback_change};

#[cfg(test)]
mod tests;
