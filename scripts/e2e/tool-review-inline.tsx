import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { type ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { buildSubagentTranscript } from "../../apps/desktop/src/lib/subagent-transcript";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";

declare global {
  var toolReviewProbe: (payloads: ToolReviewPayloads) => Promise<unknown>;
}

/** The `content` the host returned for one real `tools.execute` call. */
type HostContent = Record<string, unknown>;

type ToolReviewPayloads = {
  /** A real workspace `Edit`. */
  edit: HostContent;
  /** A real workspace `Write` that created its file. */
  write: HostContent;
  /** The same real `Edit` record as hosts persisted it before the contract. */
  legacyEdit: HostContent;
  /** The same real `Edit` record with an operation no contract names. */
  unknownOperation: HostContent;
  /** A real `Edit` the host applied from a superseded tag, with a warning. */
  warned: HostContent;
  /** A real `Edit` that moved the file (`MV`). */
  moved: HostContent;
  /** A real `Edit` that deleted the file (`REM`). */
  removed: HostContent;
};

const createdAt = "2026-10-18T00:00:00.000Z";
const DELEGATION_ID = "delegation-1";
const DELEGATION_CALL_ID = "call-delegation-1";

type Probe = {
  failures: string[];
  observed: Record<string, unknown>;
};

const settle = async (ticks = 4) => {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};

/**
 * The tool message the transcript receives for a real host result: the runtime
 * hands `tools.execute`'s `content` over as the tool result's `details`
 * (`packages/agent-runtime/src/runtime.ts`), and the session projection stores
 * that result on the message (`native-pi-session.uiMessage`). Nothing here
 * reshapes the host's review record.
 */
function toolMessageFromContent(
  id: string,
  toolName: string,
  content: HostContent,
  extra: Partial<UiMessage> = {},
  args: Record<string, unknown> = {},
): UiMessage {
  const text = JSON.stringify(content, null, 2);
  return {
    id,
    role: "tool",
    content: text,
    createdAt,
    status: "complete",
    toolName,
    toolCallId: `call-${id}`,
    // The arguments the call was made with, when the row's body must not print
    // them back: `ops` is how the mutation was requested, not what it did.
    toolArgs: { path: String(content.path ?? ""), ...args },
    toolStatus: "success",
    toolResult: { content: [{ type: "text", text }], details: content },
    ...extra,
  };
}

/** The `Task` call that opens the delegate's turn. */
const delegationStart: UiMessage = {
  id: "task-start",
  role: "tool",
  content: "Delegation started",
  createdAt,
  status: "complete",
  toolName: "Task",
  toolCallId: DELEGATION_CALL_ID,
  toolArgs: { agent: "worker", task: "Edit the workspace source file" },
  toolStatus: "success",
  toolResult: {
    details: { delegationId: DELEGATION_ID, agent: "worker", status: "running" },
  },
};

function delegateRow(
  id: string,
  toolName: string,
  content: HostContent,
): UiMessage {
  return toolMessageFromContent(id, toolName, content, {
    parentToolCallId: DELEGATION_CALL_ID,
    agentName: "worker",
  });
}

function countsText(host: HTMLElement): string {
  return (
    host.querySelector<HTMLElement>(".tool-row-header > .review-change-card-counts")
      ?.textContent ?? ""
  );
}

async function expand(host: HTMLElement) {
  const header = host.querySelector<HTMLElement>(".tool-row-header");
  if (!header) throw new Error("no tool row header rendered");
  header.click();
  await settle(2);
}

globalThis.toolReviewProbe = async (payloads: ToolReviewPayloads) => {
  const probe: Probe = { failures: [], observed: {} };
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) probe.observed[name] = detail ?? true;
    else probe.failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
  };

  const renderErrors: unknown[] = [];
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  const stage = document.createElement("div");
  stage.id = "stage";
  stage.style.cssText =
    "display:flex;gap:16px;align-items:flex-start;padding:12px";
  const column = document.createElement("div");
  column.style.width = "900px";
  stage.append(column);
  document.body.append(stage);

  const roots: Array<{ unmount: () => void }> = [];
  const mount = (container: HTMLElement, node: ReactNode) => {
    const host = document.createElement("div");
    container.append(host);
    const root = createRoot(host, {
      onUncaughtError: (error: unknown) => renderErrors.push(error),
    });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptDisclosureProvider>{node}</TranscriptDisclosureProvider>
        </I18nextProvider>,
      ),
    );
    roots.push(root);
    return host;
  };

  try {
    // ── 1. The main transcript, from the real payloads ──
    // The rows reach the transcript exactly as the session stores them: the
    // real host `content` is the tool result's details.
    const writeMessage = toolMessageFromContent(
      "write-created",
      "Write",
      payloads.write,
    );
    const editMessage = toolMessageFromContent(
      "edit-source",
      "Edit",
      payloads.edit,
    );
    const turnHost = mount(
      column,
      <AssistantTurn
        entry={
          buildTranscriptEntries([writeMessage, editMessage]).entries.find(
            (entry) => entry.kind === "assistant-turn",
          ) as never
        }
        isActive={false}
      />,
    );
    await settle();
    const writeRow = turnHost.querySelector<HTMLElement>(
      '.tool-row[data-message-id="write-created"]',
    );
    const editRow = turnHost.querySelector<HTMLElement>(
      '.tool-row[data-message-id="edit-source"]',
    );
    check(
      "the main transcript renders one row per real mutation",
      Boolean(writeRow && editRow),
      {
        write: Boolean(writeRow),
        edit: Boolean(editRow),
      },
    );

    // The header's own +a/−d, read from the real record.
    const writeCounts = writeRow ? countsText(writeRow) : "";
    const editCounts = editRow ? countsText(editRow) : "";
    check(
      "a real Write row states its +additions",
      writeCounts.includes("+2"),
      writeCounts,
    );
    check(
      "a real Edit row states +a and −d",
      editCounts.includes("+1") && editCounts.includes("−1"),
      editCounts,
    );

    // The row still prints the file it changed.
    const writeSummary = writeRow?.querySelector<HTMLElement>(
      ".tool-row-summary",
    );
    check(
      "the mutation row keeps its file name",
      Boolean(writeSummary?.textContent?.endsWith("created.txt")),
      writeSummary?.textContent,
    );

    // Expanding hosts the record's own diff.
    if (writeRow) {
      await expand(writeRow);
      const writeAdds = writeRow.querySelectorAll(
        ".review-change-diff .diff-line.add",
      ).length;
      const writeDels = writeRow.querySelectorAll(
        ".review-change-diff .diff-line.del",
      ).length;
      check(
        "expanding the real Write row shows its added lines",
        writeAdds === 2 && writeDels === 0,
        { writeAdds, writeDels },
      );
    }
    if (editRow) {
      await expand(editRow);
      const editAdds = editRow.querySelectorAll(
        ".review-change-diff .diff-line.add",
      ).length;
      const editDels = editRow.querySelectorAll(
        ".review-change-diff .diff-line.del",
      ).length;
      check(
        "expanding the real Edit row shows its one-line diff",
        editAdds === 1 && editDels === 1,
        { editAdds, editDels },
      );
    }

    // ── 2. The delegation surface ──
    // The same real records after the production delegate conversion, rendered
    // by the same row the subagent tab mounts.
    const subagentMessages = [
      delegationStart,
      delegateRow("sub-write", "Write", payloads.write),
      delegateRow("sub-edit", "Edit", payloads.edit),
      delegateRow("sub-legacy-edit", "Edit", payloads.legacyEdit),
    ];
    const transcript = buildSubagentTranscript(
      subagentMessages,
      DELEGATION_ID,
    );
    const turns = transcript?.turns ?? [];
    const rows = turns.flatMap((turn) => turn.rows);
    const toolRows = rows.filter((row) => row.kind === "tool");
    check(
      "the delegate transcript keeps every real mutation row",
      turns.length === 1 && toolRows.length === 3,
      { turns: turns.length, toolRows: toolRows.length },
    );

    const subagentList = document.createElement("div");
    subagentList.className = "subagent-transcript-list";
    column.append(subagentList);
    const subagentHosts: HTMLElement[] = [];
    const subagentMessagesById = new Map<string, UiMessage>();
    for (const row of toolRows) {
      if (row.kind !== "tool") continue;
      subagentMessagesById.set(row.message.id, row.message);
      // Exactly what `SubagentTranscriptTab` mounts for a delegate tool row.
      subagentHosts.push(mount(subagentList, <ToolRow message={row.message} />));
    }
    await settle();
    const subCounts = subagentHosts.map((host) => countsText(host));
    check(
      "the delegate Write row states its +additions",
      subCounts[0]?.includes("+2") === true,
      subCounts[0],
    );
    check(
      "the delegate Edit row states +a and −d",
      subCounts[1]?.includes("+1") === true &&
        subCounts[1]?.includes("−1") === true,
      subCounts[1],
    );
    // A tool message persisted while hosts still wrote `"operation":"Edit"`
    // carries that spelling forever; it must render its counts now too.
    check(
      "a delegate row persisted with the old operation spelling still counts",
      subagentMessagesById.get("sub-legacy-edit") !== undefined &&
        subCounts[2]?.includes("+1") === true &&
        subCounts[2]?.includes("−1") === true,
      { counts: subCounts[2], row: Boolean(subagentHosts[2]) },
    );

    const subagentDiffs: Array<{ adds: number; dels: number }> = [];
    for (const host of subagentHosts) {
      await expand(host);
      subagentDiffs.push({
        adds: host.querySelectorAll(".review-change-diff .diff-line.add").length,
        dels: host.querySelectorAll(".review-change-diff .diff-line.del").length,
      });
    }
    check(
      "each delegate mutation row hosts its own diff",
      subagentDiffs[0]?.adds === 2 &&
        subagentDiffs[0]?.dels === 0 &&
        subagentDiffs[1]?.adds === 1 &&
        subagentDiffs[1]?.dels === 1 &&
        subagentDiffs[2]?.adds === 1 &&
        subagentDiffs[2]?.dels === 1,
      subagentDiffs,
    );

    // The record is still actionable: a row persisted with the old spelling
    // keeps its rollback handle, not only its counts.
    check(
      "a delegate row persisted with the old operation spelling keeps its rollback",
      Boolean(subagentHosts[2]?.querySelector(".review-change-rollback")),
      Boolean(subagentHosts[2]?.querySelector(".review-change-rollback")),
    );

    // ── 3. A reviewed mutation's body is its own diff ──
    // The rows a workspace `Edit` produces in every shape it can take: a
    // modify that carried a warning, a move and a delete. Each is mounted from
    // the real host record, expanded, and read as a reader reads it.
    const reviewedRows: Array<{
      id: string;
      label: string;
      content: HostContent;
      args: Record<string, unknown>;
      warning: string | null;
    }> = [
      {
        id: "edit-warned",
        label: "the modify that carried a warning",
        content: payloads.warned,
        args: {
          path: "source.txt",
          tag: "0000",
          ops: "PUT >$:\n+TAIL\n",
        },
        warning: String(
          (payloads.warned.warnings as unknown[] | undefined)?.[0] ?? "",
        ),
      },
      {
        id: "edit-moved",
        label: "the move",
        content: payloads.moved,
        args: { path: "source.txt", tag: "0000", ops: 'MV "moved.txt"\n' },
        warning: null,
      },
      {
        id: "edit-removed",
        label: "the delete",
        content: payloads.removed,
        args: { path: "created.txt", tag: "0000", ops: "REM\n" },
        warning: null,
      },
    ];
    for (const entry of reviewedRows) {
      const host = mount(
        column,
        <ToolRow
          message={toolMessageFromContent(
            entry.id,
            "Edit",
            entry.content,
            {},
            entry.args,
          )}
        />,
      );
      await settle();
      await expand(host);
      await settle(1);
      const body = host.querySelector<HTMLElement>(".tool-row-body");
      const blocks = host.querySelectorAll(".tool-block");
      const sectionHeads = [...host.querySelectorAll(".tool-row-section-head")].map(
        (head) => head.textContent ?? "",
      );
      const raw = host.querySelector(".tool-raw");
      const fields = host.querySelector(".tool-fields");
      const diffLines = host.querySelectorAll(
        ".review-change-diff .diff-line.add, .review-change-diff .diff-line.del",
      ).length;
      check(
        `${entry.label} keeps its diff as the body`,
        countsText(host).length > 0 && diffLines > 0,
        { counts: countsText(host), diffLines },
      );
      check(
        `${entry.label} prints no raw payload, no field dump and no ops`,
        raw === null &&
          fields === null &&
          !(body?.textContent ?? "").includes("REM") &&
          !(body?.textContent ?? "").includes("MV ") &&
          !(body?.textContent ?? "").includes("PUT >"),
        {
          raw: Boolean(raw),
          fields: Boolean(fields),
          body: (body?.textContent ?? "").slice(0, 200),
        },
      );
      if (entry.warning) {
        // The host's own warning is the one thing the body still owes.
        check(
          `${entry.label} keeps the host's warning`,
          blocks.length === 1 &&
            sectionHeads.length === 1 &&
            (body?.textContent ?? "").includes(entry.warning),
          { blocks: blocks.length, sectionHeads, warning: entry.warning },
        );
      } else {
        check(
          `${entry.label} adds no section above the diff`,
          blocks.length === 0 && sectionHeads.length === 0,
          { blocks: blocks.length, sectionHeads },
        );
      }
    }

    // ── 4. Anything the record does not prove states nothing ──
    const unknownHost = mount(
      column,
      <ToolRow
        message={toolMessageFromContent(
          "unknown-operation",
          "Edit",
          payloads.unknownOperation,
        )}
      />,
    );
    const failedHost = mount(
      column,
      <ToolRow
        message={toolMessageFromContent("failed-edit", "Edit", payloads.edit, {
          toolStatus: "error",
          isError: true,
        })}
      />,
    );
    await settle();
    await expand(unknownHost);
    await expand(failedHost);
    check(
      "an unknown operation invents neither counts nor a diff",
      countsText(unknownHost) === "" &&
        unknownHost.querySelectorAll(".review-change-diff .diff-line").length ===
          0,
      {
        counts: countsText(unknownHost),
        lines: unknownHost.querySelectorAll(".review-change-diff .diff-line")
          .length,
      },
    );
    check(
      "a failed call invents neither counts nor a diff",
      countsText(failedHost) === "" &&
        failedHost.querySelectorAll(".review-change-diff .diff-line").length ===
          0,
      {
        counts: countsText(failedHost),
        lines: failedHost.querySelectorAll(".review-change-diff .diff-line")
          .length,
      },
    );

    stage.scrollIntoView({ block: "start" });
    await settle(2);
    check("no render error escaped", renderErrors.length === 0, renderErrors.length);
  } catch (error) {
    probe.failures.push(
      `probe threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }

  for (const root of roots) root.unmount();
  return {
    ok: probe.failures.length === 0,
    failures: probe.failures,
    observed: probe.observed,
  };
};
