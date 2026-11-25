import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertToolSuccess, shortJson } from "./assert.mjs";

/** Real Write/Edit/review/rollback path for valid UTF-8 containing NUL. */
export async function exerciseNulReview(host, workspace, sessionId) {
  const path = "nul.txt";
  const target = join(workspace, path);
  const baseline = Buffer.from("before\0bytes\n", "utf8");
  await writeFile(target, baseline);

  const written = await host.call(
    "tools.execute",
    {
      sessionId,
      toolCallId: "write-nul",
      toolName: "Write",
      // JSON serialization carries this as content "\u0000".
      args: { path, content: "first\0line\n" },
      mode: "agent",
    },
    20_000,
  );
  assertToolSuccess(written, "write-nul");
  assert.equal(await readFile(target, "utf8"), "first\0line\n");
  assert.equal(written.content?.review?.binary, undefined);
  assert.equal(written.content?.review?.additions, 1);
  assert.equal(written.content?.review?.deletions, 1);
  assert.equal(written.content?.editDiff?.binary, undefined);

  const edited = await host.call(
    "tools.execute",
    {
      sessionId,
      toolCallId: "edit-nul",
      toolName: "Edit",
      args: {
        path,
        tag: written.content.tag,
        ops: "PUT 1.=1:\n+first\0changed\n",
      },
      mode: "agent",
    },
    20_000,
  );
  assertToolSuccess(edited, "edit-nul");
  assert.equal(await readFile(target, "utf8"), "first\0changed\n");
  for (const preview of [edited.content?.review, edited.content?.editDiff]) {
    assert(
      preview?.binary === undefined &&
        preview.additions === 1 &&
        preview.deletions === 1 &&
        preview.hunks?.[0]?.lines?.some(
          (line) => line.type === "add" && line.text === "first\0changed",
        ),
      "NUL edit lost text counts or raw hunk bytes: " + shortJson(preview),
    );
  }

  const session = await host.call("review.files", { sessionId });
  const row = (session.files ?? []).find((file) => file.path === path);
  assert(
    row?.binary === undefined &&
      row.additions === 1 &&
      row.deletions === 1 &&
      row.hunks?.[0]?.lines?.some(
        (line) => line.type === "add" && line.text === "first\0changed",
      ),
    "session Review did not recompute NUL as text: " + shortJson(row),
  );

  const rolledBack = await host.call("review.rollbackFile", { sessionId, path });
  assert.equal(rolledBack.status, "rolledBack", shortJson(rolledBack));
  assert.deepEqual(await readFile(target), baseline, "rollback changed NUL bytes");
  return { edit: edited.content, session };
}
