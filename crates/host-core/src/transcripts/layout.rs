//! The derived physical index for a session transcript.
//!
//! Layout offsets are disposable. They are reused only while the transcript's
//! file identity still matches, and every cache failure falls back to a scan.
//!
//! The layout also carries the facts a scoped history read needs without
//! decoding message bodies: which physical row owns which Task call, and the
//! Task calls themselves with their delegation identity and resume argument.
//! Those facts are rebuilt by the same append-only scan that produces offsets.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use anyhow::{Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{sniff_line_kind, swap_into_place, transcript_path};

const LAYOUT_CACHE_MIN_LEN: u64 = 2 * 1024 * 1024;
const LAYOUT_CACHE_MAX_LAG: u64 = 4 * 1024 * 1024;
const LAYOUT_CACHE_MAGIC: &str = "PI-DESKTOP-TRANSCRIPT-LAYOUT";
const LAYOUT_CACHE_VERSION: &str = "3";
/// Ownership token for a message whose `parentToolCallId` is absent.
const TOP_LEVEL_OWNERSHIP: u32 = u32::MAX;

/// A stable identity available on filesystems that expose one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum FileIdentity {
    Available {
        platform: &'static str,
        volume_id: u64,
        file_id: [u8; 16],
    },
    #[default]
    Unavailable,
}

impl FileIdentity {
    pub(crate) fn is_available(&self) -> bool {
        matches!(self, Self::Available { .. })
    }

    fn write_tokens(&self, writer: &mut impl Write) -> std::io::Result<()> {
        match self {
            Self::Available {
                platform,
                volume_id,
                file_id,
            } => writeln!(writer, "{platform} {volume_id:x} {}", hex::encode(file_id)),
            Self::Unavailable => Err(std::io::Error::other("file identity is unavailable")),
        }
    }

    fn from_tokens(platform: &str, volume_id: &str, file_id: &str) -> Option<Self> {
        let expected_platform = if cfg!(unix) {
            "unix"
        } else if cfg!(windows) {
            "windows"
        } else {
            return None;
        };
        if platform != expected_platform {
            return None;
        }
        let volume_id = u64::from_str_radix(volume_id, 16).ok()?;
        let bytes = hex::decode(file_id).ok()?;
        let file_id: [u8; 16] = bytes.try_into().ok()?;
        Some(Self::Available {
            platform: expected_platform,
            volume_id,
            file_id,
        })
    }
}

/// One Task tool row in physical order, with the identities a scoped read
/// needs. `resume` is the raw `args.resume` value, not a resolved call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskCallIndex {
    pub(crate) message_index: usize,
    pub(crate) call_id: String,
    pub(crate) delegation_id: Option<String>,
    pub(crate) resume: Option<String>,
}

/// Physical layout of one transcript file: the byte offset of every message
/// and compaction line, plus the file prefix those offsets describe.
#[derive(Debug, Default, Clone)]
pub struct TranscriptLayout {
    /// Byte offset of each message line, in file order.
    pub message_offsets: Vec<u64>,
    /// Byte offset of each compaction line, in file order.
    pub compaction_offsets: Vec<u64>,
    /// Byte length of the file prefix this layout describes.
    pub file_len: u64,
    pub(crate) identity: FileIdentity,
    /// For each message line, the pool index of its `meta.parentToolCallId`.
    /// `None` is a top-level row.
    pub(crate) message_parent: Vec<Option<u32>>,
    /// Deduplicated parent tool-call ids referenced by `message_parent`.
    pub(crate) parent_call_ids: Vec<String>,
    /// Every Task tool row, in physical order.
    pub(crate) task_calls: Vec<TaskCallIndex>,
    /// Physical indexes of top-level messages, in file order.
    pub(crate) top_level: Vec<usize>,
}

impl TranscriptLayout {
    /// Physical message-line count. Window offsets use this coordinate space,
    /// not the deduplicated message positions.
    pub fn message_count(&self) -> usize {
        self.message_offsets.len()
    }

    fn empty(identity: FileIdentity) -> Self {
        Self {
            identity,
            ..Self::default()
        }
    }

    /// Owning Task call for a physical row, if the row is nested.
    pub(crate) fn parent_call_id(&self, index: usize) -> Option<&str> {
        self.message_parent
            .get(index)
            .copied()
            .flatten()
            .and_then(|pool| self.parent_call_ids.get(pool as usize))
            .map(String::as_str)
    }

    /// Physical indexes of messages that no Task call owns.
    pub(crate) fn top_level_indices(&self) -> &[usize] {
        &self.top_level
    }

    pub(crate) fn task_calls(&self) -> &[TaskCallIndex] {
        &self.task_calls
    }

    /// Last physical Task row for `call_id`; duplicates are retries of one call.
    pub(crate) fn last_task_for_call(&self, call_id: &str) -> Option<&TaskCallIndex> {
        self.task_calls
            .iter()
            .rev()
            .find(|task| task.call_id == call_id)
    }

    pub(crate) fn rebuild_top_level(&mut self) {
        self.top_level = self
            .message_parent
            .iter()
            .enumerate()
            .filter_map(|(index, parent)| parent.is_none().then_some(index))
            .collect();
    }

    fn extend_parent_call_id(&mut self, call_id: Option<&str>) -> Option<u32> {
        let call_id = call_id?;
        if let Some(index) = self
            .parent_call_ids
            .iter()
            .position(|existing| existing == call_id)
        {
            return Some(index as u32);
        }
        let index = u32::try_from(self.parent_call_ids.len()).ok()?;
        self.parent_call_ids.push(call_id.to_string());
        Some(index)
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct LayoutKey {
    data_dir: PathBuf,
    session_id: String,
}

static TRANSCRIPT_LAYOUTS: OnceLock<Mutex<HashMap<LayoutKey, TranscriptLayout>>> = OnceLock::new();

fn layout_cache() -> &'static Mutex<HashMap<LayoutKey, TranscriptLayout>> {
    TRANSCRIPT_LAYOUTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn layout_key(data_dir: &Path, session_id: &str) -> LayoutKey {
    LayoutKey {
        data_dir: data_dir.to_path_buf(),
        session_id: session_id.to_string(),
    }
}

fn layout_cache_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    Ok(transcript_path(data_dir, session_id)?.with_extension("jsonl.layout"))
}

/// Return an up-to-date layout, reusing the process cache or a validated disk
/// cache and scanning only the appended tail.
pub(crate) fn session_layout(data_dir: &Path, session_id: &str) -> Result<TranscriptLayout> {
    let key = layout_key(data_dir, session_id);
    let cached = layout_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&key).cloned())
        .unwrap_or_default();
    let layout = refresh_layout(data_dir, session_id, cached)?;
    if let Ok(mut guard) = layout_cache().lock() {
        guard.insert(key, layout.clone());
    }
    Ok(layout)
}

/// Remove both derived cache layers after a rewrite or session deletion.
/// Cleanup failure is diagnostic only; file identity still prevents the stale
/// disk cache from being trusted on the next read.
pub(crate) fn invalidate(data_dir: &Path, session_id: &str) {
    if let Ok(mut guard) = layout_cache().lock() {
        guard.remove(&layout_key(data_dir, session_id));
    }
    let mut paths = Vec::new();
    if let Ok(cache) = layout_cache_path(data_dir, session_id) {
        paths.push(cache.with_extension("layout.tmp"));
        paths.push(cache);
    }
    for path in paths {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, "failed to invalidate transcript layout cache");
            }
        }
    }
}

/// A boundary failure means an indexed offset does not point at the expected
/// JSONL line. It is distinct from transcript I/O or decoding failures so the
/// common read path can rebuild once and retry.
#[derive(Debug, thiserror::Error)]
#[error("transcript layout boundary is invalid")]
pub(crate) struct InvalidLayoutBoundary;

pub(crate) fn invalid_boundary() -> anyhow::Error {
    InvalidLayoutBoundary.into()
}

/// Rebuild once after an indexed read detects a stale/corrupt boundary. The
/// retry always bypasses the disk cache and callers recompute their selection
/// from the rebuilt message count.
pub(crate) fn with_layout_recovery<T>(
    data_dir: &Path,
    session_id: &str,
    mut operation: impl FnMut(&TranscriptLayout) -> Result<T>,
) -> Result<T> {
    let first = session_layout(data_dir, session_id)?;
    match operation(&first) {
        Ok(value) => Ok(value),
        Err(error) if error.is::<InvalidLayoutBoundary>() => {
            invalidate(data_dir, session_id);
            let rebuilt = scan_current_file(data_dir, session_id)?;
            cache_rebuilt_layout(data_dir, session_id, &rebuilt);
            match operation(&rebuilt) {
                Err(error) if error.is::<InvalidLayoutBoundary>() => {
                    Err(error.context("transcript layout remained invalid after one full rebuild"))
                }
                result => result,
            }
        }
        Err(error) => Err(error),
    }
}

fn cache_rebuilt_layout(data_dir: &Path, session_id: &str, layout: &TranscriptLayout) {
    if let Ok(mut guard) = layout_cache().lock() {
        guard.insert(layout_key(data_dir, session_id), layout.clone());
    }
    if let Err(error) = store_layout_cache(data_dir, session_id, layout) {
        tracing::warn!(%error, "failed to persist rebuilt transcript layout cache");
    }
}

/// Refresh the supplied layout only after validating its file identity.
pub fn refresh_layout(
    data_dir: &Path,
    session_id: &str,
    base: TranscriptLayout,
) -> Result<TranscriptLayout> {
    let path = transcript_path(data_dir, session_id)?;
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    refresh_with_identity(
        data_dir,
        session_id,
        base,
        metadata.len(),
        file_identity(&path, &metadata),
    )
}

fn refresh_with_identity(
    data_dir: &Path,
    session_id: &str,
    base: TranscriptLayout,
    length: u64,
    identity: FileIdentity,
) -> Result<TranscriptLayout> {
    let path = transcript_path(data_dir, session_id)?;
    let mut base =
        if identity.is_available() && base.identity == identity && base.file_len <= length {
            base
        } else {
            TranscriptLayout::empty(identity.clone())
        };

    if !identity.is_available() {
        // Without a reliable identity, no existing offsets can be trusted.
        base = TranscriptLayout::empty(identity);
    } else if base.file_len == 0 {
        base = load_layout_cache(data_dir, session_id, &identity, length)?
            .unwrap_or_else(|| TranscriptLayout::empty(identity.clone()));
    }

    if length == base.file_len {
        return Ok(base);
    }
    let base_len = base.file_len;
    let layout = scan_layout(&path, base)?;
    if base_len == 0 || layout.file_len.saturating_sub(base_len) >= LAYOUT_CACHE_MAX_LAG {
        if let Err(error) = store_layout_cache(data_dir, session_id, &layout) {
            tracing::warn!(%error, "failed to persist transcript layout cache");
        }
    }
    Ok(layout)
}

fn scan_current_file(data_dir: &Path, session_id: &str) -> Result<TranscriptLayout> {
    let path = transcript_path(data_dir, session_id)?;
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    let identity = file_identity(&path, &metadata);
    scan_layout(&path, TranscriptLayout::empty(identity))
}

/// What the append scan needs from one message line. Parent identity is found
/// with a bounded byte scan; only Task rows are decoded.
struct MessageProbe {
    parent_call_id: Option<String>,
    task: Option<ProbedTask>,
}

struct ProbedTask {
    call_id: Option<String>,
    delegation_id: Option<String>,
    resume: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskLineProbe {
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    blocks: Vec<TaskBlockProbe>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskBlockProbe {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    call_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    args: Option<Value>,
    #[serde(default)]
    result: Option<Value>,
}

/// Read the JSON string value that follows `marker` (`"role":` etc.) without
/// decoding the rest of the line.
fn probe_string(line: &str, marker: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut index = line.find(marker)? + marker.len();
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() || bytes[index] != b'"' {
        return None;
    }
    let (_, next) = super::scan_json_string(bytes, index)?;
    serde_json::from_slice::<String>(&bytes[index..next]).ok()
}

fn probe_message(line: &str) -> MessageProbe {
    let parent_call_id = probe_string(line, "\"parentToolCallId\":");
    let task = line
        .contains("\"toolName\":\"Task\"")
        .then(|| {
            serde_json::from_str::<TaskLineProbe>(line)
                .ok()
                .and_then(|probe| {
                    if probe.tool_name.as_deref() != Some("Task") {
                        return None;
                    }
                    let block = probe
                        .blocks
                        .iter()
                        .find(|block| block.kind.as_deref() == Some("tool_call"))?;
                    if block.name.as_deref() != Some("Task") {
                        return None;
                    }
                    Some(ProbedTask {
                        call_id: block.call_id.clone().filter(|id| !id.is_empty()),
                        delegation_id: block
                            .result
                            .as_ref()
                            .and_then(|result| result.get("details"))
                            .and_then(|details| details.get("delegationId"))
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                            .map(str::to_owned),
                        resume: block
                            .args
                            .as_ref()
                            .and_then(|args| args.get("resume"))
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                            .map(str::to_owned),
                    })
                })
        })
        .flatten();
    MessageProbe {
        parent_call_id,
        task,
    }
}

/// Scan from the known complete-line prefix to EOF, extending the offsets and
/// the ownership / Task index.
fn scan_layout(path: &Path, mut layout: TranscriptLayout) -> Result<TranscriptLayout> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let mut offset = layout.file_len;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))
            .with_context(|| format!("seek {}", path.display()))?;
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        // A torn append is excluded until its newline arrives.
        if !line.ends_with('\n') {
            break;
        }
        let trimmed = line.trim_end();
        match sniff_line_kind(trimmed) {
            Some("message") => {
                let message_index = layout.message_offsets.len();
                let probe = probe_message(trimmed);
                let ownership = layout.extend_parent_call_id(probe.parent_call_id.as_deref());
                layout.message_offsets.push(offset);
                layout.message_parent.push(ownership);
                if let Some(task) = probe.task {
                    if let Some(call_id) = task.call_id {
                        layout.task_calls.push(TaskCallIndex {
                            message_index,
                            call_id,
                            delegation_id: task.delegation_id,
                            resume: task.resume,
                        });
                    }
                }
                if ownership.is_none() {
                    layout.top_level.push(message_index);
                }
            }
            Some("compaction") => layout.compaction_offsets.push(offset),
            _ => {}
        }
        offset += read as u64;
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        }
    }
    layout.file_len = offset;
    layout.rebuild_top_level();
    Ok(layout)
}

macro_rules! cache_next {
    ($lines:expr) => {
        match $lines.next() {
            Some(line) => line,
            None => return Ok(None),
        }
    };
}

fn load_layout_cache(
    data_dir: &Path,
    session_id: &str,
    identity: &FileIdentity,
    current_len: u64,
) -> Result<Option<TranscriptLayout>> {
    if current_len < LAYOUT_CACHE_MIN_LEN {
        return Ok(None);
    }
    let cache_path = layout_cache_path(data_dir, session_id)?;
    let raw = match fs::read_to_string(&cache_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            tracing::warn!(%error, "failed to read transcript layout cache");
            return Ok(None);
        }
    };
    let mut lines = raw.lines();
    let mut tokens = lines.next().unwrap_or_default().split_ascii_whitespace();
    if tokens.next() != Some(LAYOUT_CACHE_MAGIC) || tokens.next() != Some(LAYOUT_CACHE_VERSION) {
        return Ok(None);
    }
    let (Some(platform), Some(volume), Some(file_id)) =
        (tokens.next(), tokens.next(), tokens.next())
    else {
        return Ok(None);
    };
    let Some(cached_identity) = FileIdentity::from_tokens(platform, volume, file_id) else {
        return Ok(None);
    };
    if &cached_identity != identity {
        return Ok(None);
    }
    let Some(file_len) = cache_next!(lines).trim().parse::<u64>().ok() else {
        return Ok(None);
    };
    if file_len < LAYOUT_CACHE_MIN_LEN || file_len > current_len {
        return Ok(None);
    }
    let mut counts = cache_next!(lines).split_ascii_whitespace();
    let (Some(message_count), Some(compaction_count)) = (
        counts.next().and_then(|token| token.parse::<usize>().ok()),
        counts.next().and_then(|token| token.parse::<usize>().ok()),
    ) else {
        return Ok(None);
    };
    let Some(offset_count) = message_count.checked_add(compaction_count) else {
        return Ok(None);
    };
    let Ok(file_len_usize) = usize::try_from(file_len) else {
        return Ok(None);
    };
    // A classified JSONL record needs at least `{"type":"message"}\n`;
    // reject impossible counts before reserving memory from cache input.
    if offset_count > file_len_usize / 19 {
        return Ok(None);
    }
    let mut offsets = Vec::with_capacity(offset_count);
    while offsets.len() < offset_count {
        for token in cache_next!(lines).split_ascii_whitespace() {
            let Some(offset) = token.parse::<u64>().ok() else {
                return Ok(None);
            };
            offsets.push(offset);
        }
        if offsets.len() > offset_count {
            return Ok(None);
        }
    }
    let mut ownership_head = cache_next!(lines).split_ascii_whitespace();
    if ownership_head.next() != Some("ownership") {
        return Ok(None);
    }
    let Some(declared_ownership) = ownership_head.next().and_then(|n| n.parse::<usize>().ok())
    else {
        return Ok(None);
    };
    if declared_ownership != message_count {
        return Ok(None);
    }
    let mut ownership_tokens = Vec::with_capacity(message_count);
    while ownership_tokens.len() < message_count {
        for token in cache_next!(lines).split_ascii_whitespace() {
            let Some(ownership) = token.parse::<u32>().ok() else {
                return Ok(None);
            };
            ownership_tokens.push(ownership);
        }
        if ownership_tokens.len() > message_count {
            return Ok(None);
        }
    }
    let mut pool_head = cache_next!(lines).split_ascii_whitespace();
    if pool_head.next() != Some("pool") {
        return Ok(None);
    }
    let Some(pool_count) = pool_head.next().and_then(|n| n.parse::<usize>().ok()) else {
        return Ok(None);
    };
    if pool_count > message_count {
        return Ok(None);
    }
    let mut parent_call_ids = Vec::with_capacity(pool_count);
    for _ in 0..pool_count {
        let Some(bytes) = hex::decode(cache_next!(lines).trim()).ok() else {
            return Ok(None);
        };
        let Some(call_id) = String::from_utf8(bytes).ok() else {
            return Ok(None);
        };
        parent_call_ids.push(call_id);
    }
    let mut tasks_head = cache_next!(lines).split_ascii_whitespace();
    if tasks_head.next() != Some("tasks") {
        return Ok(None);
    }
    let Some(task_count) = tasks_head.next().and_then(|n| n.parse::<usize>().ok()) else {
        return Ok(None);
    };
    if task_count > message_count {
        return Ok(None);
    }
    let mut task_calls = Vec::with_capacity(task_count);
    for _ in 0..task_count {
        let Some(value) = serde_json::from_str::<Value>(cache_next!(lines)).ok() else {
            return Ok(None);
        };
        let Some(message_index) = value
            .get("messageIndex")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
        else {
            return Ok(None);
        };
        let Some(call_id) = value.get("callId").and_then(Value::as_str) else {
            return Ok(None);
        };
        if message_index >= message_count || call_id.is_empty() {
            return Ok(None);
        }
        task_calls.push(TaskCallIndex {
            message_index,
            call_id: call_id.to_string(),
            delegation_id: value
                .get("delegationId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            resume: value
                .get("resume")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
    let mut checksum = cache_next!(lines).split_ascii_whitespace();
    if checksum.next() != Some("checksum") {
        return Ok(None);
    }
    let Some(checksum) = checksum.next() else {
        return Ok(None);
    };
    if lines.next().is_some() {
        return Ok(None);
    }
    let mut message_offsets = Vec::with_capacity(message_count);
    let mut compaction_offsets = Vec::with_capacity(compaction_count);
    for (index, offset) in offsets.into_iter().enumerate() {
        if index < message_count {
            message_offsets.push(offset);
        } else {
            compaction_offsets.push(offset);
        }
    }
    let message_parent = ownership_tokens
        .into_iter()
        .map(|token| (token != TOP_LEVEL_OWNERSHIP).then_some(token))
        .collect();
    let mut layout = TranscriptLayout {
        message_offsets,
        compaction_offsets,
        file_len,
        identity: cached_identity,
        message_parent,
        parent_call_ids,
        task_calls,
        top_level: Vec::new(),
    };
    if layout
        .message_parent
        .iter()
        .flatten()
        .any(|index| *index as usize >= layout.parent_call_ids.len())
    {
        return Ok(None);
    }
    let transcript = transcript_path(data_dir, session_id)?;
    if checksum != layout_cache_digest(&layout)
        || !offsets_are_valid(&layout)
        || !prefix_ends_on_line_boundary(&transcript, file_len)?
        || !offsets_look_like_scan(&transcript, &layout)?
    {
        return Ok(None);
    }
    layout.rebuild_top_level();
    Ok(Some(layout))
}

fn offsets_are_valid(layout: &TranscriptLayout) -> bool {
    if layout
        .message_offsets
        .windows(2)
        .any(|pair| pair[0] >= pair[1])
        || layout
            .compaction_offsets
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || layout.message_parent.len() != layout.message_offsets.len()
    {
        return false;
    }
    let mut messages = layout.message_offsets.iter().copied().peekable();
    let mut compactions = layout.compaction_offsets.iter().copied().peekable();
    let mut previous = None;
    loop {
        let next_message = messages.peek().copied();
        let next_compaction = compactions.peek().copied();
        let next = match (next_message, next_compaction) {
            (None, None) => break,
            (Some(message), Some(compaction)) if message == compaction => return false,
            (Some(message), Some(compaction)) if message < compaction => {
                messages.next();
                message
            }
            (Some(_), Some(compaction)) => {
                compactions.next();
                compaction
            }
            (Some(message), None) => {
                messages.next();
                message
            }
            (None, Some(compaction)) => {
                compactions.next();
                compaction
            }
        };
        if next >= layout.file_len || previous.is_some_and(|offset| offset >= next) {
            return false;
        }
        previous = Some(next);
    }
    true
}

fn prefix_ends_on_line_boundary(path: &Path, file_len: u64) -> Result<bool> {
    if file_len == 0 {
        return Ok(true);
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(file_len - 1))?;
    let mut byte = [0u8; 1];
    Ok(file.read_exact(&mut byte).is_ok() && byte[0] == b'\n')
}

fn offsets_look_like_scan(path: &Path, layout: &TranscriptLayout) -> Result<bool> {
    let head = layout
        .message_offsets
        .first()
        .map(|offset| (*offset, "message"))
        .into_iter()
        .chain(
            layout
                .compaction_offsets
                .first()
                .map(|offset| (*offset, "compaction")),
        );
    for (offset, kind) in head {
        if offset >= layout.file_len {
            return Ok(false);
        }
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut prefix = [0u8; 4096];
        let read = BufReader::new(file).read(&mut prefix)?;
        let text = String::from_utf8_lossy(&prefix[..read]);
        if sniff_line_kind(text.trim_end()) != Some(kind) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn hash_text(digest: &mut Sha256, text: &str) {
    digest.update((text.len() as u64).to_le_bytes());
    digest.update(text.as_bytes());
}

fn layout_cache_digest(layout: &TranscriptLayout) -> String {
    let mut digest = Sha256::new();
    digest.update(LAYOUT_CACHE_MAGIC.as_bytes());
    digest.update(LAYOUT_CACHE_VERSION.as_bytes());
    match &layout.identity {
        FileIdentity::Available {
            platform,
            volume_id,
            file_id,
        } => {
            digest.update(platform.as_bytes());
            digest.update(volume_id.to_le_bytes());
            digest.update(file_id);
        }
        FileIdentity::Unavailable => digest.update(b"unavailable"),
    }
    digest.update(layout.file_len.to_le_bytes());
    digest.update((layout.message_offsets.len() as u64).to_le_bytes());
    digest.update((layout.compaction_offsets.len() as u64).to_le_bytes());
    for offset in layout
        .message_offsets
        .iter()
        .chain(&layout.compaction_offsets)
    {
        digest.update(offset.to_le_bytes());
    }
    digest.update((layout.message_parent.len() as u64).to_le_bytes());
    for parent in &layout.message_parent {
        digest.update(parent.map_or(u32::MAX, |index| index).to_le_bytes());
    }
    digest.update((layout.parent_call_ids.len() as u64).to_le_bytes());
    for call_id in &layout.parent_call_ids {
        hash_text(&mut digest, call_id);
    }
    digest.update((layout.task_calls.len() as u64).to_le_bytes());
    for task in &layout.task_calls {
        digest.update((task.message_index as u64).to_le_bytes());
        hash_text(&mut digest, &task.call_id);
        match &task.delegation_id {
            Some(id) => {
                digest.update([1u8]);
                hash_text(&mut digest, id);
            }
            None => digest.update([0u8]),
        }
        match &task.resume {
            Some(id) => {
                digest.update([1u8]);
                hash_text(&mut digest, id);
            }
            None => digest.update([0u8]),
        }
    }
    hex::encode(digest.finalize())
}

fn store_layout_cache(data_dir: &Path, session_id: &str, layout: &TranscriptLayout) -> Result<()> {
    if layout.file_len < LAYOUT_CACHE_MIN_LEN || !layout.identity.is_available() {
        return Ok(());
    }
    let path = transcript_path(data_dir, session_id)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() != layout.file_len || file_identity(&path, &metadata) != layout.identity {
        return Ok(());
    }
    let cache = layout_cache_path(data_dir, session_id)?;
    let tmp = cache.with_extension("layout.tmp");
    {
        let mut writer = BufWriter::new(File::create(&tmp)?);
        writeln!(writer, "{LAYOUT_CACHE_MAGIC} {LAYOUT_CACHE_VERSION}")?;
        layout.identity.write_tokens(&mut writer)?;
        writeln!(writer, "{}", layout.file_len)?;
        writeln!(
            writer,
            "{} {}",
            layout.message_offsets.len(),
            layout.compaction_offsets.len()
        )?;
        for offsets in [&layout.message_offsets, &layout.compaction_offsets] {
            for (index, offset) in offsets.iter().enumerate() {
                if index % 8 == 7 {
                    writeln!(writer, "{offset}")?;
                } else {
                    write!(writer, "{offset} ")?;
                }
            }
            if !offsets.is_empty() && offsets.len() % 8 != 0 {
                writeln!(writer)?;
            }
        }
        writeln!(writer, "ownership {}", layout.message_parent.len())?;
        for (index, parent) in layout.message_parent.iter().enumerate() {
            if index % 16 == 15 {
                writeln!(writer, "{}", parent.map_or(u32::MAX, |index| index))?;
            } else {
                write!(writer, "{} ", parent.map_or(u32::MAX, |index| index))?;
            }
        }
        if !layout.message_parent.is_empty() && !layout.message_parent.len().is_multiple_of(16) {
            writeln!(writer)?;
        }
        writeln!(writer, "pool {}", layout.parent_call_ids.len())?;
        for call_id in &layout.parent_call_ids {
            writeln!(writer, "{}", hex::encode(call_id.as_bytes()))?;
        }
        writeln!(writer, "tasks {}", layout.task_calls.len())?;
        for task in &layout.task_calls {
            writeln!(
                writer,
                "{}",
                serde_json::json!({
                    "messageIndex": task.message_index,
                    "callId": task.call_id,
                    "delegationId": task.delegation_id,
                    "resume": task.resume,
                })
            )?;
        }
        writeln!(writer, "checksum {}", layout_cache_digest(layout))?;
        writer.flush()?;
        writer.get_ref().sync_data()?;
    }
    swap_into_place(&tmp, &cache)
}

#[cfg(unix)]
pub(crate) fn file_identity(_path: &Path, metadata: &fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    let mut file_id = [0u8; 16];
    file_id[..8].copy_from_slice(&metadata.ino().to_be_bytes());
    FileIdentity::Available {
        platform: "unix",
        volume_id: metadata.dev(),
        file_id,
    }
}

#[cfg(windows)]
pub(crate) fn file_identity(path: &Path, _metadata: &fs::Metadata) -> FileIdentity {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO},
    };

    let Ok(file) = File::open(path) else {
        return FileIdentity::Unavailable;
    };
    let mut info = FILE_ID_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if result == 0 {
        return FileIdentity::Unavailable;
    }
    FileIdentity::Available {
        platform: "windows",
        volume_id: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn file_identity(_path: &Path, _metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity::Unavailable
}

#[cfg(test)]
#[path = "../transcripts_layout_tests.rs"]
mod tests;
