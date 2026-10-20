use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::workspace;

use super::model::SnapshotMeta;

pub(super) const REVIEW_DIR: &str = "review-changes";

pub(super) fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(super) fn session_review_dir(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    if !safe_component(session_id) {
        return Err(anyhow!("invalid session id"));
    }
    Ok(data_dir.join(REVIEW_DIR).join(session_id))
}

pub(super) fn snapshot_dir(
    data_dir: &Path,
    session_id: &str,
    snapshot_id: &str,
) -> Result<PathBuf> {
    if !safe_component(snapshot_id) {
        return Err(anyhow!("invalid snapshot id"));
    }
    Ok(session_review_dir(data_dir, session_id)?.join(snapshot_id))
}

pub(super) fn metadata_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

/// The canonical spelling of a workspace root, used as a record's root
/// identity and to compare a recorded root with the session's live roots.
pub(super) fn root_identity(root: &Path) -> Option<String> {
    if !root.is_absolute() {
        return None;
    }
    Some(
        canonical_or_lexical(root)
            .to_string_lossy()
            .replace('\\', "/"),
    )
}

pub(super) fn canonical_or_lexical(path: &Path) -> PathBuf {
    workspace::simple_canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(super) fn same_root(left: &Path, right: &str) -> bool {
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
pub(super) fn now_micros() -> i64 {
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
pub(super) struct SnapshotLocation {
    pub(super) root: Option<String>,
    pub(super) target: Option<PathBuf>,
}

pub(super) fn snapshot_location(roots: &SessionRoots, meta: &SnapshotMeta) -> SnapshotLocation {
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
pub(super) fn before_path(dir: &Path) -> PathBuf {
    dir.join("before")
}

pub(super) fn relative_path(root: &Path, path: &Path) -> String {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path.strip_prefix(&canonical_root)
        .or_else(|_| path.strip_prefix(root))
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(super) fn hash_file(path: &Path) -> Result<String> {
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

pub(super) fn write_meta(path: &Path, meta: &SnapshotMeta) -> Result<()> {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(meta)?)?;
    fs::rename(&temp, path)?;
    Ok(())
}

pub(super) fn read_meta(
    data_dir: &Path,
    session_id: &str,
    snapshot_id: &str,
) -> Result<SnapshotMeta> {
    let dir = snapshot_dir(data_dir, session_id, snapshot_id)?;
    let bytes = fs::read(metadata_path(&dir))
        .with_context(|| format!("review snapshot not found: {snapshot_id}"))?;
    let meta: SnapshotMeta = serde_json::from_slice(&bytes)?;
    if meta.session_id != session_id || meta.message_id.trim().is_empty() {
        return Err(anyhow!("review snapshot does not belong to this session"));
    }
    Ok(meta)
}
