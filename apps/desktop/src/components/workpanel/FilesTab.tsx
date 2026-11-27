import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { FsEntry, FsReadResult } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Markdown } from "../Markdown";
import { fileDirOf } from "../../lib/chat-links";
import { canSaveCopySelected } from "../../lib/save-copy-gate";
import { Button, cx } from "../ui";
import { TooltipButton } from "../ui";
import {
  ensureLang,
  getHighlightVersion,
  resolveLang,
  subscribeHighlighter,
  themeForMode,
  tokenizeIncremental,
  type LineCache,
} from "../../lib/shiki";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternal,
  IconFileText,
  IconFolder,
} from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

const VIEWER_LINE_CAP = 5000;

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
};

function langForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? ext;
  return resolveLang(lang);
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function isExternallyOpenable(path: string, mimeType?: string): boolean {
  if (/\.(?:mp3|wav|ogg|oga|opus|flac|m4a|aac|mp4|m4v|mov|webm|ogv)$/i.test(path)) return true;
  if (
    /(?:^|[\\/])attachments[\\/][0-9a-f]{64}$/i.test(path) &&
    /^(?:audio|video)\//i.test(mimeType ?? "")
  ) return true;
  return false;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function useThemeMode(): "light" | "dark" {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      return () => observer.disconnect();
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
}

function HighlightedText({ path, content }: { path: string; content: string }) {
  const mode = useThemeMode();
  const highlightVersion = useSyncExternalStore(
    subscribeHighlighter,
    getHighlightVersion,
  );
  const lang = langForPath(path);
  const lines = useMemo(() => content.split("\n"), [content]);
  const capped = lines.length > VIEWER_LINE_CAP;
  const visible = useMemo(
    () => (capped ? lines.slice(0, VIEWER_LINE_CAP).join("\n") : content),
    [capped, lines, content],
  );

  const tokens = useMemo<LineCache | null>(() => {
    void highlightVersion;
    if (!lang) return null;
    ensureLang(lang);
    return tokenizeIncremental(null, visible, lang, themeForMode(mode));
  }, [lang, visible, mode, highlightVersion]);

  return (
    <pre className="file-viewer-code">
      {tokens
        ? tokens.tokens.map((row, i) => (
            <div className="file-viewer-line" data-line={i + 1} key={i}>
              {row.length === 0
                ? "\n"
                : row.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
            </div>
          ))
        : visible.split("\n").map((line, i) => (
            <div className="file-viewer-line" data-line={i + 1} key={i}>
              {line || "\n"}
            </div>
          ))}
      {capped && <div className="file-viewer-cap">…</div>}
    </pre>
  );
}

type DirState = { entries: FsEntry[]; error?: boolean };

// Module-level so a chat preview request fires once, not again on every
// files-tab remount (the tab unmounts when another tool is selected).
let handledFileRequestSeq = 0;

export function FilesTab() {
  const { t } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  const fileRequest = useAppStore((s) => s.workPanelFileRequest);
  const showToast = useAppStore((s) => s.showToast);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const remote = workspace?.remote;
  const root = workspace?.path ?? null;
  const scopeRef = useRef({ root, sessionId });
  scopeRef.current = { root, sessionId };

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedMimeType, setSelectedMimeType] = useState<string | undefined>();
  const [selectedLine, setSelectedLine] = useState<number | undefined>();
  // ADR 0342: user-link mode opens one user-clicked absolute file outside
  // every containment root through the user-link channels. Only the chat
  // file-ref entry sets it (via the file tab's `userLink` flag); tree
  // browsing never enters it.
  const [selectedUserLink, setSelectedUserLink] = useState(false);
  const [file, setFile] = useState<FsReadResult | null>(null);
  const [fileError, setFileError] = useState(false);
  const [fileErrorCode, setFileErrorCode] = useState<string | null>(null);
  const viewerBodyRef = useRef<HTMLDivElement>(null);
  const fileGeneration = useRef(0);

  // Workspace switches reset all browsing state. Guarded so it only fires on
  // an actual root change: an unconditional [root] effect also runs on the
  // StrictMode remount, wiping the selection a chat file request just made
  // (first click landed on the tree instead of the file).
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setSelectedMimeType(undefined);
    setSelectedLine(undefined);
    setSelectedUserLink(false);
    setFile(null);
    setFileError(false);
    setFileErrorCode(null);
  }, [root]);

  const loadDir = useCallback(
    async (rel: string) => {
      if (!root) return;
      try {
        const res = await api.fsList(rel, sessionId);
        if (scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setDirs((prev) => ({ ...prev, [rel]: { entries: res.entries } }));
      } catch {
        if (scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setDirs((prev) => ({ ...prev, [rel]: { entries: [], error: true } }));
      }
    },
    [root, sessionId],
  );

  useEffect(() => {
    if (root && !dirs[""]) void loadDir("");
  }, [root, dirs, loadDir]);

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
        }
        return next;
      });
      if (!dirs[rel]) void loadDir(rel);
    },
    [dirs, loadDir],
  );

  const openFile = useCallback(
    async (rel: string, mimeType?: string, position?: { line?: number; column?: number }, userLink?: boolean) => {
      const request = ++fileGeneration.current;
      setSelected(rel);
      setSelectedMimeType(mimeType);
      setSelectedLine(position?.line);
      setSelectedUserLink(userLink === true);
      setFile(null);
      setFileError(false);
      setFileErrorCode(null);
      try {
        // ADR 0342: a user-link file travels outside every containment root,
        // so it reads through the dedicated user-link capability — never the
        // contained channel, which would refuse it and report a restriction.
        const result = userLink
          ? await api.fsReadUserLink(rel, mimeType, sessionId)
          : await api.fsRead(rel, mimeType, sessionId);
        if (request !== fileGeneration.current || scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setFile(result);
      } catch (error) {
        if (request !== fileGeneration.current || scopeRef.current.root !== root || scopeRef.current.sessionId !== sessionId) return;
        setFileError(true);
        const code = (error as { code?: unknown } | null)?.code;
        setFileErrorCode(typeof code === "string" ? code : null);
      }
    },
    [root, sessionId],
  );

  useEffect(() => {
    if (!file || selectedLine == null) return;
    const frame = requestAnimationFrame(() => {
      const lineNode = viewerBodyRef.current?.querySelector(
        `[data-line="${selectedLine}"]`,
      );
      lineNode?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [file, selectedLine]);

  const openExternal = useCallback(async () => {
    // ADR 0342: external open is not offered for user-link files — the
    // contained `fsOpen` channel cannot address them, and routing them there
    // would only fail with a restriction. The button stays hidden instead.
    if (!selected || remote || selectedUserLink) return;
    try {
      await api.fsOpen(selected, selectedMimeType, sessionId);
    } catch {
      showToast(t("panel.files.openFailed"), { variant: "error" });
    }
  }, [selected, selectedMimeType, sessionId, selectedUserLink, showToast, t]);

  const saveCopy = useCallback(async () => {
    if (!selected) return;
    try {
      // ADR 0342: a user-link download re-validates the source through the
      // same gate as the read — renderer bytes are never written.
      if (selectedUserLink) await api.fsSaveCopyUserLink(selected, sessionId);
      else await api.fsSaveCopy(selected, sessionId);
    } catch {
      showToast(t("panel.files.saveFailed"), { variant: "error" });
    }
  }, [selected, selectedUserLink, sessionId, showToast, t]);

  // Chat-initiated previews: open the file and expand its ancestor folders
  // so "back" lands on a tree that reveals it. Attachment blobs and absolute
  // scratch paths live outside the workspace tree.
  useEffect(() => {
    if (!fileRequest) return;
    if (fileRequest.seq === handledFileRequestSeq) return;
    handledFileRequestSeq = fileRequest.seq;
    const path = fileRequest.path;
    const isExternal =
      path.startsWith("attachments/") ||
      path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.startsWith("\\\\");
    if (root && !isExternal) {
      const parts = path.split("/").slice(0, -1);
      const ancestors: string[] = [];
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        ancestors.push(acc);
      }
      setExpanded((prev) => new Set([...prev, ...ancestors]));
      for (const dir of ancestors) void loadDir(dir);
    }
    void openFile(path, fileRequest.mimeType, {
      line: fileRequest.line,
      column: fileRequest.column,
    }, fileRequest.userLink);
  }, [fileRequest, root, loadDir, openFile]);

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const state = dirs[rel];
    if (!state) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:loading`}
        >
          {t("panel.files.loading")}
        </div>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:empty`}
        >
          {state.error ? t("panel.files.error") : t("panel.files.empty")}
        </div>
      );
    }
    return state.entries.map((entry) => {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.kind === "dir") {
        const open = expanded.has(childRel);
        return (
          <div key={childRel}>
            <button
              type="button"
              className="file-tree-row"
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => toggleDir(childRel)}
            >
              <span className={cx("file-tree-caret", open && "open")} aria-hidden>
                <IconChevronRight size={12} />
              </span>
              <IconFolder size={14} />
              <span className="file-tree-name">{entry.name}</span>
            </button>
            {open && renderDir(childRel, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={childRel}
          type="button"
          className={cx("file-tree-row", selected === childRel && "active")}
          style={{ paddingLeft: 12 + depth * 14 + 16 }}
          onClick={() => void openFile(childRel)}
          title={childRel}
        >
          <IconFileText size={14} />
          <span className="file-tree-name">{entry.name}</span>
        </button>
      );
    });
  };

  if (selected !== null) {
    // Dead buttons are worse than none: a remote session only keeps save-a-copy
    // for locally stored attachment blobs, so anything else names the limit.
    // A user-link file (ADR 0342) is always local — a remote session never
    // opens one — so download stays available while reveal/open stay hidden.
    const canSaveCopy = selectedUserLink ? !remote : canSaveCopySelected(remote, selected);
    // ADR 0342: a user-link read failure names what actually happened
    // (missing / not a regular file / read failure) instead of the generic
    // panel error; contained reads keep their existing copy.
    const userLinkErrorTitle = !selectedUserLink || !fileError
      ? null
      : fileErrorCode === "NOT_FOUND"
        ? t("chat.fileUserLinkMissing", { name: selected })
        : fileErrorCode === "INVALID_ARGUMENT"
          ? t("chat.fileUserLinkNotFile", { name: selected })
          : t("chat.fileUserLinkFailed", { name: selected });
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.back")}
            ariaLabel={t("panel.files.back")}
            onClick={() => {
              setSelected(null);
              setSelectedMimeType(undefined);
              setSelectedLine(undefined);
              setSelectedUserLink(false);
              setFile(null);
              setFileError(false);
              setFileErrorCode(null);
            }}
          >
            <IconChevronLeft size={14} />
          </TooltipButton>
          <span className="file-viewer-path" title={selected}>
            {selected}
          </span>
          {file && <span className="file-viewer-size">{formatSize(file.size)}</span>}
          {!remote && !selectedUserLink ? <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("panel.files.reveal")}
            ariaLabel={t("panel.files.reveal")}
            onClick={() => void api.fsReveal(selected, sessionId)}
          >
            <IconExternal size={14} />
          </TooltipButton> : null}
        </div>
        <div className="file-viewer-body" ref={viewerBodyRef}>
          {fileError ? (
            <WorkTabEmpty icon={IconFileText} title={userLinkErrorTitle ?? t("panel.files.error")}>
              {canSaveCopy ? (
                <Button type="button" onClick={() => void saveCopy()}>
                  {t("panel.files.download")}
                </Button>
              ) : (
                <div className="file-tree-note">{t("panel.files.remoteUnavailable")}</div>
              )}
            </WorkTabEmpty>
          ) : !file ? (
            <div className="file-tree-note">{t("panel.files.loading")}</div>
          ) :
          file.kind === "text" &&
          isMarkdownPath(selected) &&
          selectedLine === undefined ? (
            <div className="file-viewer-markdown prose-chat">
              <Markdown source={file.content ?? ""} baseDir={fileDirOf(selected)} />
            </div>
          ) : file.kind === "text" ? (
            <HighlightedText path={selected} content={file.content ?? ""} />
          ) : file.kind === "image" ? (
            <div className="file-viewer-image">
              <img src={file.dataUrl} alt={selected} />
            </div>
          ) : (
            <WorkTabEmpty
              icon={IconFileText}
              title={
                file.kind === "tooLarge"
                  ? t("panel.files.tooLarge")
                  : t("panel.files.binary")
              }
            >
              {canSaveCopy ? (
                <Button type="button" onClick={() => void saveCopy()}>
                  {t("panel.files.download")}
                </Button>
              ) : null}
              {!remote && !selectedUserLink && isExternallyOpenable(selected, selectedMimeType) && (
                <Button type="button" onClick={() => void openExternal()}>
                  {t("chat.openFile")}
                </Button>
              )}
              {remote && !canSaveCopy && (
                <div className="file-tree-note">{t("panel.files.remoteUnavailable")}</div>
              )}
            </WorkTabEmpty>
          )}
        </div>
      </div>
    );
  }

  if (!root) {
    return (
      <WorkTabEmpty
        icon={IconFolder}
        title={t("panel.files.noWorkspace")}
        body={t("panel.files.noWorkspaceHint")}
      />
    );
  }

  return <div className="file-tree">{renderDir("", 0)}</div>;
}
