#!/usr/bin/env node
/**
 * Composer caret/newline regression.
 *
 * Reproduces the reported defect: delete the only character on the second line
 * of a draft, and the caret must stay on that now-empty line, typing must land
 * there, and no phantom character or newline may appear in the draft. Real
 * Chromium keys drive the real `ComposerInput` + `useComposerDraft` fixture, so
 * this suite fails when the editing host loses the empty line, and the DOM
 * serialization disagreeing with the draft offsets is an explicit assertion.
 *
 * Enter/Shift+Enter, repeated trailing newlines, selection deletion, native
 * undo, inline reference tokens, pasted text, and a synthetic IME commit are
 * covered in the same run so the fix cannot trade one of them for the reported
 * case.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-composer-caret-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/composer-caret.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    define: {
      "import.meta.env.DEV": "false",
      "process.env.NODE_ENV": '"production"',
    },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{
      name: "local-url-assets",
      setup(build) {
        build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
          path: join(resolveDir, path.slice(0, -4)), namespace: "local-url-asset",
        }));
        build.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
          contents: await readFile(path), loader: "file",
        }));
      },
    }],
  });
  await writeFile(
    join(temp, "tokens.css"),
    (await readFile(join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(/@theme(?: inline)?/g, ":root"),
  );
  await writeFile(
    join(temp, "composer.css"),
    await readFile(join(root, "apps/desktop/src/styles/composer.css")),
  );
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="composer.css"><body><script src="renderer.js"></script>`,
  );

  /** Real key presses; the page resolves its own await on keyup. */
  const steps = [
    // A. The reported path: the only character on line 2 is deleted.
    { op: "set", text: "暂不配置。\n非" },
    { op: "step", label: "seeded two lines" },
    { op: "key", key: "Backspace" },
    { op: "step", label: "deleted last char of line 2" },
    { op: "type", text: "a" },
    { op: "step", label: "typed on the empty second line" },
    // ... and continuing on that line keeps working.
    { op: "type", text: "b" },
    { op: "step", label: "typed twice on the second line" },

    // B. Enter then typing, and Shift+Enter then Shift+Enter then typing.
    { op: "set", text: "第一行" },
    { op: "key", key: "Return" },
    { op: "step", label: "Enter at end of a single line" },
    { op: "type", text: "a" },
    { op: "step", label: "typed after Enter" },
    { op: "key", key: "Shift+Return" },
    { op: "step", label: "Shift+Enter at end" },
    { op: "type", text: "b" },
    { op: "step", label: "typed after Shift+Enter" },

    // C. Repeated trailing newlines from an empty draft.
    { op: "set", text: "" },
    { op: "key", key: "Return" },
    { op: "key", key: "Return" },
    { op: "step", label: "two trailing newlines" },
    { op: "type", text: "x" },
    { op: "step", label: "typed on the third line" },

    // D. Deleting forward the only character of the second line.
    { op: "set", text: "一行\n二" },
    { op: "set", text: "一行\n二", caret: 3 },
    { op: "key", key: "Delete" },
    { op: "step", label: "deleted the only char of line 2 forward" },
    { op: "type", text: "z" },
    { op: "step", label: "typed after forward deletion" },

    // E. Selection deletion empties the draft instead of leaving a newline.
    { op: "set", text: "选择\n全部" },
    { op: "selectAll" },
    { op: "key", key: "Backspace" },
    { op: "step", label: "select-all deleted" },
    { op: "type", text: "n" },
    { op: "step", label: "typed after select-all delete" },

    // F. Native undo after typing on a second line.
    { op: "set", text: "撤销\n行" },
    { op: "step", label: "undo seed" },
    { op: "type", text: "q" },
    { op: "step", label: "typed before undo" },
    { op: "undo" },
    { op: "step", label: "after native undo" },

    // G. An inline reference token plus a trailing newline, then typing on the
    // new line: the token paints as the text `@name`.
    { op: "token", text: "notes.txt" },
    { op: "step", label: "token with trailing newline" },
    { op: "type", text: "c" },
    { op: "step", label: "typed after token newline" },

    // H. Pasted text ending in a newline, then typing on the fresh line.
    { op: "set", text: "粘贴前" },
    { op: "paste", text: "粘贴内容\n" },
    { op: "step", label: "pasted text ending with a newline" },
    { op: "type", text: "p" },
    { op: "step", label: "typed after pasted newline" },

    // I. IME commit of a two-line draft, deleting line 2, then typing.
    { op: "set", text: "暂不配置。\n" },
    { op: "ime", text: "非" },
    { op: "step", label: "IME commit" },
    { op: "key", key: "Backspace" },
    { op: "step", label: "IME delete line 2" },
    { op: "type", text: "i" },
    { op: "step", label: "typed after IME delete" },
    { op: "set", text: "尾行" },
    { op: "key", key: "Return" },
    { op: "step", label: "empty line from Enter" },
    { op: "key", key: "Backspace" },
    { op: "step", label: "backspace on the empty line" },
    { op: "type", text: "y" },
    { op: "step", label: "typed after joining the lines" },

    // K. Pasted text anywhere in a newline-terminated draft must not add or
    // lose trailing newlines (the caret-only break is not content).
    { op: "set", text: "a\nb\n", caret: 2 },
    { op: "step", label: "seeded newline-terminated draft" },
    { op: "paste", text: "x\ny" },
    { op: "step", label: "pasted multiline between the lines" },
    { op: "paste", text: "m\nn" },
    { op: "step", label: "pasted multiline again between the lines" },
    { op: "set", text: "a\n", caret: 2 },
    { op: "paste", text: "x\n" },
    { op: "step", label: "pasted text ending with one newline mid-draft" },
    { op: "set", text: "a\n\n", caret: 3 },
    { op: "paste", text: "x\ny\n" },
    { op: "step", label: "pasted text ending with one newline after two" },
    { op: "set", text: "a\n\n\n", caret: 4 },
    { op: "paste", text: "z" },
    { op: "step", label: "pasted plainly at the end of three newlines" },
    { op: "set", text: "a\nb", caret: 3 },
    { op: "paste", text: "x\ny" },
    { op: "step", label: "pasted multiline at the draft end" },
    { op: "set", text: "a", caret: 1 },
    { op: "paste", text: "x\ny\n" },
    { op: "step", label: "pasted text ending with one newline at the draft end" },
    { op: "set", text: "", caret: 0 },
    { op: "paste", text: "line\n\n" },
    { op: "step", label: "pasted two trailing newlines into an empty draft" },

    // L. A token's label is real text, so the browser can put a caret or a
    // selection edge inside it. That point is never a draft offset of its own:
    // it snaps to the nearer token boundary, and a selection that touches part
    // of the label takes the whole token.
    { op: "tokenMid", text: "notes.txt" },
    { op: "pointer", target: "token" },
    { op: "step", label: "clicked the token in mid-text" },
    { op: "tokenMid", text: "notes.txt" },
    { op: "insideToken" },
    { op: "step", label: "caret inside the token label" },
    { op: "recallCaret" },
    { op: "paste", text: "p" },
    { op: "step", label: "pasted at the stored token caret" },
    { op: "tokenMid", text: "notes.txt" },
    { op: "insideTokenDrag" },
    { op: "step", label: "selected from the token label into the text after it" },
    { op: "recallCaret" },
    { op: "paste", text: "q" },
    { op: "step", label: "pasted at the stored selection caret" },
    { op: "tokenMid", text: "notes.txt" },
    { op: "insideToken" },
    { op: "paste", text: "r" },
    { op: "step", label: "pasted while the caret sat inside the token label" },
    { op: "tokenMid", text: "notes.txt" },
    { op: "caret", caret: 2 },
    { op: "paste", text: "B" },
    { op: "step", label: "pasted just before the token" },
    { op: "tokenMid", text: "notes.txt" },
    { op: "caret", caret: 3 },
    { op: "paste", text: "A" },
    { op: "step", label: "pasted just after the token" },

    // M. Backspace and Delete at a token boundary remove the whole token, and
    // native undo brings the token — and its reference — back.
    { op: "tokenMid", text: "notes.txt" },
    { op: "caret", caret: 3 },
    { op: "key", key: "Backspace" },
    { op: "step", label: "backspace removed the whole token" },
    { op: "undo" },
    { op: "step", label: "undo restored the token" },
    { op: "tokenMid", text: "notes.txt" },
    { op: "caret", caret: 2 },
    { op: "key", key: "Delete" },
    { op: "step", label: "delete removed the whole token" },

    // N. A reference that ends the draft: a real CDP insertion and an emulated
    // IME composition at its trailing boundary must land outside the token, in
    // the draft, and reach what the composer submits.
    { op: "tokenLast", text: "a.png" },
    { op: "step", label: "sole token, caret after it" },
    { op: "cdpInsert", text: "hi" },
    { op: "step", label: "cdp insert after the token" },
    { op: "cdpInsert", text: "😀" },
    { op: "step", label: "cdp emoji insert after the token" },
    { op: "tokenLast", text: "a.png" },
    { op: "step", label: "token reattached at the draft end" },
    { op: "cdpCompose", text: "ni", commit: "你" },
    { op: "step", label: "cdp composition after the token" },
    { op: "tokenLast", text: "a.png" },
    { op: "caret", caret: 0 },
    { op: "cdpInsert", text: "before" },
    { op: "step", label: "cdp insert before the token" },

    // O. Native typing on both sides of a token is one undo stack: the last
    // boundary edit is what undo removes, not an earlier one.
    { op: "tokenMid", text: "notes.txt" },
    { op: "caret", caret: 2 },
    { op: "type", text: "d" },
    { op: "step", label: "typed before the token" },
    { op: "pointer", target: "tail" },
    { op: "step", label: "clicked the text after the token" },
    { op: "type", text: "Z" },
    { op: "step", label: "typed after the token" },
    { op: "undo" },
    { op: "step", label: "undo after boundary typing" },

    // P. The token is a keyboard-reachable link: Tab focuses it, Enter runs the
    // same action a click does, and a later keystroke still edits the draft.
    { op: "tokenMid", text: "notes.txt" },
    { op: "step", label: "token before keyboard focus" },
    { op: "key", key: "Tab" },
    { op: "step", label: "tab focused the token" },
    { op: "key", key: "Return" },
    { op: "step", label: "enter activated the focused token" },
    { op: "type", text: "k" },
    { op: "step", label: "typed after keyboard activation" },
    { op: "tokenImage", text: "photo.png" },
    { op: "step", label: "image token" },
    { op: "key", key: "Tab" },
    { op: "step", label: "tab focused the image token" },
    { op: "key", key: "Return" },
    { op: "step", label: "enter activated the image token" },
    // Space must activate the focused token instead of typing a space into
    // the draft, and must leave the draft byte-identical.
    { op: "tokenMid", text: "notes.txt" },
    { op: "step", label: "token before space activation" },
    { op: "key", key: "Tab" },
    { op: "step", label: "tab focused the token again" },
    { op: "key", key: "Space" },
    { op: "step", label: "space activated the focused token" },
  ];

  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STEPS = ${JSON.stringify(steps)};
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const logs = [];
  window.webContents.debugger.attach("1.3");
  window.webContents.on("console-message", async (event) => {
    if (event.message.startsWith("PI_CARET_KEY:")) {
      const spec = event.message.slice("PI_CARET_KEY:".length);
      const modifiers = [];
      let keyCode = spec;
      if (spec === "Shift+Return") { modifiers.push("shift"); keyCode = "Return"; }
      const send = (type) => window.webContents.sendInputEvent({
        type, keyCode, ...(modifiers.length ? { modifiers } : {}),
      });
      send("keyDown");
      // Chromium's editing pipeline needs the paired char event: a Return
      // keydown alone never reaches beforeinput/insertParagraph.
      if (Array.from(spec).length === 1 || keyCode === "Return") {
        window.webContents.sendInputEvent({ type: "char", keyCode, ...(modifiers.length ? { modifiers } : {}) });
      }
      send("keyUp");
      await pause(80);
      return;
    }
    if (event.message.startsWith("PI_CARET_POINTER:")) {
      const point = JSON.parse(event.message.slice("PI_CARET_POINTER:".length));
      for (const type of ["mousePressed", "mouseReleased"]) {
        await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type, x: point.x, y: point.y, button: "left",
          buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
        });
        await pause(40);
      }
      await pause(120);
      await window.webContents.executeJavaScript("globalThis.composerCaretPointerDone()");
      return;
    }
    if (event.message.startsWith("PI_CARET_CDP:")) {
      const spec = JSON.parse(event.message.slice("PI_CARET_CDP:".length));
      if (spec.op === "insertText") {
        await window.webContents.debugger.sendCommand("Input.insertText", { text: spec.text });
      } else if (spec.op === "compose") {
        await window.webContents.debugger.sendCommand("Input.imeSetComposition", {
          text: spec.text, selectionStart: spec.text.length, selectionEnd: spec.text.length,
        });
        await pause(120);
        await window.webContents.debugger.sendCommand("Input.insertText", { text: spec.commit });
      }
      await pause(150);
      await window.webContents.executeJavaScript("globalThis.composerCaretCdpDone()");
      return;
    }
    logs.push(event.message);
  });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    for (let i = 0; i < 200 && !logs.some((line) => line.includes("CARET_FIXTURE_READY")); i += 1) await pause(50);
    const result = await window.webContents.executeJavaScript("globalThis.composerCaretProbe(" + JSON.stringify(STEPS) + ")");
    console.log("COMPOSER_CARET_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error("COMPOSER_CARET_PROBE " + JSON.stringify({ ok: false, error: String(error), logs }));
    app.exit(1);
  }
});
`,
  );

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("COMPOSER_CARET_PROBE "));
  assert(
    line,
    `caret fixture returned no result (exit=${code}): ${output.slice(-4000)}`,
  );
  const result = JSON.parse(line.slice("COMPOSER_CARET_PROBE ".length));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(code, 0, output.slice(-4000));

  console.log(
    "COMPOSER_CARET_TRACE " +
      JSON.stringify(
        result.trace.map(
          ({
            label, draft, live, caret, caretEnd, cursor, point, caretLine, lastTextLine, lastChild,
            html, references, labels, referenceAria, focused, activations,
          }) => ({
            label, draft, live, caret, caretEnd, cursor, point, caretLine, lastTextLine, lastChild,
            html, references, labels, referenceAria, focused, activations,
          }),
        ),
      ),
  );
  const byLabel = new Map(
    result.trace.map((entry) => [entry.label, entry]),
  );
  const step = (label) => {
    const entry = byLabel.get(label);
    assert(entry, `missing step ${label}`);
    // The draft and its DOM serialization must never disagree; the reported
    // defect is exactly this mismatch.
    assert.equal(
      entry.live,
      entry.draft,
      `${label}: editor serialization ${JSON.stringify(entry.live)} != draft ${JSON.stringify(entry.draft)} (html=${entry.html})`,
    );
    return entry;
  };

  // A. Reported defect: the caret must stay on the second line and typing must
  // land there, with no phantom character or newline in the draft.
  const deleted = step("deleted last char of line 2");
  assert.equal(deleted.draft, "暂不配置。\n", `delete last char: ${deleted.html}`);
  assert.equal(deleted.caret, "暂不配置。\n".length);
  assert.equal(deleted.lastChild, "BR", `line 2 must keep a placeholder break: ${deleted.html}`);
  assert.ok(
    deleted.caretLine === null || deleted.caretLine === 1,
    `caret must stay on line 2, rendered line ${deleted.caretLine} (html=${deleted.html})`,
  );
  const typedLine2 = step("typed on the empty second line");
  assert.equal(typedLine2.draft, "暂不配置。\na", `typing after delete: ${typedLine2.html}`);
  assert.equal(typedLine2.lastTextLine, 1, `typed text must render on line 2: ${typedLine2.html}`);
  const typedTwice = step("typed twice on the second line");
  assert.equal(typedTwice.draft, "暂不配置。\nab", `second keystroke: ${typedTwice.html}`);
  assert.equal(typedTwice.lastTextLine, 1);
  assert.equal(typedTwice.submission, "暂不配置。\nab");

  // B. Enter and Shift+Enter leave an insertable empty line.
  const entered = step("Enter at end of a single line");
  assert.equal(entered.draft, "第一行\n", `Enter: ${entered.html}`);
  // Enter must be inserted by the composer, never by Chromium's paragraph
  // insertion, whose block wrappers the draft model cannot carry.
  assert.deepEqual(
    entered.events.filter(
      (event) => event.inputType === "insertParagraph" || event.inputType === "insertLineBreak",
    ),
    [],
    `Enter reached the editor as a native paragraph: ${JSON.stringify(entered.events)}`,
  );
  assert.equal(entered.caret, "第一行\n".length);
  const typedAfterEnter = step("typed after Enter");
  assert.equal(typedAfterEnter.draft, "第一行\na", `typing after Enter: ${typedAfterEnter.html}`);
  assert.equal(typedAfterEnter.lastTextLine, 1);
  const shiftEntered = step("Shift+Enter at end");
  assert.equal(shiftEntered.draft, "第一行\na\n", `Shift+Enter: ${shiftEntered.html}`);
  const typedAfterShift = step("typed after Shift+Enter");
  assert.equal(typedAfterShift.draft, "第一行\na\nb", `typing after Shift+Enter: ${typedAfterShift.html}`);
  assert.equal(typedAfterShift.lastTextLine, 2);

  // C. Repeated trailing newlines stay one draft newline each.
  const twoNewlines = step("two trailing newlines");
  assert.equal(twoNewlines.draft, "\n\n", `two newlines: ${twoNewlines.html}`);
  assert.equal(twoNewlines.caret, 2);
  const thirdLine = step("typed on the third line");
  assert.equal(thirdLine.draft, "\n\nx", `third line typing: ${thirdLine.html}`);
  assert.equal(thirdLine.lastTextLine, 2);

  // D. Forward deletion of the only character on line 2.
  const forwardDeleted = step("deleted the only char of line 2 forward");
  assert.equal(forwardDeleted.draft, "一行\n", `forward delete: ${forwardDeleted.html}`);
  const forwardTyped = step("typed after forward deletion");
  assert.equal(forwardTyped.draft, "一行\nz", `typing after forward delete: ${forwardTyped.html}`);
  assert.equal(forwardTyped.lastTextLine, 1);

  // E. Deleting everything leaves an empty draft, not a stray newline.
  const emptied = step("select-all deleted");
  assert.equal(emptied.draft, "", `select-all delete: ${emptied.html}`);
  const retyped = step("typed after select-all delete");
  assert.equal(retyped.draft, "n", `typing into emptied editor: ${retyped.html}`);

  // F. Native undo restores the draft and keeps the serialization honest.
  const undid = step("after native undo");
  assert.equal(undid.draft, "撤销\n行", `undo result: ${undid.html}`);

  // G. An inline reference token survives a trailing newline and later typing,
  // and paints its visible label as plain text.
  const tokenLine = step("token with trailing newline");
  assert.equal(tokenLine.references.length, 1, `token missing: ${tokenLine.html}`);
  assert.deepEqual(tokenLine.tokens, tokenLine.references);
  assert.deepEqual(tokenLine.labels, ["@notes.txt"], `token label: ${tokenLine.html}`);
  assert.equal(tokenLine.draft, `见 ${tokenLine.references[0]}\n`);
  assert.equal(tokenLine.submission, tokenLine.draft.trim());
  const tokenTyped = step("typed after token newline");
  assert.equal(tokenTyped.draft, `见 ${tokenTyped.references[0]}\nc`, `typing after token: ${tokenTyped.html}`);
  assert.equal(tokenTyped.references.length, 1);
  assert.equal(tokenTyped.lastTextLine, 1);

  // H. Pasted text that ends with a newline keeps that newline and the caret
  // on the fresh line.
  const pasted = step("pasted text ending with a newline");
  assert.equal(pasted.draft, "粘贴前粘贴内容\n", `paste with newline: ${pasted.html}`);
  const pastedTyped = step("typed after pasted newline");
  assert.equal(pastedTyped.draft, "粘贴前粘贴内容\np", `typing after paste: ${pastedTyped.html}`);
  assert.equal(pastedTyped.lastTextLine, 1);

  // I. A committed IME draft keeps the same caret rules.
  const ime = step("IME commit");
  assert.equal(ime.draft, "暂不配置。\n非", `IME commit: ${ime.html}`);
  const imeDeleted = step("IME delete line 2");
  assert.equal(imeDeleted.draft, "暂不配置。\n", `IME delete: ${imeDeleted.html}`);
  const imeTyped = step("typed after IME delete");
  assert.equal(imeTyped.draft, "暂不配置。\ni", `typing after IME delete: ${imeTyped.html}`);
  assert.equal(imeTyped.lastTextLine, 1);

  // J. Removing the empty line again leaves one line.
  const emptyLine = step("empty line from Enter");
  assert.equal(emptyLine.draft, "尾行\n", `Enter line: ${emptyLine.html}`);
  const joined = step("backspace on the empty line");
  assert.equal(joined.draft, "尾行", `backspace on empty line: ${joined.html}`);
  const joinedTyped = step("typed after joining the lines");

  // K. A caret-only break is not content: pasting anywhere keeps exactly the
  // trailing newlines the draft already had, however many that is.
  const seededTrailing = step("seeded newline-terminated draft");
  assert.equal(seededTrailing.draft, "a\nb\n", `seed: ${seededTrailing.html}`);
  const middlePaste = step("pasted multiline between the lines");
  assert.equal(
    middlePaste.draft,
    "a\nx\nyb\n",
    `multiline paste mid-draft: ${middlePaste.html}`,
  );
  const middlePasteAgain = step("pasted multiline again between the lines");
  assert.equal(
    middlePasteAgain.draft,
    "a\nx\nym\nnb\n",
    `repeated multiline paste mid-draft: ${middlePasteAgain.html}`,
  );
  const singleTrailing = step("pasted text ending with one newline mid-draft");
  assert.equal(
    singleTrailing.draft,
    "a\nx\n",
    `paste ending with one newline after one: ${singleTrailing.html}`,
  );
  const afterTwo = step("pasted text ending with one newline after two");
  assert.equal(
    afterTwo.draft,
    "a\n\nx\ny\n",
    `paste after two trailing newlines: ${afterTwo.html}`,
  );
  const plainAtEnd = step("pasted plainly at the end of three newlines");
  assert.equal(
    plainAtEnd.draft,
    "a\n\n\nz",
    `plain paste after three trailing newlines: ${plainAtEnd.html}`,
  );
  const multilineAtEnd = step("pasted multiline at the draft end");
  assert.equal(multilineAtEnd.draft, "a\nbx\ny", `multiline paste at end: ${multilineAtEnd.html}`);
  const emptyPaste = step("pasted two trailing newlines into an empty draft");
  assert.equal(
    emptyPaste.draft,
    "line\n\n",
    `a browser-empty editor must paste its trailing newlines once: ${emptyPaste.html}`,
  );
  assert.equal(emptyPaste.caret, 6, `paste caret: ${emptyPaste.caret}`);
  assert.equal(emptyPaste.lastChild, "BR", `trailing break run: ${emptyPaste.html}`);
  const trailingAtEnd = step("pasted text ending with one newline at the draft end");
  assert.equal(
    trailingAtEnd.draft,
    "ax\ny\n",
    `paste ending with a newline at the draft end: ${trailingAtEnd.html}`,
  );

  // L. A click inside a token's label keeps the draft intact, activates the
  // reference once, and leaves the caret on a token boundary the editor agrees
  // with. A caret placed inside the label snaps to the nearer boundary.
  const clickedToken = step("clicked the token in mid-text");
  assert.equal(clickedToken.references.length, 1, `token missing: ${clickedToken.html}`);
  assert.equal(
    clickedToken.draft,
    `见 ${clickedToken.references[0]}后面`,
    `a click on the token changed the draft: ${clickedToken.html}`,
  );
  assert.deepEqual(
    clickedToken.activations,
    [clickedToken.references[0]],
    `a real click must activate the reference once: ${clickedToken.html}`,
  );
  assert.equal(
    clickedToken.cursor,
    clickedToken.caret,
    `a click on the token stored a caret the editor does not report: stored ${clickedToken.cursor}, read ${clickedToken.caret}`,
  );
  assert.equal(
    clickedToken.caret,
    2,
    `a click inside the label must snap to a token boundary: caret ${clickedToken.caret} of ${JSON.stringify(clickedToken.draft)}`,
  );
  const labelPoint = step("caret inside the token label");
  assert.equal(labelPoint.point?.collapsed, true, JSON.stringify(labelPoint.point));
  // The label point was repaired to a token boundary, so no endpoint sits in it.
  assert.equal(labelPoint.point?.anchor?.insideReference, false, JSON.stringify(labelPoint.point));
  assert.equal(
    labelPoint.caret,
    labelPoint.cursor,
    `a caret inside the label must normalize to the stored boundary: caret ${labelPoint.caret}, cursor ${labelPoint.cursor}`,
  );
  assert.equal(
    labelPoint.references.length,
    1,
    `a caret inside the label destroyed the token: ${labelPoint.html}`,
  );
  const storedPaste = step("pasted at the stored token caret");
  assert.equal(
    storedPaste.draft,
    `见 p${storedPaste.references[0]}后面`,
    `the stored caret spliced inside the token: ${storedPaste.html}`,
  );
  const draggingToken = step("selected from the token label into the text after it");
  assert.equal(draggingToken.references.length, 1, `token missing: ${draggingToken.html}`);
  assert.equal(
    draggingToken.caret,
    2,
    `a selection touching part of the label must take the whole token: caret ${draggingToken.caret} of ${JSON.stringify(draggingToken.draft)}`,
  );
  assert.ok(
    draggingToken.selection.startsWith("@notes.txt"),
    `the normalized selection must start at the token: ${JSON.stringify(draggingToken.selection)}`,
  );
  assert.equal(
    draggingToken.activations.length,
    0,
    `a selection must never activate the reference: ${JSON.stringify(draggingToken.activations)}`,
  );
  const selectionPaste = step("pasted at the stored selection caret");
  assert.equal(
    selectionPaste.draft,
    `见 q${selectionPaste.references[0]}后面`,
    `the selection caret spliced inside the token: ${selectionPaste.html}`,
  );
  const liveTokenPaste = step("pasted while the caret sat inside the token label");
  assert.equal(
    liveTokenPaste.references.length,
    1,
    `an edit derived from a label point destroyed the token: ${liveTokenPaste.html}`,
  );
  assert.equal(
    liveTokenPaste.draft,
    `见 r${liveTokenPaste.references[0]}后面`,
    `an edit derived from a label point landed at the wrong offset: ${liveTokenPaste.html}`,
  );
  const beforeToken = step("pasted just before the token");
  assert.equal(
    beforeToken.draft,
    `见 B${beforeToken.references[0]}后面`,
    `a point before the token must stay before it: ${beforeToken.html}`,
  );
  const afterToken = step("pasted just after the token");
  assert.equal(
    afterToken.draft,
    `见 ${afterToken.references[0]}A后面`,
    `a point after the token must stay after it: ${afterToken.html}`,
  );

  // M. A reference is one atomic character to deletion, and native undo puts
  // the token back with its reference metadata.
  const backspaced = step("backspace removed the whole token");
  assert.equal(backspaced.draft, "见 后面", `backspace must remove the whole token: ${backspaced.html}`);
  assert.equal(backspaced.references.length, 0, `backspace left a token behind: ${backspaced.html}`);
  assert.deepEqual(backspaced.tokens, []);
  const restored = step("undo restored the token");
  assert.equal(
    restored.draft,
    `见 ${restored.references[0]}后面`,
    `undo must restore the token: ${restored.html}`,
  );
  assert.deepEqual(restored.tokens, restored.references, `undo lost the reference: ${restored.html}`);
  const deletedToken = step("delete removed the whole token");
  assert.equal(deletedToken.draft, "见 后面", `Delete must remove the whole token: ${deletedToken.html}`);
  assert.equal(deletedToken.references.length, 0, `Delete left a token behind: ${deletedToken.html}`);


  // N. A reference at the draft end accepts real input on its boundary: the
  // character lands in the draft, outside the label, and reaches submission.
  const soleToken = step("sole token, caret after it");
  assert.equal(soleToken.references.length, 1, `token missing: ${soleToken.html}`);
  assert.equal(soleToken.draft, soleToken.references[0], `sole token draft: ${soleToken.html}`);
  assert.deepEqual(
    soleToken.referenceAria.map((aria) => aria.role),
    ["link"],
    `token role: ${JSON.stringify(soleToken.referenceAria)}`,
  );
  const cdpAfter = step("cdp insert after the token");
  assert.equal(
    cdpAfter.draft,
    `${cdpAfter.references[0]}hi`,
    `a real Chromium insertion at the token boundary edited the label: ${cdpAfter.html}`,
  );
  assert.equal(cdpAfter.submission, cdpAfter.draft, "the inserted text must be submitted");
  assert.equal(cdpAfter.labels.length, 1);
  const cdpEmoji = step("cdp emoji insert after the token");
  assert.equal(
    cdpEmoji.draft,
    `${cdpEmoji.references[0]}hi😀`,
    `an emoji at the token boundary must stay outside the token: ${cdpEmoji.html}`,
  );
  assert.equal(cdpEmoji.submission, cdpEmoji.draft);
  assert.equal(
    cdpEmoji.labels[0],
    "@a.png",
    `an emoji at the token boundary corrupted the label: ${cdpEmoji.html}`,
  );
  const reattached = step("token reattached at the draft end");
  assert.equal(reattached.draft, reattached.references[0], `reattach: ${reattached.html}`);
  const composed = step("cdp composition after the token");
  assert.equal(
    composed.draft,
    `${composed.references[0]}你`,
    `an emulated IME composition at the token boundary edited the label: ${composed.html}`,
  );
  assert.equal(composed.submission, composed.draft);
  const insertBefore = step("cdp insert before the token");
  assert.equal(
    insertBefore.draft,
    `before${insertBefore.references[0]}`,
    `a real Chromium insertion before the token: ${insertBefore.html}`,
  );

  // O. Typing on both sides of a token is native editing: undo removes the last
  // boundary edit and leaves the earlier one in place.
  const typedBefore = step("typed before the token");
  assert.equal(typedBefore.draft, `见 d${typedBefore.references[0]}后面`, `type before: ${typedBefore.html}`);
  const clickedAfter = step("clicked the text after the token");
  assert.equal(clickedAfter.activations.length, 0, "a click past the token is no activation");
  const typedAfter = step("typed after the token");
  assert.equal(typedAfter.draft, `见 d${typedAfter.references[0]}Z后面`, `type after: ${typedAfter.html}`);
  const afterUndo = step("undo after boundary typing");
  assert.equal(
    afterUndo.draft,
    `见 d${afterUndo.references[0]}后面`,
    `undo must remove the latest boundary edit, not an earlier one: ${afterUndo.html}`,
  );
  assert.equal(afterUndo.references.length, 1, `undo lost the token: ${afterUndo.html}`);

  // P. The token is a keyboard-reachable link with an accessible name.
  const beforeKeyboard = step("token before keyboard focus");
  const aria = beforeKeyboard.referenceAria[0];
  assert.equal(aria.role, "link", `role: ${JSON.stringify(aria)}`);
  assert.equal(aria.tabIndex, 0, `tabIndex: ${JSON.stringify(aria)}`);
  assert.ok(
    aria.label?.includes("notes.txt") && aria.label?.includes("/caret-workspace/notes.txt"),
    `accessible name must carry the file and its path: ${JSON.stringify(aria)}`,
  );
  assert.equal(aria.title, "/caret-workspace/notes.txt", `title: ${JSON.stringify(aria)}`);
  const tabFocus = step("tab focused the token");
  assert.equal(
    tabFocus.focused?.token,
    tabFocus.references[0],
    `Tab must reach the token: ${JSON.stringify(tabFocus.focused)}`,
  );
  const enterActivated = step("enter activated the focused token");
  assert.deepEqual(
    enterActivated.activations,
    [enterActivated.references[0]],
    `Enter on a focused token must run its action: ${enterActivated.html}`,
  );
  assert.equal(
    enterActivated.draft,
    `见 ${enterActivated.references[0]}后面`,
    `Enter on a focused token must not edit the draft: ${enterActivated.html}`,
  );
  const typedAfterActivation = step("typed after keyboard activation");
  assert.equal(
    typedAfterActivation.labels[0],
    "@notes.txt",
    `typing after a keyboard activation corrupted the label: ${typedAfterActivation.html}`,
  );
  assert.equal(typedAfterActivation.references.length, 1);
  // Focus returns to the composer, so the next keystroke is ordinary draft
  // text instead of a lost character or a mangled label.
  assert.equal(
    typedAfterActivation.draft,
    `见 ${typedAfterActivation.references[0]}后面k`,
    `typing must continue in the draft after keyboard activation: ${typedAfterActivation.html}`,
  );
  const imageToken = step("image token");
  assert.equal(imageToken.referenceAria[0]?.role, "link", `image role: ${JSON.stringify(imageToken.referenceAria)}`);
  assert.ok(
    imageToken.referenceAria[0]?.label?.includes("photo.png") &&
      imageToken.referenceAria[0]?.label?.includes("/caret-workspace/photo.png"),
    `image accessible name: ${JSON.stringify(imageToken.referenceAria)}`,
  );
  const imageActivated = step("enter activated the image token");
  assert.deepEqual(
    imageActivated.activations,
    [imageActivated.references[0]],
    `Enter on a focused image token must open its preview: ${imageActivated.html}`,
  );
  const beforeSpace = step("token before space activation");
  const spaceTabFocus = step("tab focused the token again");
  assert.equal(
    spaceTabFocus.focused?.token,
    spaceTabFocus.references[0],
    `Tab must reach the token again: ${JSON.stringify(spaceTabFocus.focused)}`,
  );
  const spaceActivated = step("space activated the focused token");
  assert.deepEqual(
    spaceActivated.activations,
    [spaceActivated.references[0]],
    `Space on a focused token must run its action: ${spaceActivated.html}`,
  );
  assert.equal(
    spaceActivated.draft,
    beforeSpace.draft,
    `Space after activation must not type a space into the draft: ${spaceActivated.html}`,
  );
  console.log("COMPOSER_CARET_PROBE " + JSON.stringify({ ok: true, steps: result.trace.length }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
