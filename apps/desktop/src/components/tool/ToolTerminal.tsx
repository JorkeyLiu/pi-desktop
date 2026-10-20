import { useTranslation } from "react-i18next";
import type { ToolBlock } from "../../lib/tool-presentation";
import { hasAnsi, parseAnsi } from "../../lib/ansi-text";
import { LargeTextPreview } from "../LargeTextPreview";
import { HighlightedCode } from "../Markdown";
import { BlockHead } from "./BlockHead";
import { cx } from "../ui";

/*
 * A command and what it printed, as a terminal (D226 follow-up).
 *
 * The command pane keeps the syntax highlighting and its own copy control; the
 * output pane keeps the exact bytes the command wrote — whitespace included —
 * and paints ANSI SGR colour by parsing it into spans, never by handing the
 * escape sequence to the DOM. The two panes sit side by side when the row is
 * wide enough and stack when it is not, which the container query in
 * `messages.css` decides from the row's own width rather than the viewport's.
 */

type TerminalBlock = Extract<ToolBlock, { kind: "terminal" }>;

/** Output text with ANSI colour, or the text itself when there is none. */
function AnsiText({ text }: { text: string }) {
  if (!hasAnsi(text)) return <>{text}</>;
  return (
    <>
      {parseAnsi(text).map((segment, index) => (
        <span
          className={cx(
            segment.style.bold && "is-bold",
            segment.style.underline && "is-underline",
            segment.style.color !== "" && `is-${segment.style.color}`,
          )}
          key={index}
        >
          {segment.text}
        </span>
      ))}
    </>
  );
}

function OutputPane({
  label,
  text,
  stream,
  streaming,
}: {
  label: string;
  text: string;
  stream: "stdout" | "stderr";
  streaming: boolean;
}) {
  return (
    <div className={cx("tool-terminal-stream", `is-${stream}`)}>
      <BlockHead label={label} copy={text} />
      <LargeTextPreview
        text={text}
        followLatest={streaming}
        preClassName={cx(
          "tool-row-content",
          "tool-terminal-output",
          stream === "stderr" && "is-error",
        )}
        renderPage={(page) => <AnsiText text={page} />}
      />
    </div>
  );
}

export function ToolTerminal({
  block,
  streaming = false,
}: {
  block: TerminalBlock;
  streaming?: boolean;
}) {
  const { t } = useTranslation();
  const hasOutput = block.stdout !== null || block.stderr !== null;
  return (
    <div className="tool-terminal" data-tool-terminal="">
      {block.command !== null ? (
        <section className="tool-terminal-pane is-command">
          <BlockHead label={t("chat.toolBlockCommand")} copy={block.command} />
          <pre className="tool-terminal-command">
            <HighlightedCode code={block.command} lang="bash" />
          </pre>
        </section>
      ) : null}
      {hasOutput ? (
        <section className="tool-terminal-pane is-output">
          {block.stdout !== null ? (
            <OutputPane
              label={t("chat.toolBlockStdout")}
              text={block.stdout}
              stream="stdout"
              streaming={streaming}
            />
          ) : null}
          {block.stderr !== null ? (
            <OutputPane
              label={t("chat.toolBlockStderr")}
              text={block.stderr}
              stream="stderr"
              streaming={streaming}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
