//! Append-only Task snapshots, kept beside the immutable transcript.
//!
//! A `Task` row becomes durable while the delegated work is still running; the
//! runtime later re-snapshots it per child turn and once at settlement. Those
//! updates used to splice the original transcript line, which rewrote the
//! whole file and invalidated every physical coordinate derived from it.
//!
//! The sidecar records only the accepted overlays, in append order. The
//! transcript prefix stays byte-identical, and a reader applies the newest
//! accepted snapshot for the `(callId, delegationId)` pair it names.
//!
//! The sidecar is derived state, so it must never be the only copy of a
//! settled report. Any rewrite therefore folds the accepted overlay of every
//! `Task` row it keeps into the file it writes, and prunes that entry only
//! after the new transcript is durable. A line this build cannot interpret —
//! a torn tail, another session, or a newer `schema` — is copied back verbatim
//! instead of deleted, so a newer build still finds its data.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::layout::{file_identity, FileIdentity};
use super::MessageRecord;

/// Bumped when the sidecar line shape changes incompatibly.
pub const SNAPSHOT_SCHEMA: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotLine {
    schema: i64,
    session_id: String,
    saved_at: String,
    call_id: String,
    delegation_id: String,
    message: MessageRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    data_dir: PathBuf,
    session_id: String,
}

#[derive(Debug, Clone, Default)]
struct SnapshotCache {
    identity: FileIdentity,
    file_len: u64,
    /// `(callId, delegationId)` -> newest accepted Task record.
    by_key: HashMap<String, MessageRecord>,
}

static SNAPSHOT_CACHE: OnceLock<Mutex<HashMap<CacheKey, SnapshotCache>>> = OnceLock::new();

fn snapshot_cache() -> &'static Mutex<HashMap<CacheKey, SnapshotCache>> {
    SNAPSHOT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(data_dir: &Path, session_id: &str) -> CacheKey {
    CacheKey {
        data_dir: data_dir.to_path_buf(),
        session_id: session_id.to_string(),
    }
}

fn snapshot_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    super::path_for(data_dir, session_id, ".snapshots.jsonl")
}

fn index_key(call_id: &str, delegation_id: &str) -> String {
    format!("{call_id}\u{0}{delegation_id}")
}

/// The Task call identity a record speaks for. Non-Task rows and Task rows
/// without both identities are not snapshot subjects.
fn task_identity(record: &MessageRecord) -> Option<(String, String)> {
    if record.role != "tool" || record.tool_name.as_deref() != Some("Task") {
        return None;
    }
    let block = record
        .blocks
        .as_array()?
        .iter()
        .find(|block| block["type"] == "tool_call")?;
    let call_id = block["callId"].as_str().filter(|id| !id.is_empty())?;
    let delegation_id = block["result"]["details"]["delegationId"]
        .as_str()
        .filter(|id| !id.is_empty())?;
    Some((call_id.to_string(), delegation_id.to_string()))
}

fn record_key(record: &MessageRecord) -> Option<String> {
    task_identity(record).map(|(call_id, delegation_id)| index_key(&call_id, &delegation_id))
}

fn task_block(record: &MessageRecord) -> Option<&Value> {
    record
        .blocks
        .as_array()?
        .iter()
        .find(|block| block["type"] == "tool_call")
}

fn record_status(record: &MessageRecord) -> Option<&str> {
    task_block(record)?
        .get("result")?
        .get("details")?
        .get("status")?
        .as_str()
}

/// Generation of an installed handoff checkpoint, when the value records one.
/// Absent, malformed, or non-object values are "no checkpoint".
fn checkpoint_generation(checkpoint: &Value) -> Option<i64> {
    if !checkpoint.is_object() {
        return None;
    }
    checkpoint["generation"]
        .as_i64()
        .filter(|generation| *generation >= 1)
}

fn snapshot_equivalent(left: &MessageRecord, right: &MessageRecord) -> bool {
    left.id == right.id
        && left.role == right.role
        && left.tool_name == right.tool_name
        && left.is_error == right.is_error
        && left.blocks == right.blocks
        && left.meta == right.meta
}

/// Read the sidecar's complete-line tail into the shared cache, then run `f`
/// with the up-to-date cache. Only appended lines are parsed; a torn tail is
/// left for the next call.
fn with_cache<R>(
    data_dir: &Path,
    session_id: &str,
    f: impl FnOnce(&SnapshotCache) -> R,
) -> Result<R> {
    let path = snapshot_path(data_dir, session_id)?;
    let mut guard = snapshot_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let key = cache_key(data_dir, session_id);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    let Some(metadata) = metadata else {
        guard.remove(&key);
        return Ok(f(&SnapshotCache::default()));
    };
    let identity = file_identity(&path, &metadata);
    let entry = guard.entry(key).or_default();
    if entry.identity != identity || entry.file_len > metadata.len() || !identity.is_available() {
        *entry = SnapshotCache {
            identity: identity.clone(),
            ..SnapshotCache::default()
        };
    }
    let mut by_key = std::mem::take(&mut entry.by_key);
    let mut file_len = entry.file_len;
    if file_len < metadata.len() {
        let file = File::open(&path)?;
        let mut reader = BufReader::new(file);
        if file_len > 0 {
            reader
                .seek(SeekFrom::Start(file_len))
                .with_context(|| format!("seek {}", path.display()))?;
        }
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader.read_line(&mut line)?;
            if read == 0 {
                break;
            }
            // A torn tail is not a line yet, and a line this build cannot
            // interpret (another session, a newer `schema`, a partial write) is
            // not an overlay it may apply: it is skipped here and preserved by
            // [`rewrite_sidecar`], so a newer build still finds it.
            if !line.ends_with('\n') {
                break;
            }
            file_len += read as u64;
            if let Ok(record) = serde_json::from_str::<SnapshotLine>(line.trim()) {
                if record.schema == SNAPSHOT_SCHEMA && record.session_id == session_id {
                    by_key.insert(
                        index_key(&record.call_id, &record.delegation_id),
                        record.message,
                    );
                }
            }
        }
    }
    entry.by_key = by_key;
    entry.file_len = file_len;
    entry.identity = identity;
    Ok(f(&*entry))
}

/// Replace records with the newest accepted Task snapshot for their call.
pub(crate) fn overlay(
    data_dir: &Path,
    session_id: &str,
    records: &mut [MessageRecord],
) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }
    with_cache(data_dir, session_id, |cache| {
        for record in records {
            // A settled base row means some writer already replaced the launch
            // line in place (an older build splices Task updates). That row is
            // newer evidence than a sidecar written before it, so a stale
            // snapshot must not reopen the delegation.
            if record_status(record) != Some("running") {
                continue;
            }
            if let Some(key) = record_key(record) {
                if let Some(snapshot) = cache.by_key.get(&key) {
                    *record = snapshot.clone();
                }
            }
        }
    })
}

/// Overlays a transcript rewrite must fold into the rows it is about to write.
#[derive(Debug, Default)]
pub(crate) struct RewriteOverlays {
    /// Index in the caller's record slice -> the accepted effective row.
    pub(crate) replacements: HashMap<usize, MessageRecord>,
    /// Keys whose original launch row is no longer in the transcript, so the
    /// rewrite alone cannot decide them and the entry has to be kept.
    pub(crate) retain: HashSet<String>,
}

/// The original Task rows still in the transcript a rewrite is about to
/// replace, keyed by `(callId, delegationId)`, latest physical row last.
fn launch_rows(data_dir: &Path, session_id: &str) -> Result<HashMap<String, MessageRecord>> {
    let mut rows = HashMap::new();
    super::layout::with_layout_recovery(data_dir, session_id, |layout| {
        let indices: Vec<usize> = layout
            .task_calls()
            .iter()
            .map(|task| task.message_index)
            .collect();
        if indices.is_empty() {
            return Ok(());
        }
        let read = super::read_transcript_indices_with_layout(
            data_dir,
            session_id,
            layout,
            &indices,
            &[],
        )?;
        for record in read.messages {
            if let Some(key) = record_key(&record) {
                rows.insert(key, record);
            }
        }
        Ok(())
    })?;
    Ok(rows)
}

/// Decide which accepted snapshots a rewrite has to carry into its rows.
///
/// `records` is the exact set about to become the transcript, and the decision
/// is made against the original launch row in the transcript being replaced. A
/// row is replaced only when it is still that launch row, byte for byte on its
/// identity and launch content. A row already holding the accepted content
/// needs nothing, and a row matching neither was intentionally edited: the
/// caller's content is the authority, and the overlay is dropped with this
/// rewrite instead of resurrecting over the edit.
///
/// `Ok(None)` means the session has no sidecar, so nothing is folded and
/// nothing is pruned.
pub(crate) fn plan_rewrite(
    data_dir: &Path,
    session_id: &str,
    records: &[MessageRecord],
) -> Result<Option<RewriteOverlays>> {
    let path = snapshot_path(data_dir, session_id)?;
    match fs::metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    }
    let launch = launch_rows(data_dir, session_id)?;
    let mut plan = RewriteOverlays::default();
    with_cache(data_dir, session_id, |cache| {
        // An entry is retired only when this rewrite decides it: the row it
        // names is in the new record set. A row the rewrite drops (a truncated
        // branch, a revision switch to another family) leaves its entry alone,
        // because a revision copy can bring that same `Task` call back and its
        // accepted settlement is still the truth for that call.
        plan.retain = cache.by_key.keys().cloned().collect();
        for (index, record) in records.iter().enumerate() {
            let Some(key) = record_key(record) else {
                continue;
            };
            let Some(snapshot) = cache.by_key.get(&key) else {
                continue;
            };
            plan.retain.remove(&key);
            if snapshot_equivalent(record, snapshot) {
                // The caller already holds the accepted row.
                continue;
            }
            match launch.get(&key) {
                // Still the original launch row, so the accepted overlay is the
                // effective content of this row and has to travel with it.
                Some(original) if snapshot_equivalent(record, original) => {
                    plan.replacements.insert(index, snapshot.clone());
                }
                // An explicit edit of this row: keep it, and the entry stops
                // describing anything the transcript still holds.
                Some(_) => {}
                // No launch row to compare against: this rewrite cannot judge
                // the entry, so it keeps it for a later read.
                None => {
                    plan.retain.insert(key);
                }
            }
        }
    })?;
    Ok(Some(plan))
}

/// Rewrite the sidecar through `keep` for every line this build interprets.
///
/// Everything else — a torn tail, a foreign session, or an `schema` newer than
/// [`SNAPSHOT_SCHEMA`] — is copied back verbatim. Those lines are data for a
/// newer build to recover and this build cannot judge them, so a cleanup path
/// must not delete them.
fn rewrite_sidecar(
    data_dir: &Path,
    session_id: &str,
    keep: impl Fn(&SnapshotLine) -> bool,
) -> Result<()> {
    let path = snapshot_path(data_dir, session_id)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            clear_cache(data_dir, session_id);
            return Ok(());
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let mut kept = String::with_capacity(raw.len());
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let retained = match serde_json::from_str::<SnapshotLine>(line) {
            Ok(record) if record.schema == SNAPSHOT_SCHEMA && record.session_id == session_id => {
                keep(&record)
            }
            _ => true,
        };
        if retained {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    if kept.is_empty() {
        return discard(data_dir, session_id);
    }
    let rewritten = kept != raw.trim_end();
    if rewritten {
        let tmp = path.with_extension("snapshots.tmp");
        {
            let mut writer = std::io::BufWriter::new(File::create(&tmp)?);
            writer.write_all(kept.as_bytes())?;
            writer.flush()?;
            writer.get_ref().sync_data()?;
        }
        super::swap_into_place(&tmp, &path)?;
    }
    clear_cache(data_dir, session_id);
    Ok(())
}

/// Drop the sidecar entries a completed rewrite folded in or invalidated.
///
/// Runs only after the rewritten transcript is durable: the authoritative rows
/// are already in the file, so this is cleanup and never the place the content
/// depends on. Failure here is a warning at the call site, not a lost rewrite.
pub(crate) fn prune_after_rewrite(
    data_dir: &Path,
    session_id: &str,
    retain: &HashSet<String>,
) -> Result<()> {
    rewrite_sidecar(data_dir, session_id, |record| {
        retain.contains(&index_key(&record.call_id, &record.delegation_id))
    })
}

/// Drop the entry for one Task row an explicit single-line write replaced.
///
/// `update_message` writes exactly the row the caller handed in, so that row is
/// the new authority for its call and a later overlay must not cover it.
pub(crate) fn forget(data_dir: &Path, session_id: &str, record: &MessageRecord) -> Result<()> {
    let Some((call_id, delegation_id)) = task_identity(record) else {
        return Ok(());
    };
    rewrite_sidecar(data_dir, session_id, |line| {
        !(line.call_id == call_id && line.delegation_id == delegation_id)
    })
}

/// Whether this incoming Task snapshot may overlay `existing`. Mirrors the
/// runtime's ordering contract: same row, same call and delegation, base row
/// still running, and an installed handoff checkpoint never goes backwards.
pub(crate) fn accept(
    data_dir: &Path,
    session_id: &str,
    existing: &MessageRecord,
    incoming: &MessageRecord,
    saved_at: &str,
) -> Result<()> {
    if existing.id != incoming.id {
        return Ok(());
    }
    let Some((call_id, delegation_id)) = task_identity(incoming) else {
        return Ok(());
    };
    if task_identity(existing) != Some((call_id.clone(), delegation_id.clone())) {
        return Ok(());
    }
    if !matches!(
        record_status(incoming),
        Some("running" | "completed" | "stopped" | "aborted" | "failed" | "timed_out")
    ) {
        return Ok(());
    }
    // A late progress snapshot must not reopen a settled delegation.
    if record_status(existing) != Some("running") {
        return Ok(());
    }
    let stored_checkpoint = task_block(existing)
        .map(|block| block["result"]["details"]["handoffCheckpoint"].clone())
        .unwrap_or(Value::Null);
    let stored_generation = checkpoint_generation(&stored_checkpoint);
    let incoming_checkpoint = task_block(incoming)
        .map(|block| block["result"]["details"]["handoffCheckpoint"].clone())
        .unwrap_or(Value::Null);
    let incoming_generation = checkpoint_generation(&incoming_checkpoint);
    let keep_stored = match stored_generation {
        Some(stored) => !matches!(incoming_generation, Some(incoming) if incoming > stored),
        None => false,
    };
    let Some(next) = task_block(incoming) else {
        return Ok(());
    };
    // The accepted snapshot carries the runtime context and the tool text; the
    // launch row keeps everything else (args in particular are the authority of
    // the row that started the delegation).
    let mut candidate = existing.clone();
    let Some(block) = candidate
        .blocks
        .as_array_mut()
        .and_then(|blocks| blocks.iter_mut().find(|block| block["type"] == "tool_call"))
    else {
        return Ok(());
    };
    let mut result = next["result"].clone();
    if keep_stored {
        result["details"]["handoffCheckpoint"] = stored_checkpoint;
    }
    block["result"] = result;
    block["text"] = next["text"].clone();
    if snapshot_equivalent(&candidate, existing) {
        return Ok(());
    }
    let line = super::tagged(
        "snapshot",
        &SnapshotLine {
            schema: SNAPSHOT_SCHEMA,
            session_id: session_id.to_string(),
            saved_at: saved_at.to_string(),
            call_id,
            delegation_id,
            message: candidate,
        },
    )?;
    super::append_line(&snapshot_path(data_dir, session_id)?, None, line)
        .with_context(|| "append delegation snapshot")?;
    // Fold this append into the cache so the next read parses only its line.
    with_cache(data_dir, session_id, |_| ())?;
    Ok(())
}

/// Remove every snapshot line and the cache for this session.
///
/// Only callers that take the whole sidecar with it use this: session deletion,
/// and [`rewrite_sidecar`] once nothing is left to keep. A transcript rewrite
/// does not — it folds the effective content into the rows first, then prunes
/// per entry (see [`plan_rewrite`] / [`prune_after_rewrite`]), because a
/// snapshot may be the only copy of a settled report.
pub(crate) fn discard(data_dir: &Path, session_id: &str) -> Result<()> {
    clear_cache(data_dir, session_id);
    let path = snapshot_path(data_dir, session_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
}

fn clear_cache(data_dir: &Path, session_id: &str) {
    if let Ok(mut guard) = snapshot_cache().lock() {
        guard.remove(&cache_key(data_dir, session_id));
    }
}

#[cfg(test)]
pub(crate) fn reset_cache_for_tests() {
    if let Ok(mut guard) = snapshot_cache().lock() {
        guard.clear();
    }
}

#[cfg(test)]
fn snapshot_file_len(data_dir: &Path, session_id: &str) -> u64 {
    fs::metadata(snapshot_path(data_dir, session_id).unwrap())
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

#[cfg(test)]
fn snapshot_line_count(data_dir: &Path, session_id: &str) -> usize {
    fs::read_to_string(snapshot_path(data_dir, session_id).unwrap())
        .map(|raw| raw.lines().count())
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "../transcripts_snapshots_tests.rs"]
mod tests;
