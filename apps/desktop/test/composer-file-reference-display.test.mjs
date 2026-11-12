import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readComposerSource } from "./helpers/composer-source.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [autocomplete, autocompleteHook, autocompleteStyles, composer, composerStyles] =
  await Promise.all([
    read("../src/components/ComposerAutocomplete.tsx"),
    read("../src/hooks/use-composer-autocomplete.ts"),
    read("../src/styles/composer-autocomplete.css"),
    readComposerSource(),
    read("../src/styles/composer.css"),
  ]);

test("file autocomplete rows keep the path out of the persistent label", () => {
  assert.match(
    autocomplete,
    /const displayName = `\$\{name\}\$\{isDir \? "\/" : ""\}`/,
  );
  assert.match(autocomplete, /className="composer-ac-name">\{displayName\}/);
  assert.doesNotMatch(autocomplete, /composer-ac-path/);
  assert.doesNotMatch(autocompleteStyles, /\.composer-ac-path/);
});

test("accepted files become compact references while directories keep completion", () => {
  assert.match(autocomplete, /title=\{item\.entry\.path\}/);
  assert.match(
    autocomplete,
    /aria-label=\{`\$\{displayName\} — \$\{item\.entry\.path\}`\}/,
  );
  assert.match(
    autocompleteHook,
    /item\.kind === "path" && item\.entry\.kind === "file"/,
  );
  assert.match(autocompleteHook, /\.\.\.applyCompletion\(value, trigger, ""\)/);
  assert.match(autocompleteHook, /path: item\.entry\.path/);
  assert.match(
    autocompleteHook,
    /formatFileInsert\(item\.entry\.path, item\.entry\.kind\)/,
  );
  // Enter/Tab must splice a sentinel into the draft. A token-less reference
  // no longer paints after chips moved inline, so the @ token just vanished.
  assert.match(
    composer,
    /const token = nextChipToken\(\);[\s\S]*?result\.value\.slice\(0, result\.cursor\) \+ token/,
  );
  assert.match(
    composer,
    /createFileReference\(\s*acceptedFileReference\.path,[\s\S]*?token,/,
  );
  assert.match(composer, /applyEditorDraft\(\s*nextText,/);
  // Workspace switches still drop relative `@` chips, not every token-backed
  // chip — paste/scratch paths are absolute, plugin marks carry no path, and a
  // session reference names a conversation, so all three must survive.
  assert.match(composer, /function isPersistedScratchReference\(path: string\)/);
  assert.match(
    composer,
    /Boolean\(fileReference\.plugin\) \|\|[\s\S]*?fileReference\.kind === "session" \|\|[\s\S]*?isPersistedScratchReference\(fileReference\.path\)/,
  );
  assert.match(composer, /kept = current\.filter\(survives\)/);
  assert.doesNotMatch(
    composer,
    /current\.filter\(\(fileReference\) => Boolean\(fileReference\.token\)\)/,
  );
});

test("composer renders atomic inline references and serializes paths on send", () => {
  // A committed reference paints as real text — one `@name` token carrying the
  // full path in its title — with no chip surface, icon or remove control, and
  // no widget chrome around the selectable label.
  assert.match(composer, /export const REFERENCE_CLASS = "composer-reference"/);
  assert.match(composer, /element\.dataset\.token = token/);
  assert.match(composer, /element\.textContent = referenceLabel\(reference\)/);
  assert.match(composer, /return isPluginMark\(reference\) \? reference\.name : `@\$\{reference\.name\}`/);
  assert.doesNotMatch(composer, /contentEditable = "false"/);
  assert.doesNotMatch(composer, /composer-chip-name/);
  assert.doesNotMatch(composer, /composer-chip-remove/);
  // A file reference's title and accessible name carry its path; a plugin
  // mark's carry its plugin.
  assert.match(composer, /isPluginMark\(reference\) \? \(reference\.plugin\?\.pluginId \?\? ""\) : reference\.path/);
  assert.match(composer, /const origin = referenceOrigin\(reference\)/);
  assert.match(composer, /element\.title = origin/);
  assert.match(
    composer,
    /element\.setAttribute\("aria-label", `\$\{reference\.name\} — \$\{origin\}`\)/,
  );
  // The action a pointer click runs is reachable without a pointer: one tab
  // stop, the link role, and Enter/Space on the focused token.
  assert.match(composer, /element\.setAttribute\("role", "link"\)/);
  assert.match(composer, /element\.tabIndex = 0/);
  assert.match(composer, /if \(activateFocusedReference\(event\)\) return/);
  assert.match(
    composer,
    /serializeComposerFileReferences\(rawText, activeFileReferences\)/,
  );
  assert.match(
    composer,
    /sendPrompt\(\s*inlineContent,\s*submittedDraft,\s*activeSessionId \?\? undefined,\s*captureAcceptedSession,\s*\)/,
  );
  assert.match(composer, /serializeInlineComposerFileReferences\(/);
  assert.match(composer, /current\.filter\(/);
  // A label wraps instead of ellipsizing, so a long name never truncates.
  assert.doesNotMatch(composerStyles, /\.composer-reference[^}]*text-overflow/);
  assert.match(composerStyles, /\.composer-reference\s*\{[\s\S]*?text-decoration: underline/);
});

test("text file references expand into editable draft text", () => {
  assert.match(
    composer,
    /export function isEditableTextReference\(reference: ComposerFileReference\): boolean/,
  );
  // The action is reachable by pointer and by keyboard: a focused token runs
  // it on Enter or Space through the same activation path.
  assert.match(composer, /if \(isEditableTextReference\(reference\)\) void expandTextReference\(token\)/);
  assert.match(composer, /onActivate\(token, action\)/);
  assert.match(composer, /const result = await api\.fsRead\(reference\.path, reference\.mimeType, sourceSessionId\)/);
  assert.match(composer, /result\.kind !== "text" \|\| result\.content === undefined/);
  assert.match(
    composer,
    /source\.slice\(0, index\) \+ result\.content \+ source\.slice\(index \+ token\.length\)/,
  );
  assert.match(
    composer,
    /fileReferencesRef\.current\.filter\([\s\S]*?fileReference\.token !== token/,
  );
  assert.match(composer, /applyEditorDraft\(nextText, nextReferences, index \+ result\.content\.length\)/);
  // The activated reference points at its action and reads as a link.
  assert.match(composer, /if \(action\) \{[\s\S]*?element\.dataset\.action = action/);
  assert.match(composer, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(composerStyles, /\.composer-reference\[data-action\]\s*\{[\s\S]*?cursor: pointer/);
});

test("unanswered stop restores compact references instead of serialized paths", () => {
  assert.match(composer, /setValue\(prefilled\.text\)/);
  assert.match(composer, /composerPrefill\.fileReferences\.map/);
  assert.match(composer, /composerPrefill\.sessionId !== activeSessionId/);
  assert.match(
    composer,
    /createFileReferenceFromSnapshot\(fileReference,\s*composerPrefill\.sessionId\)/,
  );
  assert.doesNotMatch(composer, /setValue\(composerPrefill\);/);
});
