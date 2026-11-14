use super::*;
use crate::transcripts::{append_message, transcript_path};
use serde_json::json;
use tempfile::tempdir;

const CREATED_AT: &str = "2026-10-11T00:00:00.000Z";

fn task_record(
    id: &str,
    call_id: &str,
    delegation_id: &str,
    status: &str,
    result_text: &str,
    checkpoint: Option<Value>,
) -> MessageRecord {
    let mut details = json!({
        "delegationId": delegation_id,
        "status": status,
        "result": result_text,
    });
    if let Some(checkpoint) = checkpoint {
        details["handoffCheckpoint"] = checkpoint;
    }
    MessageRecord {
        id: id.into(),
        role: "tool".into(),
        tool_name: Some("Task".into()),
        is_error: false,
        blocks: json!([{
            "type": "tool_call",
            "callId": call_id,
            "name": "Task",
            "args": {"description": "delegate"},
            "result": {"details": details},
            "text": result_text,
        }]),
        meta: Some(json!({ "status": "success" })),
        created_at: CREATED_AT.into(),
    }
}

fn base_task(data_dir: &Path) -> MessageRecord {
    let record = task_record("m-task", "call-1", "delegate-1", "running", "started", None);
    append_message(data_dir, "s1", CREATED_AT, &record).unwrap();
    record
}

fn overlay_one(data_dir: &Path, record: &MessageRecord) -> MessageRecord {
    let mut copy = record.clone();
    overlay(data_dir, "s1", std::slice::from_mut(&mut copy)).unwrap();
    copy
}

fn assert_accept(data_dir: &Path, existing: &MessageRecord, incoming: &MessageRecord) {
    accept(data_dir, "s1", existing, incoming, CREATED_AT).unwrap();
}

#[test]
fn snapshots_leave_the_transcript_prefix_and_layout_untouched() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let before_bytes = fs::read(transcript_path(dir.path(), "s1").unwrap()).unwrap();
    let before_layout =
        crate::transcripts::layout::refresh_layout(dir.path(), "s1", Default::default()).unwrap();

    let progress = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "running",
        "child turn 1",
        None,
    );
    assert_accept(dir.path(), &base, &progress);
    let observed = overlay_one(dir.path(), &base);
    assert_eq!(observed.blocks[0]["text"], "child turn 1");

    let after_bytes = fs::read(transcript_path(dir.path(), "s1").unwrap()).unwrap();
    assert_eq!(
        before_bytes, after_bytes,
        "the immutable transcript prefix must not move"
    );
    let after_layout =
        crate::transcripts::layout::refresh_layout(dir.path(), "s1", Default::default()).unwrap();
    assert_eq!(after_layout.message_count(), before_layout.message_count());
    assert_eq!(after_layout.file_len, before_layout.file_len);
    assert_eq!(after_layout.message_offsets, before_layout.message_offsets);
}

#[test]
fn completed_snapshot_keeps_the_runtime_checkpoint_losslessly() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let progress = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "running",
        "child turn 1",
        Some(json!({
            "generation": 1,
            "summary": "context replaced",
            "systemPrompt": "x".repeat(1_048_576),
        })),
    );
    assert_accept(dir.path(), &base, &progress);
    let running = overlay_one(dir.path(), &base);
    let completed = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        "final report",
        Some(json!({
            "generation": 1,
            "summary": "context replaced",
            "systemPrompt": "x".repeat(1_048_576),
        })),
    );
    assert_accept(dir.path(), &running, &completed);
    let observed = overlay_one(dir.path(), &base);
    assert_eq!(
        observed.blocks[0]["result"]["details"]["status"],
        "completed"
    );
    assert_eq!(observed.blocks[0]["text"], "final report");
    let checkpoint = &observed.blocks[0]["result"]["details"]["handoffCheckpoint"];
    assert_eq!(
        checkpoint["systemPrompt"].as_str().unwrap().len(),
        1_048_576,
        "the checkpoint must not be capped by a display limit"
    );
}

#[test]
fn a_settled_delegation_never_reopens() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let completed = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        "final report",
        None,
    );
    assert_accept(dir.path(), &base, &completed);
    let settled = overlay_one(dir.path(), &base);
    let late = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "running",
        "late progress",
        None,
    );
    assert_accept(dir.path(), &settled, &late);
    let observed = overlay_one(dir.path(), &base);
    assert_eq!(
        observed.blocks[0]["result"]["details"]["status"],
        "completed"
    );
    assert_eq!(snapshot_line_count(dir.path(), "s1"), 1);
}

#[test]
fn identical_snapshot_content_does_not_churn_the_sidecar() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let completed = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        "final report",
        None,
    );
    assert_accept(dir.path(), &base, &completed);
    let settled = overlay_one(dir.path(), &base);
    let duplicate = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        "final report",
        None,
    );
    assert_accept(dir.path(), &settled, &duplicate);
    assert_eq!(snapshot_line_count(dir.path(), "s1"), 1);
}

#[test]
fn snapshots_match_call_id_and_delegation_id() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let other_call = task_record(
        "m-task",
        "call-2",
        "delegate-1",
        "running",
        "wrong call",
        None,
    );
    assert_accept(dir.path(), &base, &other_call);
    let other_delegation = task_record(
        "m-task",
        "call-1",
        "delegate-2",
        "running",
        "wrong delegation",
        None,
    );
    assert_accept(dir.path(), &base, &other_delegation);
    assert!(!snapshot_path(dir.path(), "s1").unwrap().exists());
}

#[test]
fn restart_recovery_and_torn_tail_are_recovered_append_only() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let progress = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "running",
        "child turn 1",
        None,
    );
    assert_accept(dir.path(), &base, &progress);
    reset_cache_for_tests();
    let observed = overlay_one(dir.path(), &base);
    assert_eq!(observed.blocks[0]["text"], "child turn 1");

    // A crash mid-append leaves a partial line; it must not be applied, and a
    // later append must terminate it rather than fuse with it.
    let path = snapshot_path(dir.path(), "s1").unwrap();
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    use std::io::Write;
    file.write_all(br#"{"type":"snapshot","schema":1"#).unwrap();
    drop(file);
    reset_cache_for_tests();
    let observed = overlay_one(dir.path(), &base);
    assert_eq!(observed.blocks[0]["text"], "child turn 1");

    let completed = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        "final report",
        None,
    );
    assert_accept(dir.path(), &observed, &completed);
    reset_cache_for_tests();
    let observed = overlay_one(dir.path(), &base);
    assert_eq!(
        observed.blocks[0]["result"]["details"]["status"],
        "completed"
    );
    assert_eq!(snapshot_line_count(dir.path(), "s1"), 3);
}

#[test]
fn discard_removes_the_sidecar_and_its_cache() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let progress = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "running",
        "child turn 1",
        None,
    );
    assert_accept(dir.path(), &base, &progress);
    assert!(overlay_one(dir.path(), &base).blocks[0]["text"] == "child turn 1");
    discard(dir.path(), "s1").unwrap();
    assert!(!snapshot_path(dir.path(), "s1").unwrap().exists());
    assert_eq!(overlay_one(dir.path(), &base).blocks[0]["text"], "started");
}

#[test]
fn a_legacy_in_place_task_row_is_read_unchanged() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let observed = overlay_one(dir.path(), &base);
    assert_eq!(
        serde_json::to_value(&observed).unwrap(),
        serde_json::to_value(&base).unwrap()
    );
}

#[test]
fn transcript_rewrite_discards_the_superseded_sidecar() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let progress = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "running",
        "child turn 1",
        None,
    );
    assert_accept(dir.path(), &base, &progress);
    crate::transcripts::write_transcript(dir.path(), "s1", CREATED_AT, std::slice::from_ref(&base))
        .unwrap();
    assert!(
        !snapshot_path(dir.path(), "s1").unwrap().exists(),
        "a rewrite must not leave a snapshot able to resurrect"
    );
}

#[test]
fn snapshot_file_length_cache_advances_only_over_complete_lines() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let progress = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "running",
        "child turn 1",
        None,
    );
    assert_accept(dir.path(), &base, &progress);
    assert_eq!(
        snapshot_file_len(dir.path(), "s1"),
        fs::metadata(snapshot_path(dir.path(), "s1").unwrap())
            .unwrap()
            .len()
    );
}

#[test]
fn an_in_place_settlement_from_an_older_build_wins_over_the_sidecar() {
    let dir = tempdir().unwrap();
    let base = base_task(dir.path());
    let progress = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "running",
        "child turn 1",
        None,
    );
    assert_accept(dir.path(), &base, &progress);
    assert_eq!(
        overlay_one(dir.path(), &base).blocks[0]["text"],
        "child turn 1"
    );
    // An older build splices the settlement into the launch line instead of
    // appending it, and knows nothing about the sidecar. That in-place row is
    // newer evidence than the snapshot written before it.
    let settled = task_record("m-task", "call-1", "delegate-1", "completed", "done", None);
    assert!(
        crate::transcripts::update_message(dir.path(), "s1", &settled).unwrap(),
        "the launch line is still present"
    );
    let mut current = crate::transcripts::read_transcript(dir.path(), "s1")
        .unwrap()
        .pop()
        .unwrap();
    overlay(dir.path(), "s1", std::slice::from_mut(&mut current)).unwrap();
    assert_eq!(
        current.blocks[0]["result"]["details"]["status"],
        "completed"
    );
    assert_eq!(current.blocks[0]["text"], "done");
}

fn user_record(id: &str, text: &str) -> MessageRecord {
    MessageRecord {
        id: id.into(),
        role: "user".into(),
        tool_name: None,
        is_error: false,
        blocks: json!([{ "type": "text", "text": text }]),
        meta: None,
        created_at: CREATED_AT.into(),
    }
}

/// Every message line of the physical transcript, as raw JSON.
fn raw_message_rows(data_dir: &Path) -> Vec<Value> {
    fs::read_to_string(transcript_path(data_dir, "s1").unwrap())
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value["type"] == "message")
        .collect()
}

fn row<'a>(rows: &'a [Value], id: &str) -> &'a Value {
    rows.iter()
        .find(|row| row["id"] == id)
        .unwrap_or_else(|| panic!("{id} must survive the rewrite"))
}

#[test]
fn a_rewrite_keeps_a_settled_report_and_checkpoint_through_an_unrelated_edit() {
    let dir = tempdir().unwrap();
    append_message(
        dir.path(),
        "s1",
        CREATED_AT,
        &user_record("u-before", "before"),
    )
    .unwrap();
    let launch = base_task(dir.path());
    append_message(
        dir.path(),
        "s1",
        CREATED_AT,
        &user_record("u-after", "after"),
    )
    .unwrap();

    let report = "r".repeat(200_000);
    let settled = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        &report,
        Some(json!({ "generation": 1, "summary": "context replaced" })),
    );
    assert_accept(dir.path(), &launch, &settled);
    assert_eq!(snapshot_line_count(dir.path(), "s1"), 1);

    // An unrelated user edit rewrites the whole transcript. The settled Task
    // row is not touched by it, so its report and checkpoint must travel with
    // the rewrite instead of being dropped with the sidecar.
    crate::transcripts::write_transcript(
        dir.path(),
        "s1",
        CREATED_AT,
        &[
            user_record("u-before", "edited before"),
            launch.clone(),
            user_record("u-after", "edited after"),
        ],
    )
    .unwrap();

    let rows = raw_message_rows(dir.path());
    let task = row(&rows, "m-task");
    let details = &task["blocks"][0]["result"]["details"];
    assert_eq!(details["status"], "completed");
    assert_eq!(
        details["result"].as_str().unwrap().len(),
        200_000,
        "the settled report must stay byte complete in the transcript"
    );
    assert_eq!(
        task["blocks"][0]["text"].as_str().unwrap().len(),
        200_000,
        "the tool text the parent reads back must stay complete"
    );
    assert_eq!(details["handoffCheckpoint"]["generation"], 1);
    assert_eq!(row(&rows, "u-before")["blocks"][0]["text"], "edited before");
    assert_eq!(row(&rows, "u-after")["blocks"][0]["text"], "edited after");
    assert!(
        !snapshot_path(dir.path(), "s1").unwrap().exists(),
        "the folded entry must be pruned after the rewrite"
    );

    let mut read = crate::transcripts::read_transcript(dir.path(), "s1").unwrap();
    overlay(dir.path(), "s1", &mut read).unwrap();
    let task = read.iter().find(|record| record.id == "m-task").unwrap();
    assert_eq!(task.blocks[0]["result"]["details"]["status"], "completed");
    assert_eq!(
        task.blocks[0]["result"]["details"]["result"]
            .as_str()
            .unwrap()
            .len(),
        200_000
    );
}

#[test]
fn an_explicit_edit_of_the_task_row_is_not_overwritten_by_its_overlay() {
    let dir = tempdir().unwrap();
    let launch = base_task(dir.path());
    let settled = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        "final report",
        None,
    );
    assert_accept(dir.path(), &launch, &settled);

    // The caller hands in content that matches neither the launch row nor the
    // snapshot: that is an explicit edit, and it wins over the overlay.
    let edited = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "failed",
        "caller text",
        None,
    );
    crate::transcripts::write_transcript(
        dir.path(),
        "s1",
        CREATED_AT,
        std::slice::from_ref(&edited),
    )
    .unwrap();

    let rows = raw_message_rows(dir.path());
    assert_eq!(rows.len(), 1);
    assert_eq!(
        row(&rows, "m-task")["blocks"][0]["result"]["details"]["status"],
        "failed"
    );
    assert_eq!(row(&rows, "m-task")["blocks"][0]["text"], "caller text");
    assert!(!snapshot_path(dir.path(), "s1").unwrap().exists());

    let mut read = crate::transcripts::read_transcript(dir.path(), "s1").unwrap();
    overlay(dir.path(), "s1", &mut read).unwrap();
    assert_eq!(read[0].blocks[0]["result"]["details"]["status"], "failed");
}

#[test]
fn a_rewrite_that_drops_the_task_row_keeps_its_overlay_for_a_later_restore() {
    let dir = tempdir().unwrap();
    let launch = base_task(dir.path());
    let report = "r".repeat(200_000);
    let settled = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        &report,
        Some(json!({ "generation": 1, "summary": "context replaced" })),
    );
    assert_accept(dir.path(), &launch, &settled);

    // The rewrite does not carry this Task call at all (a truncated tail, a
    // revision switch to another family), so it cannot judge the entry.
    crate::transcripts::write_transcript(
        dir.path(),
        "s1",
        CREATED_AT,
        &[user_record("u-only", "only")],
    )
    .unwrap();
    assert_eq!(
        snapshot_line_count(dir.path(), "s1"),
        1,
        "an entry the rewrite cannot judge is retained, not destroyed"
    );

    // Restoring the same Task call still reads as settled.
    crate::transcripts::write_transcript(
        dir.path(),
        "s1",
        CREATED_AT,
        std::slice::from_ref(&launch),
    )
    .unwrap();
    let mut read = crate::transcripts::read_transcript(dir.path(), "s1").unwrap();
    overlay(dir.path(), "s1", &mut read).unwrap();
    assert_eq!(
        read[0].blocks[0]["result"]["details"]["status"],
        "completed"
    );
    assert_eq!(
        read[0].blocks[0]["result"]["details"]["result"]
            .as_str()
            .unwrap()
            .len(),
        200_000
    );
    assert_eq!(snapshot_line_count(dir.path(), "s1"), 1);
}

#[test]
fn a_newer_schema_line_survives_a_rewrite_it_cannot_be_applied_by() {
    let dir = tempdir().unwrap();
    let launch = base_task(dir.path());
    let settled = task_record(
        "m-task",
        "call-1",
        "delegate-1",
        "completed",
        "final report",
        None,
    );
    assert_accept(dir.path(), &launch, &settled);

    // A newer build wrote a line this build does not interpret. It is data for
    // that build to recover, and a cleanup path must not delete it.
    let path = snapshot_path(dir.path(), "s1").unwrap();
    let line = crate::transcripts::tagged(
        "snapshot",
        &SnapshotLine {
            schema: SNAPSHOT_SCHEMA + 1,
            session_id: "s1".into(),
            saved_at: CREATED_AT.into(),
            call_id: "call-1".into(),
            delegation_id: "delegate-1".into(),
            message: settled.clone(),
        },
    )
    .unwrap();
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(line.as_bytes()).unwrap();
        file.write_all(b"\n").unwrap();
    }

    crate::transcripts::write_transcript(
        dir.path(),
        "s1",
        CREATED_AT,
        std::slice::from_ref(&launch),
    )
    .unwrap();

    let raw = fs::read_to_string(&path).unwrap();
    assert_eq!(raw.lines().count(), 1);
    assert!(
        raw.contains("\"schema\":2"),
        "the uninterpretable line must be copied back verbatim: {raw}"
    );
    assert!(!raw.contains("\"schema\":1"));
    assert_eq!(
        row(&raw_message_rows(dir.path()), "m-task")["blocks"][0]["result"]["details"]["status"],
        "completed"
    );
}
