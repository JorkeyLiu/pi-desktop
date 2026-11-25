import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  knownDiffLineCounts,
  type DiffHunk,
  type DiffFile,
  type FsEntry,
  type FsReadResult,
  type ReviewDiffReason,
  type SessionSummary,
  type WorkspaceDiff,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { createDiffDisplayBudget } from "../../lib/diff-display";
import { DiffDisplayLimit, renderDiffLine } from "../DiffText";
import { sessionAllows } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { Button, SegmentedControl } from "../ui";
import "../../styles/remote-mvp.css";

/**
 * The review vocabulary already owns one honest sentence per limit; the
 * remote Review tab reuses it instead of inventing a parallel set, and the
 * exhaustive record keeps a new reason from silently rendering nothing.
 */
const REVIEW_LIMIT_KEYS: Record<ReviewDiffReason, string> = {
  fileTooLarge: "panel.review.limit.fileTooLarge",
  diffTooComplex: "panel.review.limit.diffTooComplex",
  diffTooLarge: "panel.review.tooLarge",
  baselineUnavailable: "panel.review.limit.baselineUnavailable",
  unreadable: "panel.review.limit.unreadable",
  workspaceUnavailable: "panel.review.limit.workspaceUnavailable",
  requestBudgetExceeded: "panel.review.limit.requestBudgetExceeded",
};

/** Why this file's line evidence is limited, or `null` when it is complete. */
function diffFileLimitKey(file: DiffFile): string | null {
  if (file.reason) return REVIEW_LIMIT_KEYS[file.reason];
  return file.tooLarge ? "panel.review.tooLarge" : null;
}

export function RemoteDiffHunks({ hunks }: { hunks: DiffHunk[] }) {
  const budget = createDiffDisplayBudget();
  return (
    <>
      <pre>
        {hunks.map((hunk, hunkIndex) => {
          const header = renderDiffLine(
            hunkIndex > 0 ? "\n" : "",
            hunk.header,
            budget,
          );
          if (!header) return null;
          return (
            <Fragment key={`${hunk.header}-${hunkIndex}`}>
              {header.prefix}
              {header.text}
              {hunk.lines.map((line, lineIndex) => {
                const sign =
                  line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
                const body = renderDiffLine(`\n${sign}`, line.text, budget);
                if (!body) return null;
                return (
                  <Fragment key={lineIndex}>
                    {body.prefix}
                    {body.text}
                  </Fragment>
                );
              })}
            </Fragment>
          );
        })}
      </pre>
      <DiffDisplayLimit budget={budget} />
    </>
  );
}
export function RemoteWorkspace({ session, width, exiting, onExitAnimationEnd }: {
  session: SessionSummary; width: number; exiting?: boolean; onExitAnimationEnd?: () => void;
}) {
  const { t } = useTranslation("remote");
  const { t: tApp } = useTranslation();
  const [tab, setTab] = useState<"files" | "review">("files");
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [file, setFile] = useState<{ path: string; read: FsReadResult } | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const current = (request: number) => alive.current && generation.current === request
    && useAppStore.getState().activeSessionId === session.id;
  useEffect(() => {
    const request = ++generation.current;
    if (!sessionAllows(session, "canReadWorkspace")) return;
    setBusy(true); setError(null); setFile(null); setEntries([]); setDiff(null);
    const read = async () => {
      try {
        if (tab === "files") {
          const result = await api.remoteWorkspaceList(session.id, directory);
          if (current(request)) setEntries(result.entries);
        } else {
          const result = await api.remoteWorkspaceDiff(session.id);
          if (current(request)) setDiff(result);
        }
      } catch (caught) { if (current(request)) setError(caught instanceof Error ? caught.message : String(caught)); }
      finally { if (current(request)) setBusy(false); }
    };
    void read();
    return () => { generation.current++; };
  }, [session.id, session.capabilities?.canReadWorkspace, directory, tab, revision]);
  const open = async (entry: FsEntry) => {
    if (busy || !sessionAllows(session, "canReadWorkspace") || useAppStore.getState().activeSessionId !== session.id) return;
    if (!entry.name || /[/\\\0]/.test(entry.name) || entry.name === "." || entry.name === "..") return;
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.kind === "dir") { setDirectory(path); return; }
    const request = ++generation.current;
    setBusy(true); setError(null); setFile(null);
    try {
      const read = await api.remoteWorkspaceRead(session.id, path);
      if (current(request)) setFile({ path, read });
    } catch (caught) { if (current(request)) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (current(request)) setBusy(false); }
  };
  return (
    <aside className={`work-panel remote-workspace${exiting ? " is-exiting" : ""}`}
      style={{ "--work-panel-width": `${width}px` } as CSSProperties}
      onAnimationEnd={(event) => { if (event.target === event.currentTarget && exiting) onExitAnimationEnd?.(); }}
      aria-label={t("workspace")}>
      <div className="remote-actions">
        <SegmentedControl value={tab} onChange={setTab} label={t("workspace")}
          options={[{ value: "files", label: t("files") }, { value: "review", label: t("review") }]} />
        <Button variant="ghost" disabled={busy} onClick={() => setRevision((value) => value + 1)}>{t("refresh")}</Button>
        <Button variant="ghost" onClick={() => useAppStore.getState().collapseWorkPanel()}>{t("close")}</Button>
      </div>
      <p className="remote-hint">{t("identity", { host: session.remoteHostLabel ?? session.remoteHostKey, workspace: session.remoteWorkspaceLabel ?? t("workspace") })}</p>
      <div className="remote-workspace-content" aria-busy={busy}>
        {!sessionAllows(session, "canReadWorkspace") && <p>{t("readOnly")}</p>}
        {busy && <p role="status">{t("loading")}</p>}
        {error && <p role="alert">{error}</p>}
        {tab === "files" && <>
          <div className="remote-actions">
            <code>{directory || "/"}</code>
            <Button variant="ghost" disabled={busy || !directory} onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>{t("parent")}</Button>
          </div>
          {!busy && !error && entries.length === 0 && <p>{t("emptyFiles")}</p>}
          <div className="settings-stack">{entries.map((entry) => <Button variant="ghost" key={entry.name} disabled={busy}
            onClick={() => void open(entry)}>{entry.name}{entry.kind === "dir" ? "/" : ""}</Button>)}</div>
          {file && <section><h3>{file.path}</h3>{file.read.kind === "text"
            ? <pre>{file.read.content}</pre>
            : <p>{t(file.read.kind === "tooLarge" ? "truncated" : "binary")}</p>}</section>}
        </>}
        {tab === "review" && diff && <>
          {diff.files.length === 0 && (diff.reason
            ? <p>{tApp(REVIEW_LIMIT_KEYS[diff.reason])}</p>
            : !diff.repo ? <p>{t("notRepository")}</p>
              : <p>{t("noChanges")}</p>)}
          {diff.reason && diff.files.length > 0 && <p>{tApp(REVIEW_LIMIT_KEYS[diff.reason])}</p>}
          {diff.truncated && <p>{t("truncated")}</p>}
          {diff.files.map((item) => {
            const counts = knownDiffLineCounts(item);
            const limitKey = diffFileLimitKey(item);
            return <section key={item.path}>
              <h3>{item.path}{counts && <span className="diff-counts" aria-label={tApp("chat.reviewChangeCounts", counts)}>
                {` (+${counts.additions} / -${counts.deletions})`}</span>}</h3>
              {item.binary && <p>{t("binary")}</p>}
              {limitKey && <p>{tApp(limitKey)}</p>}
              {item.hunks.length > 0 && <RemoteDiffHunks hunks={item.hunks} />}
              {!counts && !item.binary && !limitKey && <p>{tApp("panel.review.noLineDetails")}</p>}
            </section>;
          })}
        </>}
      </div>
    </aside>
  );
}
