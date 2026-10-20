import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { composerModelChipLabel } from "../src/lib/composer-models.ts";
import { loadStyles } from "./helpers/styles.mjs";

const picker = await readFile(
  new URL("../src/features/chat/composer/ComposerModelPicker.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("the chip paints the model name without its routing namespace", () => {
  assert.deepEqual(
    composerModelChipLabel("opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash"),
    { label: "deepseek-v4.1-flash", namespace: "opencode-go" },
  );
  // Several route segments still leave the model name alone.
  assert.deepEqual(
    composerModelChipLabel("openrouter/x-ai/grok-4.6", "openrouter/x-ai/grok-4.6"),
    { label: "grok-4.6", namespace: "openrouter/x-ai" },
  );
  // A name without a namespace is already readable and stays whole.
  assert.deepEqual(composerModelChipLabel("deepseek-v4.1-flash", "deepseek-v4.1-flash"), {
    label: "deepseek-v4.1-flash",
    namespace: "",
  });
});

test("the chip never shortens a configured alias", () => {
  assert.deepEqual(composerModelChipLabel("fast-coder", "opencode-go/fast-coder-7b"), {
    label: "fast-coder",
    namespace: "",
  });
  // A slash inside the user's own name is part of that name.
  assert.deepEqual(composerModelChipLabel("team/fast", "opencode-go/fast-coder-7b"), {
    label: "team/fast",
    namespace: "",
  });
});

test("the chip keeps a complete label when it cannot shorten", () => {
  assert.deepEqual(composerModelChipLabel("openai/gpt-5", undefined), {
    label: "openai/gpt-5",
    namespace: "",
  });
  assert.deepEqual(composerModelChipLabel("  openai/gpt-5  ", "openai/gpt-5"), {
    label: "gpt-5",
    namespace: "openai",
  });
  // A trailing separator is not a model name.
  assert.deepEqual(composerModelChipLabel("openai/", "openai/"), {
    label: "openai/",
    namespace: "",
  });
  assert.deepEqual(composerModelChipLabel("/gpt-5", "/gpt-5"), {
    label: "/gpt-5",
    namespace: "",
  });
});

test("the trigger paints the short name and names the complete selection", () => {
  assert.match(picker, /composerModelChipLabel\(modelLabel, selectedModelId\)/);
  assert.match(
    picker,
    /<span className="composer-model-thinking-model">\{chipModel\.label\}<\/span>/,
  );
  // The complete wire id, and an alias beside it, stay reachable on the trigger.
  assert.match(
    picker,
    /selectedModelId && selectedModelId\.trim\(\) !== modelLabel\.trim\(\)\s*\?\s*`\$\{modelLabel\} \(\$\{selectedModelId\}\)`\s*:\s*modelLabel/,
  );
  assert.match(
    picker,
    /tooltip=\{`\$\{selectionName\} · \$\{t\("chat\.reasoningLevel"\)\}: \$\{thinkingLabel\}`\}/,
  );
  assert.match(
    picker,
    /ariaLabel=\{`\$\{t\("chat\.model"\)\}: \$\{selectionName\}\. \$\{t\("chat\.reasoningLevel"\)\}: \$\{thinkingLabel\}`\}/,
  );
});

test("the reasoning slot never shrinks, so it is never ellipsized", () => {
  // The partials may set colour or line-height for these selectors on their own;
  // the layout rule is the one that carries the slot's flex behaviour.
  const blocks = (selector) => {
    const found = [];
    let index = styles.indexOf(`${selector} {`);
    while (index !== -1) {
      const end = styles.indexOf("}", index);
      found.push(styles.slice(index, end + 1));
      index = styles.indexOf(`${selector} {`, end + 1);
    }
    assert.notEqual(found.length, 0, `missing ${selector} rule`);
    return found;
  };
  const withFlex = (selector, flex) => {
    const match = blocks(selector).find((block) => block.includes(`flex: ${flex};`));
    assert.ok(match, `${selector} never declares flex: ${flex}`);
    return match;
  };
  assert.doesNotMatch(withFlex(".composer-model-thinking-level", "0 0 auto"), /max-width:/);
  withFlex(".composer-model-thinking-model", "0 1 auto");
  // Only the model name is allowed to run out of width.
  assert.match(
    blocks(".composer-model-thinking-chip").join("\n"),
    /max-width: min\(320px/,
  );
  assert.doesNotMatch(styles, /\.composer-model-thinking-level\s*\{[^}]*display:\s*none/);
});
