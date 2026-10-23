import { readTranscriptModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transcriptSource = await readTranscriptModule("ToolRow.tsx");
const terminal = await readFile(
  new URL("../src/components/tool/ToolTerminal.tsx", import.meta.url),
  "utf8",
);
const stylesSource = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const details = await readFile(
  new URL("../src/components/ToolDetails.tsx", import.meta.url),
  "utf8",
);

/**
 * These assertions are about what a row renders, not about how the file is
 * laid out. Collapsing whitespace makes each one hold for the same markup at
 * any indentation or wrapping, so re-formatting the source never rewrites a
 * contract.
 */
const flat = (source) => source.replace(/\s+/g, " ");
const transcript = flat(transcriptSource);
const detailsFlat = flat(details);
const styles = flat(stylesSource);

test("a run row keeps its disclosure header outside subagent task cards", () => {
  assert.match(transcript, /if \(variant === "task"\) return <SubagentTaskCard \{\.\.\.props\} \/>;/);
  assert.match(transcript, /const runHead = action === "run";/);
  assert.match(transcript, /className=\{`tool-row-head\$\{runHead \? " is-run" : ""\}`\}/);
});

test("collapsed rows have no copy control; expanded terminal panes copy command and output", () => {
  assert.doesNotMatch(transcript, /ToolCommandCopy|tool-row-head-copy/);
  assert.match(transcript, /className="tool-row-caret is-toggle"/);
  assert.match(transcript, /aria-hidden="true" tabIndex=\{-1\}/);
  assert.match(details, /<ToolTerminal block=\{block\} streaming=\{streaming\} \/>/);
  assert.match(terminal, /BlockHead label=\{t\("chat\.toolBlockCommand"\)\} copy=\{block\.command\}/);
  assert.match(terminal, /<BlockHead label=\{label\} copy=\{text\} \/>/);
});

test("the left identity is the tool's own name, never a lifecycle label", () => {
  // The name is the tool's own identity, with the localized generic word only
  // when the call has no name at all.
  assert.match(transcript, /const rawName = getToolDisplayName\(message\.toolName\) \|\| t\("chat\.tool"\);/);
  assert.match(transcript, /<span className="tool-row-name" title=\{waitTitle\}> \{rawName\} <\/span>/);
  // The icon names the action, so the pair reads the same whatever the call's
  // status is.
  assert.match(transcript, /<ToolActionIcon action=\{action\} \/>/);
  // Identity must not be selected by status: no action/progress label table
  // reaches the name, and the name never takes a status-derived class.
  assert.doesNotMatch(transcript, /TOOL_ACTION_KEYS|TOOL_RUNNING_KEYS/);
  assert.doesNotMatch(transcript, /className=\{`tool-row-name/);
  assert.doesNotMatch(transcript, /className="tool-row-name [^"]*"/);
});

test("lifecycle reaches the row only through its right-hand status", () => {
  // A live row spins; a settled row names its state with a toned dot. Both sit
  // in the right-hand cluster, so the left side never carries lifecycle.
  assert.match(
    transcript,
    /const statusBadge = !runHead && !lifecycle && status === "running" \? \( <span className="tool-spinner" aria-label=\{t\("chat\.running"\)\} \/> \)/,
  );
  assert.match(
    transcript,
    /className=\{`tool-row-state \$\{statusTone\}`\} role="status" aria-live="polite"> <span className="tool-row-state-dot" aria-hidden \/> \{statusLabel\}/,
  );
  assert.match(transcript, /className="tool-row-lifecycle"/);
  // A delegate control row states its own wait, never its name, and the
  // backend-owned outcome outranks the generic lifecycle label.
  assert.match(
    transcript,
    /const lifecycleLabel = lifecycle \? status === "running" \? t\(LIFECYCLE_RUNNING_KEYS\[lifecycle\]\) : t\(waitLabelKey \?\? LIFECYCLE_LABEL_KEYS\[lifecycle\]\)/,
  );
  assert.match(transcript, /const statusLabel = lifecycleLabel \?\?/);
  // The retired header capsule and the left-hand running marker are gone.
  assert.doesNotMatch(transcript, /tool-row-status/);
  assert.doesNotMatch(styles, /\.tool-row-status/);
  assert.match(styles, /\.tool-row-lifecycle \{[^}]*margin-left: auto;/);
  assert.match(styles, /\.tool-row-state \{[^}]*font-size: var\(--text-sm-plus\);[^}]*line-height: var\(--leading-row\);/);
  assert.match(styles, /\.tool-spinner \{[^}]*margin-left: auto;/);
});

test("run state keeps its toned dot and reduced-motion behavior", () => {
  assert.match(transcript, /const run = action === "run" \? runOutcome\(message\) : null/);
  assert.match(transcript, /run === "running" \|\| \(!run && status === "running"\) \? "is-running"/);
  assert.match(styles, /\.tool-row-state\.is-done \.tool-row-state-dot \{\s*background: var\(--ds-success\)/);
  assert.match(styles, /\.tool-row-state\.is-error \.tool-row-state-dot \{\s*background: var\(--ds-error\)/);
  assert.match(styles, /\.tool-row-state\.is-running \.tool-row-state-dot \{[^}]*animation: tool-row-state-pulse/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.tool-row-state\.is-running \.tool-row-state-dot \{\s*animation: none;/);
});

test("the disclosure chevron stays out of the tab order", () => {
  assert.match(transcript, /className="tool-row-caret is-toggle"/);
  assert.match(transcript, /aria-hidden="true" tabIndex=\{-1\}/);
  assert.match(styles, /\.tool-row-header:hover \{\s*background: var\(--ds-bg-hover\)/);
});

test("run summaries use prose typography except structured commands and paths", () => {
  assert.match(transcript, /summaryIsPath \? " is-path" : ""/);
  assert.match(transcript, /summaryIsCode \? " is-code" : ""/);
  assert.match(styles, /\.tool-row-summary \{[^}]*font-family: var\(--font-sans\);[^}]*font-size: var\(--text-sm-plus\);[^}]*line-height: var\(--leading-row\);/);
  assert.match(styles, /\.tool-row-summary\.is-code \{[^}]*font-family: var\(--font-mono\)/);
});

test("the expanded run body remains plain output with its existing height cap", () => {
  assert.match(transcript, /<ToolDetailBlocks blocks=\{blocks\} plain=\{runHead\} streaming=\{status === "running"\} \/>/);
  assert.match(detailsFlat, /plain \? \( \/\/[\s\S]*?<span className="sr-only">\{label\}<\/span>/);
  assert.match(detailsFlat, /<BlockHead label=\{label\} copy=\{blockCopyText\(block\)\} \/>/);
  assert.match(styles, /\.tool-block\.is-plain \.tool-row-content \{[^}]*border: 0;[^}]*background: transparent;[^}]*padding: 0;/);
  assert.match(styles, /\.tool-row-content \{\s*max-height: 260px/);
});
