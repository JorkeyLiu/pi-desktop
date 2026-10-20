use std::fs;
use std::path::Path;

use super::model::{ReviewDiffHunk, ReviewDiffLimit, ReviewDiffLine};

/// One side of a comparison is read whole, so it keeps a byte ceiling.
pub(super) const MAX_DIFF_BYTES: u64 = 512 * 1024;
/// Largest changed region solved exactly in one pass: line pairs, not the file.
pub(super) const MAX_DIFF_CELLS: usize = 2_000_000;
/// Total line work one diff may spend, anchor searches included.
pub(super) const MAX_DIFF_WORK: usize = 24_000_000;
/// Hunk bodies above this many lines are dropped; exact counts are kept.
pub(super) const MAX_DIFF_OUTPUT_LINES: usize = 8_000;
/// A review record's hunk text stays far below the renderer's display cap, so a
/// re-read transcript keeps its identity fields.
pub(super) const MAX_RECORD_HUNK_CHARS: usize = 48 * 1024;
/// Deepest anchor bisection before the comparison reports its budget.
pub(super) const MAX_ANCHOR_DEPTH: usize = 64;
pub(super) const CONTEXT_LINES: usize = 3;
#[derive(Debug, Clone)]
pub(super) enum DiffOp {
    Equal(String),
    Add(String),
    Del(String),
}

pub(super) enum DiffSide {
    Present(Vec<u8>),
    TooLarge,
    Missing,
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

/// Line work one comparison may spend. A long file with a small edit finishes
/// after the common prefix/suffix trim and never reaches this budget.
#[derive(Clone, Copy)]
pub(super) struct DiffBudget {
    pub(super) remaining: usize,
    /// The ceiling this child slice was given, so a parent can bill its use.
    pub(super) limit: usize,
}

impl DiffBudget {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            remaining: limit,
            limit,
        }
    }

    /// A slice of this budget for one file, never larger than `cap`.
    pub(super) fn capped(&mut self, cap: usize) -> DiffBudget {
        DiffBudget::new(self.remaining.min(cap))
    }

    /// Bill the parent for what the child slice actually spent.
    pub(super) fn settle(&mut self, child: DiffBudget) {
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
pub(super) fn diff_ops(
    before: &[String],
    after: &[String],
    budget: &mut DiffBudget,
) -> Option<Vec<DiffOp>> {
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
pub(super) fn diff_window(
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
pub(super) fn lcs_ops(
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
pub(super) fn bisect_anchor(
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

pub(super) fn line_counts(ops: &[DiffOp]) -> (usize, usize) {
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

pub(super) fn old_line_count(op: &DiffOp) -> usize {
    matches!(op, DiffOp::Equal(_) | DiffOp::Del(_)) as usize
}

pub(super) fn new_line_count(op: &DiffOp) -> usize {
    matches!(op, DiffOp::Equal(_) | DiffOp::Add(_)) as usize
}

pub(super) fn make_hunks(ops: &[DiffOp]) -> Vec<ReviewDiffHunk> {
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
}

pub(super) fn make_preview(
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
