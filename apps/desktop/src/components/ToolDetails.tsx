import { useTranslation } from "react-i18next";
import { HighlightedCode } from "./Markdown";
import { LargeTextPreview } from "./LargeTextPreview";
import { IconCircleAlert, IconInfo } from "./icons";
import { TooltipButton, cx } from "./ui";
import { toWorkspaceRel } from "../lib/chat-links";
import { useOpenPreviewTarget } from "../hooks/use-preview-target";
import { useChatFileMenu } from "../hooks/use-chat-file-menu";
import { ContextMenu } from "./ContextMenu";
import { useAppStore } from "../stores/app-store";
import type { ToolBlock, ToolChip } from "../lib/tool-presentation";
import { AskToolRichText } from "./AskToolRichText";
import { BlockHead, MoreNote } from "./tool/BlockHead";
import { ToolChecklist } from "./tool/ToolChecklist";
import { ToolDocumentCard } from "./tool/ToolDocumentCard";
import { ToolRawPayload, ToolValueList } from "./tool/ToolValueList";
import { ToolTerminal } from "./tool/ToolTerminal";

/*
 * Renderer for the structured tool presentation (D192).
 *
 * Blocks arrive with a semantic role; this layer owns the translated headings,
 * the copy affordance and the click-to-preview wiring, while the tool-specific
 * cards (terminal, checklist, document, value list, raw payload) live in
 * `components/tool/`. Shared by the transcript tool row and the inline
 * permission card so both read the same way.
 */

const BLOCK_LABEL_KEYS: Record<ToolBlock["role"], string> = {
  content: "chat.toolBlockContent",
  written: "chat.toolBlockWritten",
  command: "chat.toolBlockCommand",
  stdout: "chat.toolBlockStdout",
  stderr: "chat.toolBlockStderr",
  diff: "chat.toolBlockDiff",
  files: "chat.toolBlockFiles",
  matches: "chat.toolBlockMatches",
  details: "chat.toolBlockDetails",
  notice: "chat.toolBlockNotice",
  error: "chat.toolBlockError",
  output: "chat.toolOutput",
  input: "chat.toolInput",
};

function blockCopyText(block: ToolBlock): string {
  switch (block.kind) {
    case "asktool":
      return block.questions
        .map(({ question, answers }) => `${question}：${answers?.join("、") ?? ""}`)
        .join("\n---\n");
    case "code":
      return block.text;
    case "diff":
      return block.copy;
    case "files":
      return block.paths.join("\n");
    case "matches":
      return block.groups
        .flatMap((group) =>
          group.lines.map((line) => `${group.path}:${line.line}: ${line.text}`),
        )
        .join("\n");
    case "fields":
      return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    case "values":
      return block.items.join("\n");
    case "terminal":
      return [block.command, block.stdout, block.stderr]
        .filter((part): part is string => part !== null)
        .join("\n");
    case "todos":
      return block.items
        .map((item) => `[${item.status}] ${item.content}`)
        .join("\n");
    case "document":
      return block.body;
    case "raw":
      return block.text;
    case "empty":
      // Nothing matched, so there are no bytes to hand back.
      return "";
    case "note":
      return block.code ? `${block.code}: ${block.text}` : block.text;
  }
}

function AskToolResult({
  block,
}: {
  block: Extract<ToolBlock, { kind: "asktool" }>;
}) {
  const { t } = useTranslation();
  return (
    <dl className="tool-asktool-results" aria-label={t("askTool.historyTitle")}>
      {block.questions.map((entry, index) => (
        <div className="tool-asktool-entry" key={`${index}-${entry.question}`}>
          <dt className="tool-asktool-question">
            <span className="tool-asktool-question-number">
              {t("askTool.questionNumber", { number: index + 1 })}
            </span>
            <span className="tool-asktool-question-copy">
              <AskToolRichText source={entry.question} />
            </span>
          </dt>
          <dd className="tool-asktool-answer">
            <span className="tool-asktool-answer-label">
              {t("askTool.answerLabel")}
            </span>
            <span className="tool-asktool-answer-values">
              {entry.answers?.length ? (
                entry.answers.map((answer, answerIndex) => (
                  <span
                    className="tool-asktool-answer-value"
                    key={`${answerIndex}-${answer}`}
                  >
                    <AskToolRichText source={answer} />
                  </span>
                ))
              ) : (
                <span className="tool-asktool-skipped">{t("askTool.skipped")}</span>
              )}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A workspace path list (Glob results, plugin string arrays). */
function FileList({ paths }: { paths: string[] }) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path);
  const openTarget = useOpenPreviewTarget();
  const { fileMenu, openFileMenu, closeFileMenu } = useChatFileMenu();
  return (
    <div className="tool-file-list">
      {paths.map((path, index) => {
        const rel = toWorkspaceRel(path, root);
        if (!rel) {
          return (
            <span className="tool-file-item" key={`${path}-${index}`}>
              {path}
            </span>
          );
        }
        return (
          <TooltipButton
            type="button"
            className="tool-file-item is-linked"
            key={`${path}-${index}`}
            tooltip={t("chat.previewFile")}
            onClick={() => openTarget({ kind: "file", path: rel })}
            onContextMenu={(event) => openFileMenu(event, { path: rel })}
          >
            {path}
          </TooltipButton>
        );
      })}
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </div>
  );
}

/** Grep hits grouped by file: the path opens, each line keeps its number. */
function MatchList({ block }: { block: Extract<ToolBlock, { kind: "matches" }> }) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path);
  const openTarget = useOpenPreviewTarget();
  const { fileMenu, openFileMenu, closeFileMenu } = useChatFileMenu();
  return (
    <div className="tool-match-list">
      {block.groups.map((group, index) => {
        const rel = toWorkspaceRel(group.path, root);
        return (
          <div className="tool-match-group" key={`${group.path}-${index}`}>
            {rel ? (
              <TooltipButton
                type="button"
                className="tool-match-path is-linked"
                tooltip={t("chat.previewFile")}
                onClick={() => openTarget({ kind: "file", path: rel })}
                onContextMenu={(event) =>
                  openFileMenu(event, { path: rel })
                }
              >
                {group.path}
              </TooltipButton>
            ) : (
              <span className="tool-match-path">{group.path}</span>
            )}
            {group.lines.map((line, lineIndex) => (
              <div className="tool-match-line" key={`${line.line}-${lineIndex}`}>
                <span className="tool-match-line-no">{line.line}</span>
                <span className="tool-match-line-text">{line.text}</span>
              </div>
            ))}
          </div>
        );
      })}
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </div>
  );
}

/**
 * An empty search or listing: nothing matched, which is the result the call
 * delivered. The card says so in the session language instead of leaving the
 * payload's `count`/`truncated` metadata to stand in for a body.
 */
function EmptyResult({
  block,
}: {
  block: Extract<ToolBlock, { kind: "empty" }>;
}) {
  const { t } = useTranslation();
  return (
    <div className="tool-note is-empty">
      <IconInfo size={13} />
      <span className="tool-note-text">
        {t(
          block.scope === "files"
            ? "chat.toolEmptyFiles"
            : "chat.toolEmptyMatches",
        )}
      </span>
    </div>
  );
}

function BlockBody({
  block,
  streaming,
  plain,
}: {
  block: ToolBlock;
  streaming: boolean;
  /** No section frame around the body, so a card must label itself. */
  plain: boolean;
}) {
  switch (block.kind) {
    case "asktool":
      return <AskToolResult block={block} />;
    case "code":
      return (
        <LargeTextPreview
          text={block.text}
          followLatest={streaming}
          preClassName={cx("tool-row-content", block.tone === "error" && "is-error")}
          renderPage={(page) =>
            block.highlight ? <HighlightedCode code={page} lang={block.lang} /> : page
          }
        />
      );
    case "diff":
      return (
        <div className="tool-diff">
          <div className="diff-hunk">
            {block.lines.map((line, index) => (
              <div className={cx("diff-line", line.type)} key={index}>
                <span className="diff-line-sign" aria-hidden>
                  {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                </span>
                <span className="diff-line-text">{line.text}</span>
              </div>
            ))}
          </div>
          <MoreNote hidden={block.hidden} />
        </div>
      );
    case "files":
      return (
        <>
          <FileList paths={block.paths} />
          <MoreNote hidden={block.hidden} />
        </>
      );
    case "matches":
      return (
        <>
          <MatchList block={block} />
          <MoreNote hidden={block.hidden} />
        </>
      );
    case "fields":
      return (
        <dl className="tool-fields">
          {block.rows.map((row) => (
            <div className="tool-field" key={row.label}>
              <dt className="tool-field-label">{row.label}</dt>
              <dd className="tool-field-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "values":
      return <ToolValueList block={block} showLabel={plain} />;
    case "terminal":
      return <ToolTerminal block={block} streaming={streaming} />;
    case "todos":
      return <ToolChecklist block={block} />;
    case "document":
      return <ToolDocumentCard block={block} />;
    case "raw":
      return <ToolRawPayload block={block} />;
    case "empty":
      return <EmptyResult block={block} />;
    case "note":
      return (
        <div className={cx("tool-note", block.role === "error" && "is-error")}>
          {block.role === "error" ? (
            <IconCircleAlert size={13} />
          ) : (
            <IconInfo size={13} />
          )}
          <span className="tool-note-text">
            {block.code ? `${block.text} (${block.code})` : block.text}
          </span>
        </div>
      );
  }
}

export function ToolDetailBlocks({
  blocks,
  plain = false,
  streaming = false,
}: {
  blocks: ToolBlock[];
  plain?: boolean;
  streaming?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {blocks.map((block, index) => {
        // Cards that name themselves and bring their own copy control bypass
        // the generic section frame instead of nesting a second heading above
        // their own: the terminal labels its panes, the document card its
        // title, the raw payload its disclosure summary. An empty result has
        // no bytes to head and no control to offer.
        if (block.kind === "terminal") {
          return (
            <div className="tool-block is-terminal" key={`terminal-${index}`}>
              <ToolTerminal block={block} streaming={streaming} />
            </div>
          );
        }
        if (block.kind === "document") {
          return (
            <div className="tool-block is-document" key={`document-${index}`}>
              <ToolDocumentCard block={block} />
            </div>
          );
        }
        if (block.kind === "raw") {
          return (
            <div className="tool-block is-raw" key={`raw-${index}`}>
              <ToolRawPayload block={block} />
            </div>
          );
        }
        const label = block.labelKey
          ? t(block.labelKey)
          : block.label ??
            (block.kind === "asktool"
              ? t("askTool.historyTitle")
              : t(BLOCK_LABEL_KEYS[block.role]));
        return (
          <section
            className={cx(
              "tool-block",
              plain && "is-plain",
              block.kind === "empty" && "is-empty",
            )}
            key={`${block.role}-${block.labelKey ?? block.label ?? index}`}
          >
            {plain ? (
              // A run row's terminal owns the labeled panes, so any other
              // block in that body — an error note, a host notice — keeps its
              // channel name for screen readers instead of a heading the
              // terminal would have had to repeat next to its own.
              <span className="sr-only">{label}</span>
            ) : block.kind === "empty" ? null : block.kind === "todos" ? (
              // A checklist's own progress row is its heading; the frame only
              // keeps the copy control it would otherwise have carried.
              <BlockHead label={label} copy={blockCopyText(block)} showLabel={false} />
            ) : (
              <BlockHead label={label} copy={blockCopyText(block)} />
            )}
            <BlockBody block={block} streaming={streaming} plain={plain} />
          </section>
        );
      })}
    </>
  );
}

const CHIP_LABEL_KEYS: Record<ToolChip["role"], string> = {
  exit: "chat.toolChipExit",
  matches: "chat.toolChipMatches",
  files: "chat.toolChipFiles",
  replacements: "chat.toolChipReplacements",
  truncated: "chat.toolChipTruncated",
  scratch: "chat.toolChipScratch",
  lines: "chat.toolChipLines",
  size: "chat.toolChipSize",
};

/** Collapsed-row outcome badges: exit code, hit counts, truncation. */
export function ToolChips({ chips }: { chips: ToolChip[] }) {
  const { t } = useTranslation();
  if (chips.length === 0) return null;
  return (
    <span className="tool-row-chips">
      {chips.map((chip) => (
        <span
          className={cx("tool-chip", chip.role === "exit" && "is-error")}
          key={chip.role}
        >
          {t(CHIP_LABEL_KEYS[chip.role], {
            ...("count" in chip ? { count: chip.count } : {}),
            ...("text" in chip
              ? chip.role === "lines"
                ? { range: chip.text }
                : { size: chip.text }
              : {}),
          })}
        </span>
      ))}
    </span>
  );
}
