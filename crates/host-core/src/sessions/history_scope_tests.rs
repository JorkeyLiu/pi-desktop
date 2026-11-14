use super::*;
use crate::transcripts::{scope::HistoryScope, transcript_path};
use serde_json::{json, Value};

fn test_db() -> Database {
    let dir = std::env::temp_dir().join(format!("pi-desktop-scope-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    Database::open(&dir.join("test.sqlite")).unwrap()
}

fn ui(value: Value) -> UiMessage {
    serde_json::from_value(value).unwrap()
}

fn user_message(id: &str, text: &str, ts: &str) -> UiMessage {
    ui(json!({
        "id": id,
        "role": "user",
        "content": text,
        "createdAt": ts,
    }))
}

fn child_message(id: &str, text: &str, ts: &str, parent: &str) -> UiMessage {
    ui(json!({
        "id": id,
        "role": "assistant",
        "content": text,
        "createdAt": ts,
        "parentToolCallId": parent,
    }))
}

fn task_message(
    id: &str,
    call_id: &str,
    delegation_id: &str,
    status: &str,
    ts: &str,
    resume: Option<&str>,
    parent: Option<&str>,
) -> UiMessage {
    let mut value = json!({
        "id": id,
        "role": "tool",
        "content": "",
        "createdAt": ts,
        "toolName": "Task",
        "toolCallId": call_id,
        "toolResult": {"details": {
            "delegationId": delegation_id,
            "status": status,
            "result": status,
        }},
    });
    if let Some(resume) = resume {
        value["toolArgs"] = json!({ "resume": resume });
    }
    if let Some(parent) = parent {
        value["parentToolCallId"] = json!(parent);
    }
    ui(value)
}

fn timestamp(index: usize) -> String {
    format!("2026-10-11T00:{:02}:{:02}.000Z", index / 60, index % 60)
}

const ROOT_USER: &str = "root-user";
const TASK_1: &str = "task-1-msg";
const TASK_2: &str = "task-2-msg";
const TASK_3: &str = "task-3-msg";
const FOLLOW_USER: &str = "follow-user";
const NESTED_TASK: &str = "nested-task-msg";
const NESTED_CHILD: &str = "nested-child";
const FINAL_USER: &str = "final-user";
const CHILD_1_LAST: &str = "child-1-1000";
const CHILD_2_A: &str = "child-2-a";
const CHILD_2_B: &str = "child-2-b";
const CHILD_3_A: &str = "child-3-a";

/// A session whose transcript has a root Task with >1000 children, a resumed
/// Task by delegation id, a resumed Task by bare call id, and an unrelated
/// nested Task. Written directly so the fixture does not fsync 1000 lines.
fn scoped_fixture() -> (Database, String) {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let mut messages = vec![
        user_message(ROOT_USER, "root", &timestamp(0)),
        task_message(
            TASK_1,
            "call-1",
            "delegation-1",
            "completed",
            &timestamp(1),
            None,
            None,
        ),
    ];
    for index in 0..=1000 {
        let id = if index == 1000 {
            CHILD_1_LAST.to_string()
        } else {
            format!("child-1-{index}")
        };
        messages.push(child_message(&id, "child 1", &timestamp(2), "call-1"));
    }
    messages.push(task_message(
        TASK_2,
        "call-2",
        "delegation-2",
        "completed",
        &timestamp(3),
        Some("delegation-1"),
        None,
    ));
    messages.push(child_message(
        CHILD_2_A,
        "child 2a",
        &timestamp(3),
        "call-2",
    ));
    messages.push(child_message(
        CHILD_2_B,
        "child 2b",
        &timestamp(3),
        "call-2",
    ));
    messages.push(user_message(FOLLOW_USER, "follow", &timestamp(4)));
    messages.push(task_message(
        TASK_3,
        "call-3",
        "delegation-3",
        "completed",
        &timestamp(5),
        Some("call-2"),
        None,
    ));
    messages.push(child_message(
        CHILD_3_A,
        "child 3a",
        &timestamp(5),
        "call-3",
    ));
    messages.push(task_message(
        NESTED_TASK,
        "call-nested",
        "delegation-nested",
        "completed",
        &timestamp(6),
        None,
        Some("call-1"),
    ));
    messages.push(child_message(
        NESTED_CHILD,
        "nested child",
        &timestamp(6),
        "call-nested",
    ));
    messages.push(user_message(FINAL_USER, "final", &timestamp(7)));
    let records: Vec<MessageRecord> = messages
        .iter()
        .map(|message| ui_to_record(message).0)
        .collect();
    transcripts::write_transcript_with_compactions(
        db.data_dir(),
        &session.id,
        &session.created_at,
        &records,
        &[],
    )
    .unwrap();
    (db, session.id)
}

fn ids(detail: &SessionDetail) -> Vec<&str> {
    detail
        .messages
        .iter()
        .map(|message| message.id.as_str())
        .collect()
}

fn options() -> SessionReadOptions {
    SessionReadOptions::default()
}

#[test]
fn main_scope_skips_child_rows_and_counts_top_level_only() {
    let (db, session_id) = scoped_fixture();
    let detail = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_limit: Some(2),
            ..options()
        },
        HistoryScope::Main,
    )
    .unwrap()
    .unwrap();
    // A nested Task row carries `parentToolCallId`, so it belongs to the
    // delegation that launched it, not to the main transcript.
    assert_eq!(ids(&detail), vec![TASK_3, FINAL_USER]);
    assert_eq!(detail.message_start, Some(1007));
    assert_eq!(detail.message_end, Some(1012));
    assert_eq!(detail.has_more_before, Some(true));
    assert_eq!(detail.has_more_after, Some(false));
    assert!(detail.history_context.is_empty());
    assert_eq!(detail.history_scope, Some(HistoryScope::Main));

    // The absent-scope read keeps its exact physical semantics: the last two
    // message lines include a child row.
    let legacy = get_session_with_options(
        &db,
        &session_id,
        SessionReadOptions {
            message_limit: Some(2),
            ..options()
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(ids(&legacy), vec![NESTED_CHILD, FINAL_USER]);
    assert_eq!(legacy.history_scope, None);
    assert!(legacy.history_context.is_empty());
}

#[test]
fn delegation_scope_counts_distinct_children_and_pages_by_physical_cursor() {
    let (db, session_id) = scoped_fixture();
    let detail = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_limit: Some(3),
            ..options()
        },
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(ids(&detail), vec![CHILD_2_B, CHILD_3_A, NESTED_TASK]);
    assert_eq!(detail.message_start, Some(1005));
    assert_eq!(detail.message_end, Some(1010));
    assert_eq!(detail.has_more_before, Some(true));
    assert_eq!(detail.has_more_after, Some(false));
    assert_eq!(
        detail.history_scope,
        Some(HistoryScope::Delegation {
            id: "delegation-1".into()
        })
    );
    let context_ids: Vec<&str> = detail
        .history_context
        .iter()
        .map(|message| message.id.as_str())
        .collect();
    assert_eq!(context_ids, vec![TASK_1, TASK_2, TASK_3]);

    // The cursor is physical (messageStart), but the limit counts only the
    // selected records: the Task row at 1003 is skipped, not consumed.
    let older = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_before: detail.message_start,
            message_limit: Some(2),
            ..options()
        },
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(ids(&older), vec![CHILD_1_LAST, CHILD_2_A]);
    assert_eq!(older.message_start, Some(1002));
    assert_eq!(older.message_end, Some(1005));
    assert_eq!(older.has_more_before, Some(true));
    assert_eq!(older.has_more_after, Some(true));

    // The chain starts above the 1000-child boundary.
    let first = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_limit: Some(1),
            ..options()
        },
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(ids(&first), vec![NESTED_TASK]);
}

#[test]
fn delegation_resume_resolves_by_delegation_id_or_bare_call_id() {
    let (db, session_id) = scoped_fixture();
    let by_delegation = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_limit: Some(50),
            ..options()
        },
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    let by_call = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_limit: Some(50),
            ..options()
        },
        HistoryScope::Delegation {
            id: "call-2".into(),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(ids(&by_delegation), ids(&by_call));
    assert_eq!(
        by_call.history_scope,
        Some(HistoryScope::Delegation {
            id: "delegation-1".into()
        }),
        "the canonical echo is the earliest chain identity"
    );
}

#[test]
fn main_around_a_nested_target_centres_on_its_owning_root() {
    let (db, session_id) = scoped_fixture();
    let detail = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_around: Some(NESTED_CHILD.into()),
            message_limit: Some(5),
            ..options()
        },
        HistoryScope::Main,
    )
    .unwrap()
    .unwrap();
    // The page is a main-scope window centred on the top-level row that owns
    // the searched child, so the requested row itself is not in `messages`.
    assert_eq!(ids(&detail), vec![ROOT_USER, TASK_1, TASK_2, FOLLOW_USER]);
    assert_eq!(detail.message_start, Some(0));
    assert_eq!(detail.message_end, Some(1007));
    assert_eq!(detail.history_scope, Some(HistoryScope::Main));
    let parent = detail
        .navigation_parent
        .as_ref()
        .expect("owning Task")
        .clone();
    assert_eq!(parent.id, NESTED_TASK);

    // Repeated identical retries do not duplicate the page.
    let retry = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_around: Some(NESTED_CHILD.into()),
            message_limit: Some(5),
            ..options()
        },
        HistoryScope::Main,
    )
    .unwrap()
    .unwrap();
    assert_eq!(ids(&retry), ids(&detail));
    assert_eq!(retry.message_start, detail.message_start);
    assert_eq!(retry.message_end, detail.message_end);

    let missing = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_around: Some("no-such-message".into()),
            message_limit: Some(5),
            ..options()
        },
        HistoryScope::Main,
    )
    .unwrap();
    assert!(
        missing.is_none(),
        "a missing target must not fall back to a physical tail"
    );
}

#[test]
fn delegation_around_uses_the_physical_target_and_keeps_navigation_parent() {
    let (db, session_id) = scoped_fixture();
    let detail = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_around: Some(CHILD_1_LAST.into()),
            message_limit: Some(3),
            ..options()
        },
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(ids(&detail), vec!["child-1-999", CHILD_1_LAST, CHILD_2_A]);
    assert_eq!(
        detail
            .navigation_parent
            .as_ref()
            .map(|message| message.id.as_str()),
        Some(TASK_1)
    );
}

#[test]
fn open_main_then_read_delegation_then_paginate() {
    let (db, session_id) = scoped_fixture();
    let main = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_limit: Some(50),
            ..options()
        },
        HistoryScope::Main,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        ids(&main),
        vec![ROOT_USER, TASK_1, TASK_2, FOLLOW_USER, TASK_3, FINAL_USER]
    );

    let delegation = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_limit: Some(5),
            ..options()
        },
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        ids(&delegation),
        vec![CHILD_1_LAST, CHILD_2_A, CHILD_2_B, CHILD_3_A, NESTED_TASK]
    );
    let older = get_session_scoped(
        &db,
        &session_id,
        SessionReadOptions {
            message_before: delegation.message_start,
            message_limit: Some(5),
            ..options()
        },
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    let overlap: Vec<&str> = ids(&older)
        .into_iter()
        .filter(|id| ids(&delegation).contains(id))
        .collect();
    assert!(
        overlap.is_empty(),
        "physical cursor must not duplicate rows"
    );
    assert_eq!(
        ids(&older),
        vec![
            "child-1-995",
            "child-1-996",
            "child-1-997",
            "child-1-998",
            "child-1-999"
        ]
    );
}

#[test]
fn snapshots_overlay_scoped_reads_without_moving_the_transcript() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let ts = timestamp(0);
    append_message(
        &db,
        &session.id,
        &user_message(ROOT_USER, "root", &ts),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None),
        None,
    )
    .unwrap();
    let path = transcript_path(db.data_dir(), &session.id).unwrap();
    let before = std::fs::read(&path).unwrap();
    append_message(
        &db,
        &session.id,
        &task_message(
            TASK_1,
            "call-1",
            "delegation-1",
            "completed",
            &ts,
            None,
            None,
        ),
        None,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "an accepted Task snapshot must not rewrite the transcript"
    );
    assert!(snapshots_file(&db, &session.id).exists());

    let full = get_session(&db, &session.id).unwrap().unwrap();
    let task = full
        .messages
        .iter()
        .find(|message| message.id == TASK_1)
        .unwrap();
    assert_eq!(
        task.tool_result.as_ref().unwrap()["details"]["status"],
        "completed"
    );

    let scoped = get_session_scoped(
        &db,
        &session.id,
        options(),
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(scoped.history_context.len(), 1);
    assert_eq!(
        scoped.history_context[0].tool_result.as_ref().unwrap()["details"]["status"],
        "completed"
    );

    // A late progress snapshot cannot reopen the settled delegation.
    append_message(
        &db,
        &session.id,
        &task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None),
        None,
    )
    .unwrap();
    let after = get_session(&db, &session.id).unwrap().unwrap();
    let task = after
        .messages
        .iter()
        .find(|message| message.id == TASK_1)
        .unwrap();
    assert_eq!(
        task.tool_result.as_ref().unwrap()["details"]["status"],
        "completed"
    );
}

#[test]
fn a_full_session_read_keeps_the_completed_report_whole() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let ts = timestamp(0);
    let launch = task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None);
    append_message(&db, &session.id, &launch, None).unwrap();

    // The settled report is what the parent reads back from the delegate; a
    // durable Task row must not lose it to a display cap.
    let report = "r".repeat(300_000);
    let mut settled = task_message(
        TASK_1,
        "call-1",
        "delegation-1",
        "completed",
        &ts,
        None,
        None,
    );
    settled.tool_result = Some(json!({
        "details": {"delegationId": "delegation-1", "status": "completed", "result": report}
    }));
    settled.content = report.clone();
    append_message(&db, &session.id, &settled, None).unwrap();

    let full = get_session(&db, &session.id).unwrap().unwrap();
    let task = full
        .messages
        .iter()
        .find(|message| message.id == TASK_1)
        .unwrap();
    assert_eq!(
        task.tool_result.as_ref().unwrap()["details"]["result"]
            .as_str()
            .unwrap()
            .len(),
        300_000,
        "the accepted snapshot must be stored and read without a display cap"
    );

    let preview = get_session_with_options(
        &db,
        &session.id,
        SessionReadOptions {
            content_limit: Some(64),
            ..options()
        },
    )
    .unwrap()
    .unwrap();
    let task = preview
        .messages
        .iter()
        .find(|message| message.id == TASK_1)
        .unwrap();
    assert!(
        task.tool_result.as_ref().unwrap()["details"]["result"]
            .as_str()
            .unwrap()
            .len()
            < 300_000,
        "a caller-supplied content limit still previews"
    );
}

fn snapshots_file(db: &Database, session_id: &str) -> std::path::PathBuf {
    transcript_path(db.data_dir(), session_id)
        .unwrap()
        .with_extension("snapshots.jsonl")
}

const MID_USER: &str = "mid-user";

/// Append a settled `Task` row whose report and checkpoint the parent reads back.
fn settle(
    db: &Database,
    session_id: &str,
    id: &str,
    call_id: &str,
    delegation_id: &str,
    report: &str,
    ts: &str,
) {
    let mut settled = task_message(id, call_id, delegation_id, "completed", ts, None, None);
    settled.content = report.to_string();
    settled.tool_result = Some(json!({
        "details": {
            "delegationId": delegation_id,
            "status": "completed",
            "result": report,
            "handoffCheckpoint": {"generation": 1, "summary": "context replaced"},
        }
    }));
    append_message(db, session_id, &settled, None).unwrap();
}

fn find_task<'a>(detail: &'a SessionDetail, id: &str) -> &'a UiMessage {
    detail
        .messages
        .iter()
        .find(|message| message.id == id)
        .unwrap_or_else(|| panic!("{id} must be in the read result"))
}

fn task_details(task: &UiMessage) -> &Value {
    &task
        .tool_result
        .as_ref()
        .expect("Task row carries a result")["details"]
}

#[test]
fn an_unrelated_edit_preserves_the_settled_report_and_checkpoint() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let ts = timestamp(0);
    append_message(
        &db,
        &session.id,
        &user_message("u-before", "before", &ts),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &user_message("u-after", "after", &ts),
        None,
    )
    .unwrap();
    let report = "r".repeat(300_000);
    settle(
        &db,
        &session.id,
        TASK_1,
        "call-1",
        "delegation-1",
        &report,
        &ts,
    );
    assert!(snapshots_file(&db, &session.id).exists());

    // The caller's copy of the Task row still says `running`: it was read
    // before the settlement landed. That row is the original launch row, so the
    // rewrite has to materialize the accepted overlay into the transcript
    // instead of discarding the only authoritative copy of the report.
    let stale = vec![
        user_message("u-before", "edited before", &ts),
        task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None),
        user_message("u-after", "edited after", &ts),
    ];
    replace_messages(&db, &session.id, &stale).unwrap();

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    let task = find_task(&detail, TASK_1);
    let details = task_details(task);
    assert_eq!(details["status"], "completed");
    assert_eq!(
        details["result"].as_str().unwrap().len(),
        300_000,
        "the settled report must survive an unrelated edit byte complete"
    );
    assert_eq!(details["handoffCheckpoint"]["generation"], 1);
    let before = detail
        .messages
        .iter()
        .find(|message| message.id == "u-before")
        .unwrap();
    assert_eq!(before.content, "edited before");
    let after = detail
        .messages
        .iter()
        .find(|message| message.id == "u-after")
        .unwrap();
    assert_eq!(after.content, "edited after");

    let raw =
        std::fs::read_to_string(transcript_path(db.data_dir(), &session.id).unwrap()).unwrap();
    assert!(
        !raw.contains("\"status\":\"running\""),
        "no phantom running Task row may be left behind"
    );
    assert!(
        !snapshots_file(&db, &session.id).exists(),
        "the folded entry must be pruned once the row carries it"
    );

    // A retry that carries the effective rows is a no-op on the same content.
    let retry = detail.messages.clone();
    replace_messages(&db, &session.id, &retry).unwrap();
    let again = get_session(&db, &session.id).unwrap().unwrap();
    let task = find_task(&again, TASK_1);
    assert_eq!(task_details(task)["status"], "completed");
    assert_eq!(
        task_details(task)["result"].as_str().unwrap().len(),
        300_000
    );
    assert!(!snapshots_file(&db, &session.id).exists());
}

#[test]
fn truncate_keeps_a_retained_task_and_drops_a_removed_one() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let ts = timestamp(0);
    append_message(
        &db,
        &session.id,
        &user_message(ROOT_USER, "root", &ts),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &child_message(CHILD_2_A, "child a", &timestamp(1), "call-1"),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &user_message(MID_USER, "mid", &timestamp(2)),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &task_message(
            TASK_2,
            "call-2",
            "delegation-2",
            "running",
            &timestamp(3),
            None,
            None,
        ),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &child_message(CHILD_2_B, "child b", &timestamp(3), "call-2"),
        None,
    )
    .unwrap();
    settle(
        &db,
        &session.id,
        TASK_1,
        "call-1",
        "delegation-1",
        &"a".repeat(300_000),
        &ts,
    );
    settle(
        &db,
        &session.id,
        TASK_2,
        "call-2",
        "delegation-2",
        &"b".repeat(4_096),
        &timestamp(3),
    );

    truncate_from(&db, &session.id, Some(MID_USER), None).unwrap();

    let detail = get_session(&db, &session.id).unwrap().unwrap();
    let kept = find_task(&detail, TASK_1);
    let details = task_details(kept);
    assert_eq!(details["status"], "completed");
    assert_eq!(
        details["result"].as_str().unwrap().len(),
        300_000,
        "the retained Task keeps its own settled report"
    );
    assert_eq!(details["handoffCheckpoint"]["generation"], 1);
    assert!(
        !detail.messages.iter().any(|message| message.id == TASK_2),
        "the truncated tail's Task row is gone"
    );
    let raw =
        std::fs::read_to_string(transcript_path(db.data_dir(), &session.id).unwrap()).unwrap();
    assert!(!raw.contains("\"status\":\"running\""));

    // The truncated Task's entry cannot be judged by this rewrite, so it stays
    // for the revision copy that can bring the same call back.
    let sidecar = std::fs::read_to_string(snapshots_file(&db, &session.id)).unwrap();
    assert_eq!(sidecar.lines().count(), 1);
    assert!(sidecar.contains("call-2"));
}

#[test]
fn fork_carries_the_effective_task_report() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let ts = timestamp(0);
    append_message(
        &db,
        &session.id,
        &user_message(ROOT_USER, "root", &ts),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None),
        None,
    )
    .unwrap();
    settle(
        &db,
        &session.id,
        TASK_1,
        "call-1",
        "delegation-1",
        &"r".repeat(300_000),
        &ts,
    );

    let result = fork_session_through(&db, &session.id, Some("fork"), None).unwrap();
    let ForkSessionResult::Created(forked) = result else {
        panic!("the fork must be created");
    };
    let fork_id = forked.summary.id.clone();
    let task = forked
        .messages
        .iter()
        .find(|message| message.tool_name.as_deref() == Some("Task"))
        .expect("the fork carries the Task row");
    let details = task_details(task);
    assert_eq!(details["status"], "completed");
    assert_eq!(
        details["result"].as_str().unwrap().len(),
        300_000,
        "a fork must carry the effective report, not the launch row"
    );
    assert_eq!(details["handoffCheckpoint"]["generation"], 1);
    let mut read = crate::transcripts::read_transcript(db.data_dir(), &fork_id).unwrap();
    transcripts::snapshots::overlay(db.data_dir(), &fork_id, &mut read).unwrap();
    let record = read
        .iter()
        .find(|record| record.tool_name.as_deref() == Some("Task"))
        .expect("the fork transcript carries the Task row");
    assert_eq!(
        record.blocks[0]["result"]["details"]["result"]
            .as_str()
            .unwrap()
            .len(),
        300_000
    );
    assert!(
        !snapshots_file(&db, &fork_id).exists(),
        "the fork must not depend on a sidecar it does not own"
    );
}

#[test]
fn a_full_session_read_recovers_the_report_for_the_taskwait_catalog() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let ts = timestamp(0);
    append_message(
        &db,
        &session.id,
        &task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None),
        None,
    )
    .unwrap();
    settle(
        &db,
        &session.id,
        TASK_1,
        "call-1",
        "delegation-1",
        &"r".repeat(300_000),
        &ts,
    );

    // A recovered TaskWait catalog reads the full session through a process
    // that never saw the snapshot appended.
    crate::transcripts::snapshots::reset_cache_for_tests();
    let full = get_session(&db, &session.id).unwrap().unwrap();
    let task = find_task(&full, TASK_1);
    let details = task_details(task);
    assert_eq!(details["status"], "completed");
    assert_eq!(details["result"].as_str().unwrap().len(), 300_000);
    assert_eq!(details["handoffCheckpoint"]["generation"], 1);

    let unbounded = get_session_with_options(&db, &session.id, options())
        .unwrap()
        .unwrap();
    let task = find_task(&unbounded, TASK_1);
    let details = task_details(task);
    assert_eq!(details["status"], "completed");
    assert_eq!(details["result"].as_str().unwrap().len(), 300_000);
    assert_eq!(details["handoffCheckpoint"]["generation"], 1);
}

#[test]
fn a_revision_switch_does_not_resurrect_another_branchs_overlay() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let ts = timestamp(0);
    let root = user_message(ROOT_USER, "root", &ts);
    let task_a = task_message(
        TASK_1,
        "call-1",
        "delegation-1",
        "running",
        &timestamp(1),
        None,
        None,
    );
    let child_a = child_message(CHILD_2_A, "child a", &timestamp(1), "call-1");
    let branch_a = vec![root.clone(), task_a.clone(), child_a.clone()];
    for message in &branch_a {
        append_message(&db, &session.id, message, None).unwrap();
    }
    settle(
        &db,
        &session.id,
        TASK_1,
        "call-1",
        "delegation-1",
        &"a".repeat(1_024),
        &timestamp(1),
    );
    save_message_revision(&db, &session.id, ROOT_USER, &branch_a, true).unwrap();

    // A second branch replaces the live transcript; its Task settles too. The
    // root carries the pager stamp naming revision 2, which is how a live
    // branch tells the archive which variant it is.
    let mut root_b = root.clone();
    root_b.revision_root_id = Some(ROOT_USER.into());
    root_b.revision_count = Some(2);
    root_b.active_revision = Some(2);
    let task_b = task_message(
        TASK_2,
        "call-2",
        "delegation-2",
        "running",
        &timestamp(2),
        None,
        None,
    );
    let child_b = child_message(CHILD_2_B, "child b", &timestamp(2), "call-2");
    replace_messages(
        &db,
        &session.id,
        &[root_b.clone(), task_b.clone(), child_b.clone()],
    )
    .unwrap();
    settle(
        &db,
        &session.id,
        TASK_2,
        "call-2",
        "delegation-2",
        &"b".repeat(2_048),
        &timestamp(2),
    );

    activate_message_revision(&db, &session.id, ROOT_USER, 1, std::slice::from_ref(&root)).unwrap();

    let restored = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(ids(&restored), vec![ROOT_USER, TASK_1, CHILD_2_A]);
    let task = find_task(&restored, TASK_1);
    let details = task_details(task);
    assert_eq!(details["status"], "completed");
    assert_eq!(
        details["result"].as_str().unwrap(),
        "a".repeat(1_024),
        "the restored branch must show its own settled report"
    );

    let again = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(ids(&again), ids(&restored));
    let task = find_task(&again, TASK_1);
    assert_eq!(
        task_details(task)["result"].as_str().unwrap(),
        "a".repeat(1_024)
    );
}

#[test]
fn a_delegation_scope_without_a_known_chain_reports_no_session() {
    let db = test_db();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let ts = timestamp(0);
    append_message(
        &db,
        &session.id,
        &user_message(ROOT_USER, "root", &ts),
        None,
    )
    .unwrap();
    append_message(
        &db,
        &session.id,
        &task_message(TASK_1, "call-1", "delegation-1", "running", &ts, None, None),
        None,
    )
    .unwrap();

    // A chain whose Task row exists but has produced no child rows yet is a
    // valid, available scope: an empty page with the root Task as context.
    let known = get_session_scoped(
        &db,
        &session.id,
        options(),
        HistoryScope::Delegation {
            id: "delegation-1".into(),
        },
    )
    .unwrap()
    .expect("a known chain is available even with no children");
    assert!(known.messages.is_empty());
    assert_eq!(known.history_context.len(), 1);
    assert_eq!(known.history_context[0].id, TASK_1);
    assert_eq!(
        known.history_scope,
        Some(HistoryScope::Delegation {
            id: "delegation-1".into()
        })
    );

    // Entering by the bare call id names the same chain.
    let by_call = get_session_scoped(
        &db,
        &session.id,
        options(),
        HistoryScope::Delegation {
            id: "call-1".into(),
        },
    )
    .unwrap()
    .expect("a chain resolves by its call id too");
    assert!(by_call.messages.is_empty());
    assert_eq!(by_call.history_context.len(), 1);
    assert_eq!(
        by_call.history_scope,
        Some(HistoryScope::Delegation {
            id: "delegation-1".into()
        })
    );

    // An id that names no Task call at all is an unavailable session, which is
    // distinct from a valid chain that simply has no child rows yet.
    for unknown in ["no-such-delegation", "call-9", "delegation-9"] {
        assert!(
            get_session_scoped(
                &db,
                &session.id,
                options(),
                HistoryScope::Delegation { id: unknown.into() },
            )
            .unwrap()
            .is_none(),
            "{unknown} names no chain and must not read as an empty chain"
        );
    }
}
