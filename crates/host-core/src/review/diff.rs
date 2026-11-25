//! Bounded line comparison of two file sides.
//!
//! The comparison engine is `similar`'s Myers implementation with a deadline.
//! Limits are layered: one side may hold at most [`MAX_DIFF_BYTES`] and
//! [`MAX_DIFF_LINES`], one file comparison may compute for at most
//! [`MAX_FILE_DIFF_WORK`], and one `review.files` request shares a
//! [`DiffRequest`] ledger for its whole deadline and input accounting. The
//! engine deadline is cooperative, not a hard real-time guarantee: when the
//! clock has passed the deadline after the call returns, its counts and hunks
//! are discarded rather than trusted.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use similar::{capture_diff_slices_deadline, Algorithm, DiffOp, DiffTag};

use super::model::{ReviewDiffHunk, ReviewDiffLimit, ReviewDiffLine};

/// One side of a comparison is read whole, so it keeps a byte ceiling.
pub(super) const MAX_DIFF_BYTES: u64 = 16 * 1024 * 1024;
/// Lines one side may hold. A side above this is refused before tokenization
/// allocates one slice per line.
pub(super) const MAX_DIFF_LINES: usize = 500_000;
/// Compute time one file comparison may spend.
pub(super) const MAX_FILE_DIFF_WORK: Duration = Duration::from_millis(200);
/// Wall-clock ceiling one `review.files` request may spend over every file.
pub(super) const MAX_REQUEST_DIFF_WORK: Duration = Duration::from_secs(1);
/// Input bytes one `review.files` request may compare, charged once per file.
pub(super) const MAX_REQUEST_DIFF_BYTES: u64 = 64 * 1024 * 1024;
/// Input lines one `review.files` request may compare, charged once per file.
pub(super) const MAX_REQUEST_DIFF_TOKENS: usize = 2_000_000;
/// Hunk bodies above this many lines are dropped; exact counts are kept.
pub(super) const MAX_DIFF_OUTPUT_LINES: usize = 8_000;
/// A review record's hunk text stays far below the renderer's display cap, so a
/// re-read transcript keeps its identity fields.
pub(super) const MAX_RECORD_HUNK_CHARS: usize = 48 * 1024;
pub(super) const CONTEXT_LINES: usize = 3;

pub(super) enum DiffSide {
    Present(Vec<u8>),
    TooLarge,
    Missing,
}

impl DiffSide {
    /// Input bytes this side contributes to a request's accounting.
    pub(super) fn charged_bytes(&self) -> u64 {
        match self {
            DiffSide::Present(bytes) => bytes.len() as u64,
            DiffSide::TooLarge | DiffSide::Missing => 0,
        }
    }
}

/// Read one side of a comparison. A missing earlier side means the snapshot
/// bytes were not retained, which is different from a file that never existed.
pub(super) fn read_diff_side(path: Option<&Path>, exists: bool) -> DiffSide {
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

/// The bytes reading one side is expected to take, from metadata alone: a side
/// that will not be read, or one already above its byte ceiling, reserves
/// nothing because it is never read.
pub(super) fn side_bytes(path: Option<&Path>, exists: bool) -> u64 {
    if !exists {
        return 0;
    }
    let Some(path) = path else {
        return 0;
    };
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_DIFF_BYTES => metadata.len(),
        _ => 0,
    }
}

/// The deadline and input accounting for one comparison.
#[derive(Clone, Copy)]
pub(super) struct DiffWork {
    deadline: Instant,
    /// Whether the request's deadline, not the file's own, is the binding one.
    request_bound: bool,
}

impl DiffWork {
    /// The budget of a comparison that stands alone, outside a request ledger.
    pub(super) fn file(now: Instant) -> Self {
        Self {
            deadline: now + MAX_FILE_DIFF_WORK,
            request_bound: false,
        }
    }

    /// The reason a comparison that ran out of time reports: the request
    /// budget when the request clipped this file, the file's own work otherwise.
    fn limit(&self) -> ReviewDiffLimit {
        if self.request_bound {
            ReviewDiffLimit::RequestBudgetExceeded
        } else {
            ReviewDiffLimit::DiffTooComplex
        }
    }

    fn exceeded(&self, now: Instant) -> bool {
        now >= self.deadline
    }

    /// A comparison whose deadline and binding budget are set by the test, so
    /// an expired budget is exercised without sleeping.
    #[cfg(test)]
    pub(super) fn with_deadline(deadline: Instant, request_bound: bool) -> Self {
        Self {
            deadline,
            request_bound,
        }
    }
}

/// The shared budget of one `review.files` request. Inputs are charged once,
/// when a file is admitted, so accounting never double-counts a file that
/// ends up reporting a limit.
pub(super) struct DiffRequest {
    deadline: Instant,
    bytes_left: u64,
    tokens_left: usize,
}

impl DiffRequest {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            deadline: now + MAX_REQUEST_DIFF_WORK,
            bytes_left: MAX_REQUEST_DIFF_BYTES,
            tokens_left: MAX_REQUEST_DIFF_TOKENS,
        }
    }

    /// Reserve one file's input bytes and derive its deadline, clipped to what
    /// the request has left. `None` means the request cannot afford this file.
    pub(super) fn admit(&mut self, now: Instant, bytes: u64) -> Option<DiffWork> {
        if now >= self.deadline || bytes > self.bytes_left {
            return None;
        }
        self.bytes_left -= bytes;
        let request_deadline = self.deadline;
        let deadline = (now + MAX_FILE_DIFF_WORK).min(request_deadline);
        Some(DiffWork {
            deadline,
            request_bound: deadline >= request_deadline,
        })
    }

    /// Whether the request has no time, bytes, or lines left for another file.
    pub(super) fn is_exhausted(&self, now: Instant) -> bool {
        now >= self.deadline || self.bytes_left == 0 || self.tokens_left == 0
    }

    /// Charge one file's token count. `false` means the request has no lines
    /// left to compare.
    pub(super) fn spend_tokens(&mut self, tokens: usize) -> bool {
        if tokens > self.tokens_left {
            self.tokens_left = 0;
            return false;
        }
        self.tokens_left -= tokens;
        true
    }

    /// Reconcile a reservation with the bytes the two sides actually held.
    /// `false` means a side grew past what the request had left, so the file is
    /// reported as a request limit instead of being compared.
    pub(super) fn settle(&mut self, reserved: u64, actual: u64) -> bool {
        if actual <= reserved {
            self.bytes_left = self.bytes_left.saturating_add(reserved - actual);
            return true;
        }
        match self.bytes_left.checked_sub(actual - reserved) {
            Some(left) => {
                self.bytes_left = left;
                true
            }
            None => {
                self.bytes_left = 0;
                false
            }
        }
    }

    /// A ledger whose budget the test sets, so an exhausted request is
    /// exercised without sleeping or allocating one.
    #[cfg(test)]
    pub(super) fn with_budget(deadline: Instant, bytes_left: u64, tokens_left: usize) -> Self {
        Self {
            deadline,
            bytes_left,
            tokens_left,
        }
    }
}

/// What one comparison may spend: its own deadline plus, in a request, the
/// ledger its tokens are charged to.
pub(super) struct PreviewLimits<'a> {
    work: DiffWork,
    request: Option<&'a mut DiffRequest>,
}

impl<'a> PreviewLimits<'a> {
    /// A comparison outside any request, for per-call previews and durable
    /// records.
    pub(super) fn file(now: Instant) -> Self {
        Self {
            work: DiffWork::file(now),
            request: None,
        }
    }

    /// One file of a request whose bytes were already reserved.
    pub(super) fn request(work: DiffWork, request: &'a mut DiffRequest) -> Self {
        Self {
            work,
            request: Some(request),
        }
    }

    fn spend_tokens(&mut self, tokens: usize) -> bool {
        match self.request.as_deref_mut() {
            Some(request) => request.spend_tokens(tokens),
            None => true,
        }
    }
}
/// One line of a hunk, addressed by the side it comes from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Equal,
    Add,
    Del,
}

#[derive(Clone, Copy)]
struct Entry {
    kind: Kind,
    /// Index into the side's token slice; a line is at most [`MAX_DIFF_LINES`].
    index: u32,
}

/// The evidence one comparison produced. Counts are only present when they are
/// exact; a limit explains why the line evidence is missing.
pub(super) struct ReviewPreview {
    pub(super) binary: bool,
    pub(super) truncated: bool,
    pub(super) reason: Option<ReviewDiffLimit>,
    pub(super) additions: Option<usize>,
    pub(super) deletions: Option<usize>,
    pub(super) hunks: Vec<ReviewDiffHunk>,
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

    pub(super) fn limited(reason: ReviewDiffLimit) -> Self {
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

    /// Exact counts with no body: the change is larger than a record carries.
    fn counted_only(additions: usize, deletions: usize) -> Self {
        Self {
            truncated: true,
            reason: Some(ReviewDiffLimit::DiffTooLarge),
            additions: Some(additions),
            deletions: Some(deletions),
            ..Self::empty()
        }
    }
}

pub(super) fn make_preview(
    before: DiffSide,
    after: DiffSide,
    hunk_char_budget: usize,
    limits: &mut PreviewLimits<'_>,
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
    if limits.work.exceeded(Instant::now()) {
        return ReviewPreview::limited(limits.work.limit());
    }
    // The line ceiling is checked before tokenization, so a pathological side
    // never allocates one slice per line.
    let before_lines = match count_lines(&before) {
        Some(count) if count <= MAX_DIFF_LINES => count,
        _ => return ReviewPreview::limited(ReviewDiffLimit::FileTooLarge),
    };
    let after_lines = match count_lines(&after) {
        Some(count) if count <= MAX_DIFF_LINES => count,
        _ => return ReviewPreview::limited(ReviewDiffLimit::FileTooLarge),
    };
    if !limits.spend_tokens(before_lines + after_lines) {
        return ReviewPreview::limited(ReviewDiffLimit::RequestBudgetExceeded);
    }
    let before_tokens: Vec<&str> = before.lines().collect();
    let after_tokens: Vec<&str> = after.lines().collect();
    if limits.work.exceeded(Instant::now()) {
        return ReviewPreview::limited(limits.work.limit());
    }

    let ops = capture_diff_slices_deadline(
        Algorithm::Myers,
        &before_tokens,
        &after_tokens,
        Some(limits.work.deadline),
    );
    // The engine's deadline is cooperative and it returns a complete coarse
    // script when it runs out. Only a clock read of our own decides, so a
    // result computed after the deadline is discarded instead of trusted.
    if limits.work.exceeded(Instant::now()) {
        return ReviewPreview::limited(limits.work.limit());
    }

    let (additions, deletions) = line_counts(&ops);
    let Some(entries) = collect_entries(&ops) else {
        return ReviewPreview::counted_only(additions, deletions);
    };
    let Some(hunks) = make_hunks(&entries, &before_tokens, &after_tokens, hunk_char_budget) else {
        return ReviewPreview::counted_only(additions, deletions);
    };
    ReviewPreview {
        additions: Some(additions),
        deletions: Some(deletions),
        hunks,
        ..ReviewPreview::empty()
    }
}

/// `str::lines()`'s line count without materializing the lines: a trailing
/// newline ends the last line instead of starting an empty one.
fn count_lines(text: &str) -> Option<usize> {
    if text.is_empty() {
        return Some(0);
    }
    let newlines = text
        .as_bytes()
        .iter()
        .filter(|byte| **byte == b'\n')
        .count();
    Some(if text.ends_with('\n') {
        newlines
    } else {
        newlines + 1
    })
}

/// Edit-script lengths. These are the lengths of the engine's script, which is
/// a valid way to describe the change, not a claim that the script is the
/// globally minimal one.
fn line_counts(ops: &[DiffOp]) -> (usize, usize) {
    let mut additions = 0_usize;
    let mut deletions = 0_usize;
    for op in ops {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        match tag {
            DiffTag::Equal => {}
            DiffTag::Delete => deletions += old_range.len(),
            DiffTag::Insert => additions += new_range.len(),
            DiffTag::Replace => {
                deletions += old_range.len();
                additions += new_range.len();
            }
        }
    }
    (additions, deletions)
}

/// Flatten the edit script into the line order a hunk renders. `None` means the
/// changed lines alone already exceed the body cap, so no hunk is worth
/// building; the caller keeps the exact counts.
fn collect_entries(ops: &[DiffOp]) -> Option<Vec<Entry>> {
    let capacity: usize = ops
        .iter()
        .map(|op| op.old_range().len() + op.new_range().len())
        .sum();
    let mut entries = Vec::with_capacity(capacity);
    let mut changed = 0_usize;
    for op in ops {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        match tag {
            DiffTag::Equal => {
                for index in old_range {
                    entries.push(Entry {
                        kind: Kind::Equal,
                        index: index as u32,
                    });
                }
            }
            DiffTag::Delete => {
                changed += old_range.len();
                for index in old_range {
                    entries.push(Entry {
                        kind: Kind::Del,
                        index: index as u32,
                    });
                }
            }
            DiffTag::Insert => {
                changed += new_range.len();
                for index in new_range {
                    entries.push(Entry {
                        kind: Kind::Add,
                        index: index as u32,
                    });
                }
            }
            DiffTag::Replace => {
                changed += old_range.len() + new_range.len();
                for index in old_range {
                    entries.push(Entry {
                        kind: Kind::Del,
                        index: index as u32,
                    });
                }
                for index in new_range {
                    entries.push(Entry {
                        kind: Kind::Add,
                        index: index as u32,
                    });
                }
            }
        }
        // Every changed line lands in a hunk body, so the body cap can be
        // decided before a single hunk line is allocated.
        if changed > MAX_DIFF_OUTPUT_LINES {
            return None;
        }
    }
    Some(entries)
}

fn make_hunks(
    entries: &[Entry],
    before: &[&str],
    after: &[&str],
    hunk_char_budget: usize,
) -> Option<Vec<ReviewDiffHunk>> {
    let changed: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| (entry.kind != Kind::Equal).then_some(index))
        .collect();
    if changed.is_empty() {
        return Some(Vec::new());
    }

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for index in changed {
        let start = index.saturating_sub(CONTEXT_LINES);
        let end = (index + CONTEXT_LINES + 1).min(entries.len());
        if let Some((_, previous_end)) = ranges.last_mut() {
            if start <= *previous_end {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        ranges.push((start, end));
    }

    let mut hunks = Vec::with_capacity(ranges.len());
    let mut old_count = 0_usize;
    let mut new_count = 0_usize;
    let mut cursor = 0_usize;
    let mut rendered_lines = 0_usize;
    let mut rendered_chars = 0_usize;
    for (start, end) in ranges {
        while cursor < start {
            advance(entries[cursor].kind, &mut old_count, &mut new_count);
            cursor += 1;
        }
        let old_before = old_count;
        let new_before = new_count;
        let mut lines = Vec::with_capacity(end - start);
        while cursor < end {
            let entry = entries[cursor];
            let (line_type, text) = match entry.kind {
                Kind::Equal => ("context", before[entry.index as usize]),
                Kind::Del => ("del", before[entry.index as usize]),
                Kind::Add => ("add", after[entry.index as usize]),
            };
            rendered_lines += 1;
            rendered_chars += text.chars().count();
            if rendered_lines > MAX_DIFF_OUTPUT_LINES || rendered_chars > hunk_char_budget {
                return None;
            }
            lines.push(ReviewDiffLine {
                line_type: line_type.to_string(),
                text: text.to_string(),
            });
            advance(entry.kind, &mut old_count, &mut new_count);
            cursor += 1;
        }
        let old_len = old_count - old_before;
        let new_len = new_count - new_before;
        let old_start = old_before + 1;
        let new_start = new_before + 1;
        hunks.push(ReviewDiffHunk {
            header: format!("@@ -{old_start},{old_len} +{new_start},{new_len} @@"),
            lines,
        });
    }
    Some(hunks)
}

fn advance(kind: Kind, old_count: &mut usize, new_count: &mut usize) {
    match kind {
        Kind::Equal => {
            *old_count += 1;
            *new_count += 1;
        }
        Kind::Del => *old_count += 1,
        Kind::Add => *new_count += 1,
    }
}
