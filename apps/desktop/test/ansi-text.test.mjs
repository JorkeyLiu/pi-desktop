import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { hasAnsi, parseAnsi } = await import("../src/lib/ansi-text.ts");

/*
 * Terminal colour, read rather than interpreted (D226 follow-up). A command's
 * output is the one payload that arrives with SGR codes in it, and the only
 * safe way to show them is to read them into styled runs: nothing here may put
 * an escape sequence, or a control code, back into the rendered text.
 */

const ESC = "\u001b";
const plain = { bold: false, underline: false, color: "" };

const texts = (segments) => segments.map((segment) => segment.text).join("");
const styles = (segments) => segments.map((segment) => segment.style);

test("colour runs carry their SGR state and reset back to plain", () => {
  const segments = parseAnsi(`before ${ESC}[31mred${ESC}[0m after`);
  assert.deepEqual(segments, [
    { text: "before ", style: plain },
    { text: "red", style: { ...plain, color: "red" } },
    { text: " after", style: plain },
  ]);
});

test("bright, bold and underline are independent of colour", () => {
  const segments = parseAnsi(
    `${ESC}[1m${ESC}[4m${ESC}[92mstout${ESC}[22m ${ESC}[24mplain`,
  );
  assert.deepEqual(styles(segments), [
    { bold: true, underline: true, color: "bright-green" },
    { bold: false, underline: true, color: "bright-green" },
    { bold: false, underline: false, color: "bright-green" },
  ]);
  // One run carries several codes, and the default foreground is a colour too.
  assert.deepEqual(styles(parseAnsi(`${ESC}[1;4;33mboth${ESC}[39mhere`)), [
    { bold: true, underline: true, color: "yellow" },
    { bold: true, underline: true, color: "" },
  ]);
});

test("codes the renderer cannot paint are dropped, never guessed at", () => {
  // 256-colour and background codes have no palette entry; the index and the
  // background must not leak into the foreground.
  const segments = parseAnsi(`256${ESC}[38;5;196mcolor ${ESC}[41mbg`);
  assert.equal(texts(segments), "256color bg");
  // Adjacent unpaintable codes merge into one plain run: the text is intact and
  // carries no attribute the terminal never asked for.
  assert.deepEqual(styles(segments), [plain]);
});

test("cursor movement, erase and OSC titles are dropped from the text", () => {
  // A progress spinner repainting itself must not erase the transcript.
  assert.equal(texts(parseAnsi(`a${ESC}[2J${ESC}[Hb${ESC}]0;title\u0007c`)), "abc");
});

test("no escape or control sequence survives into a rendered run", () => {
  const nasty = [
    `${ESC}[31mred`,
    `${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`,
    `half${ESC}[3`,
    `${ESC}[K`,
    `${ESC}[0m${ESC}[0m`,
    "no escapes at all",
  ];
  for (const input of nasty) {
    const segments = parseAnsi(input);
    assert.equal(
      segments.some((segment) => segment.text.includes(ESC) || segment.text.includes("\u0007")),
      false,
      `an escape survived from ${JSON.stringify(input)}`,
    );
    assert.equal(segments.some((segment) => segment.text.includes("\u001b]")), false);
  }
});

test("an unterminated sequence drops its escape byte instead of mangling text", () => {
  // The bytes after a broken escape are ordinary characters; the escape byte
  // itself must not reach the DOM.
  assert.equal(texts(parseAnsi(`ok${ESC}[31`)), "ok[31");
  assert.equal(texts(parseAnsi(`${ESC}`)), "");
});

test("hasAnsi only reports text that actually carries an escape", () => {
  assert.equal(hasAnsi(`${ESC}[31mred`), true);
  assert.equal(hasAnsi("assembly [31] lines"), false);
  assert.equal(hasAnsi(""), false);
});

test("adjacent runs of the same style stay one run", () => {
  // Two colour changes with no text between them are one styled run, so the
  // rendered output has no empty spans.
  assert.deepEqual(parseAnsi(`${ESC}[31m${ESC}[1mred`), [
    { text: "red", style: { bold: true, underline: false, color: "red" } },
  ]);
  assert.deepEqual(parseAnsi(""), []);
});
