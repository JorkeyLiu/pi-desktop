//! Renderer-facing history scopes over the physical transcript layout.
//!
//! A scope selects a set of physical message rows without changing the
//! transcript's own coordinates. `messageStart` / `messageEnd` stay physical;
//! the page limit counts selected rows only, so a delegation page is not
//! consumed by the parent conversation's volume.

use serde::{Deserialize, Serialize};

use super::layout::TranscriptLayout;

/// Which history a renderer read means. The wire form is the enum's serde
/// representation: `{"kind":"main"}` or
/// `{"kind":"delegation","id":"…"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum HistoryScope {
    Main,
    Delegation { id: String },
}

/// The rows one scope selects, plus the root Task records that identify the
/// whole chain and the canonical identity to echo back.
#[derive(Debug, Default, Clone)]
pub(crate) struct ScopedSelection {
    /// Selected physical message indexes, ascending.
    pub(crate) selected: Vec<usize>,
    /// Physical Task rows that identify the selected chain, ascending.
    pub(crate) context: Vec<usize>,
    /// Canonical scope echo: the stable chain identity when one exists.
    pub(crate) canonical: Option<HistoryScope>,
}

/// One page of selected rows. `start` / `end` are physical coordinates;
/// `from` / `to` index into the selection itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScopedPage {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) from: usize,
    pub(crate) to: usize,
    pub(crate) has_more_before: bool,
    pub(crate) has_more_after: bool,
}

/// Select the history rows a scope names.
pub(crate) fn select(layout: &TranscriptLayout, scope: &HistoryScope) -> ScopedSelection {
    match scope {
        HistoryScope::Main => ScopedSelection {
            selected: layout.top_level_indices().to_vec(),
            context: Vec::new(),
            canonical: Some(HistoryScope::Main),
        },
        HistoryScope::Delegation { id } => {
            let target = id.trim();
            if target.is_empty() {
                return ScopedSelection {
                    selected: Vec::new(),
                    context: Vec::new(),
                    canonical: Some(HistoryScope::Delegation { id: id.clone() }),
                };
            }
            let chain = chain_call_ids(layout, target);
            if chain.is_empty() {
                return ScopedSelection {
                    selected: Vec::new(),
                    context: Vec::new(),
                    canonical: Some(HistoryScope::Delegation {
                        id: target.to_string(),
                    }),
                };
            }
            let mut selected = Vec::new();
            let mut context = Vec::new();
            let mut canonical = None;
            for task in layout
                .task_calls()
                .iter()
                .filter(|task| chain.contains(&task.call_id))
            {
                context.push(task.message_index);
                if canonical.is_none() {
                    canonical = Some(HistoryScope::Delegation {
                        id: task
                            .delegation_id
                            .clone()
                            .unwrap_or_else(|| task.call_id.clone()),
                    });
                }
            }
            for index in 0..layout.message_count() {
                if layout
                    .parent_call_id(index)
                    .is_some_and(|parent| chain.contains(parent))
                {
                    selected.push(index);
                }
            }
            context.sort_unstable();
            let canonical = canonical.unwrap_or_else(|| HistoryScope::Delegation {
                id: target.to_string(),
            });
            ScopedSelection {
                selected,
                context,
                canonical: Some(canonical),
            }
        }
    }
}

/// Connected component of Task calls around `target`, matching the renderer's
/// `subagent-chain.ts`: a resume may name a prior delegation id or the bare
/// call id, and a self-reference adds no node.
fn chain_call_ids(layout: &TranscriptLayout, target: &str) -> std::collections::HashSet<String> {
    use std::collections::{HashMap, HashSet};

    // Duplicate physical rows for one call id are retries of the same call;
    // the last physical row is the renderer's answer.
    let mut seen = HashSet::new();
    let mut tasks: Vec<&super::layout::TaskCallIndex> = layout
        .task_calls()
        .iter()
        .rev()
        .filter(|task| seen.insert(task.call_id.clone()))
        .collect();
    tasks.reverse();
    if tasks.is_empty() {
        return HashSet::new();
    }

    let mut call_by_delegation = HashMap::new();
    for task in &tasks {
        if let Some(delegation_id) = &task.delegation_id {
            call_by_delegation.insert(delegation_id.clone(), task.call_id.clone());
        }
    }

    let call_ids: HashSet<&str> = tasks.iter().map(|task| task.call_id.as_str()).collect();
    let mut neighbors: HashMap<String, Vec<String>> = HashMap::new();
    for task in &tasks {
        let Some(resume) = task
            .resume
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let resolved = call_by_delegation
            .get(resume)
            .cloned()
            .unwrap_or_else(|| resume.to_string());
        if resolved == task.call_id {
            continue;
        }
        neighbors
            .entry(resolved.clone())
            .or_default()
            .push(task.call_id.clone());
        neighbors
            .entry(task.call_id.clone())
            .or_default()
            .push(resolved);
    }

    let seeds: Vec<String> = tasks
        .iter()
        .filter(|task| task.delegation_id.as_deref() == Some(target) || task.call_id == target)
        .map(|task| task.call_id.clone())
        .collect();
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: Vec<String> = seeds;
    while let Some(call_id) = queue.pop() {
        if !visited.insert(call_id.clone()) {
            continue;
        }
        if let Some(next) = neighbors.get(&call_id) {
            queue.extend(next.iter().cloned());
        }
    }
    // Only Task call ids are chain members; an unresolved resume target is a
    // traversal node, not a call the renderer would list.
    visited.retain(|call_id| call_ids.contains(call_id.as_str()));
    visited
}

/// Paginate a selection. `before` is the legacy physical exclusive cursor;
/// `limit` counts selected records only. `around` is a physical target used
/// to centre the page.
pub(crate) fn page(
    selected: &[usize],
    before: Option<i64>,
    limit: Option<usize>,
    around: Option<usize>,
) -> ScopedPage {
    let total = selected.len();
    let limit = limit.unwrap_or(total).max(1);
    let before_position = match around {
        Some(target) => {
            let count_at_or_before = selected.partition_point(|index| *index <= target);
            (count_at_or_before + limit / 2).min(total)
        }
        None => match before {
            Some(cursor) => {
                let cursor = usize::try_from(cursor.max(0)).unwrap_or(usize::MAX);
                selected.partition_point(|index| *index < cursor).min(total)
            }
            None => total,
        },
    };
    let end = before_position.min(total);
    let start = end.saturating_sub(limit);
    let (start_physical, end_physical) = if start < end {
        (selected[start], selected[end - 1] + 1)
    } else {
        (
            selected.get(start).copied().unwrap_or(0),
            selected.get(start).copied().unwrap_or(0),
        )
    };
    ScopedPage {
        start: start_physical,
        end: end_physical,
        from: start,
        to: end,
        has_more_before: start > 0,
        has_more_after: end < total,
    }
}

/// Resolve a nested physical row to its owning top-level row. Returns `None`
/// when the Task row that owns the row is missing or the chain cycles.
pub(crate) fn owning_top_level(layout: &TranscriptLayout, mut index: usize) -> Option<usize> {
    let mut steps = 0usize;
    loop {
        match layout.parent_call_id(index) {
            None => return Some(index),
            Some(parent_call_id) => {
                let task = layout.last_task_for_call(parent_call_id)?;
                index = task.message_index;
            }
        }
        steps += 1;
        if steps > layout.message_count() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcripts::layout::TaskCallIndex;

    /// One physical row: its owning `parentToolCallId`, then its own Task call.
    type Row<'a> = (Option<&'a str>, Option<(&'a str, Option<&'a str>)>);

    /// Build a physical-only layout from `(parentCallId, Task(callId, resume))`.
    fn layout(rows: &[Row<'_>]) -> TranscriptLayout {
        let mut layout = TranscriptLayout {
            message_offsets: (0..rows.len() as u64).collect(),
            ..TranscriptLayout::default()
        };
        for (index, (parent, task)) in rows.iter().enumerate() {
            let parent_index = parent.map(|parent| {
                if let Some(index) = layout
                    .parent_call_ids
                    .iter()
                    .position(|existing| existing == parent)
                {
                    return index as u32;
                }
                let index = layout.parent_call_ids.len() as u32;
                layout.parent_call_ids.push(parent.to_string());
                index
            });
            layout.message_parent.push(parent_index);
            if let Some((call_id, resume)) = task {
                layout.task_calls.push(TaskCallIndex {
                    message_index: index,
                    call_id: (*call_id).to_string(),
                    delegation_id: Some(format!("{call_id}-delegation")),
                    resume: resume.map(str::to_string),
                });
            }
        }
        layout.rebuild_top_level();
        layout
    }

    #[test]
    fn main_selects_only_top_level_rows() {
        let layout = layout(&[
            (None, None),
            (Some("task-1"), None),
            (None, Some(("task-1", None))),
            (Some("task-1"), None),
        ]);
        let selected = select(&layout, &HistoryScope::Main);
        assert_eq!(selected.selected, vec![0, 2]);
        assert!(selected.context.is_empty());
        assert_eq!(selected.canonical, Some(HistoryScope::Main));
    }

    #[test]
    fn delegation_selects_direct_children_of_the_resume_chain() {
        // root Task, child, resume Task (delegation id form), child of resume.
        let layout = layout(&[
            (None, Some(("task-1", None))),
            (Some("task-1"), None),
            (None, Some(("task-2", Some("task-1-delegation")))), // resolves by delegation id
            (Some("task-2"), None),
            (Some("task-1"), None),
            (None, Some(("task-3", Some("task-2")))), // resolves by bare call id
            (Some("task-3"), None),
        ]);
        let selected = select(
            &layout,
            &HistoryScope::Delegation {
                id: "task-1-delegation".into(),
            },
        );
        assert_eq!(selected.selected, vec![1, 3, 4, 6]);
        assert_eq!(selected.context, vec![0, 2, 5]);
        assert_eq!(
            selected.canonical,
            Some(HistoryScope::Delegation {
                id: "task-1-delegation".into()
            })
        );
        // Entering by the bare call id closes the same chain.
        let by_call = select(
            &layout,
            &HistoryScope::Delegation {
                id: "task-2".into(),
            },
        );
        assert_eq!(by_call.selected, selected.selected);
        assert_eq!(
            by_call.canonical,
            Some(HistoryScope::Delegation {
                id: "task-1-delegation".into()
            })
        );
    }

    #[test]
    fn unknown_delegation_selects_nothing_so_the_read_reports_no_session() {
        let layout = layout(&[(None, None), (Some("task-1"), None)]);
        let selected = select(
            &layout,
            &HistoryScope::Delegation {
                id: "missing".into(),
            },
        );
        // Selection alone stays physical and empty; `scoped_read_parts`
        // turns an empty delegation context into `session: null`, because an
        // id no Task call answers to names no chain at all.
        assert!(selected.selected.is_empty());
        assert!(selected.context.is_empty());
    }

    #[test]
    fn paging_counts_selected_records_not_skipped_children() {
        let selected = vec![900];
        let page = page(&selected, None, Some(50), None);
        assert_eq!(page.from, 0);
        assert_eq!(page.to, 1);
        assert_eq!(page.start, 900);
        assert_eq!(page.end, 901);
        assert!(!page.has_more_before);
    }

    #[test]
    fn before_is_a_physical_exclusive_cursor_over_the_selection() {
        let selected = vec![10, 50, 90, 130];
        let page = page(&selected, Some(100), Some(2), None);
        assert_eq!(page.from, 1);
        assert_eq!(page.to, 3);
        assert_eq!(page.start, 50);
        assert_eq!(page.end, 91);
        assert!(page.has_more_before);
        assert!(page.has_more_after);
    }

    #[test]
    fn around_centers_on_the_selected_position() {
        let selected = vec![0, 2, 4];
        let centered = page(&selected, None, Some(3), Some(2));
        assert_eq!(centered.start, 0);
        assert_eq!(centered.end, 5);
        assert_eq!(centered.from, 0);
        assert_eq!(centered.to, 3);
        let tail = page(&selected, None, Some(2), Some(5));
        assert_eq!(tail.from, 1);
        assert!(tail.has_more_before);
    }

    #[test]
    fn owning_top_level_walks_resume_owned_rows() {
        let layout = layout(&[
            (None, Some(("task-1", None))),
            (Some("task-1"), Some(("task-2", None))),
            (Some("task-2"), None),
            (None, None),
        ]);
        assert_eq!(owning_top_level(&layout, 2), Some(0));
        assert_eq!(owning_top_level(&layout, 3), Some(3));
        assert_eq!(owning_top_level(&layout, 1), Some(0));
    }
}
