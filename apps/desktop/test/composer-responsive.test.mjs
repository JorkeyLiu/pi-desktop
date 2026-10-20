import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const styles = await loadStyles();
const [toolbarSource, modelPickerSource, primaryActionSource] = await Promise.all([
  readFile(
    new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/features/chat/composer/ComposerModelPicker.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/features/chat/composer/ComposerPrimaryAction.tsx", import.meta.url),
    "utf8",
  ),
]);
const composerSource = `${toolbarSource}\n${modelPickerSource}`;

test("narrow composer containers move the model chip to a second row", () => {
  assert.match(
    styles,
    /\.composer-stack\s*\{[\s\S]*?container-type:\s*inline-size;[\s\S]*?container-name:\s*composer-stack;/,
  );
  assert.match(styles, /\.composer-left,\s*\.composer-right\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(styles, /\.composer-model-thinking\s*\{[\s\S]*?min-width:\s*0;/);
  const narrow =
    styles.match(/@container composer-stack \(max-width: 560px\) \{([\s\S]*?)\n\}/)?.[1] ??
    "";
  assert.match(narrow, /\.composer-toolbar\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(narrow, /\.composer-right\s*\{[\s\S]*?flex:\s*1 1 auto;/);
  // The painted selection survives every width: no rule hides or folds the
  // reasoning level, the separator, the model name, or the trigger's chevron.
  assert.doesNotMatch(styles, /\.composer-model-thinking-level[^{]*\{[^}]*display:\s*none/);
  assert.doesNotMatch(styles, /\.composer-model-thinking-dot[^{]*\{[^}]*display:\s*none/);
  assert.doesNotMatch(
    styles,
    /\.composer-model-thinking-model[^{]*\{[^}]*display:\s*none/,
  );
  // The essential controls keep their hit target instead of collapsing.
  assert.doesNotMatch(
    styles,
    /\.composer-right \.composer-model-thinking-chip[^{]*\{[^}]*width:\s*32px/,
  );
});


test("responsive rules preserve the semantic model trigger and action controls", () => {
  assert.match(composerSource, /className=\{`icon-btn composer-model-thinking-chip/);
  assert.match(composerSource, /ariaLabel=\{`\$\{t\("chat\.model"\)\}: \$\{selectionName\}\./);
  assert.match(composerSource, /className=\"composer-model-thinking-chevron\"/);
  assert.match(composerSource, /ContextUsageInspector/);
  assert.match(composerSource, /composer-plugin-transform-btn/);
  assert.match(composerSource, /className="stop-btn"/);
  assert.match(composerSource, /<ComposerSendButton/);
  assert.match(primaryActionSource, /className="send-btn"/);
});
