import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The transcript sources import their siblings bundler-style (extensionless),
// so the same hook the other TypeScript-importing tests use is registered here.
const here = fileURLToPath(new URL(".", import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const root = fileURLToPath(new URL("..", import.meta.url));

const { delegateTaskTitle, subagentTaskTitle, subagentTaskTitles } =
  await import("../src/lib/subagent-title.ts");
const { subagentWorkPanelTab } = await import("../src/lib/work-panel-tabs.ts");

const CREATED_AT = "2026-10-18T00:00:00.000Z";

/**
 * One `Task` call as the runtime stores it: the display metadata the model
 * wrote in `description`, the brief in `task`, and the delegation identity in
 * its result.
 */
function taskCall(
  id,
  callId,
  { description, resume, delegationId = "d1", status = "completed", agent = "manifestor" } = {},
) {
  return {
    id,
    role: "tool",
    content: "",
    createdAt: CREATED_AT,
    toolName: "Task",
    toolCallId: callId,
    toolStatus: status === "running" ? "running" : "success",
    toolArgs: {
      agent,
      task: "Do the whole job and report back in one paragraph.",
      ...(description === undefined ? {} : { description }),
      ...(resume === undefined ? {} : { resume }),
    },
    toolResult: {
      details: {
        delegationId,
        agent,
        status,
        startedAt: Date.parse(CREATED_AT),
        modelId: "test-model",
        thinkingLevel: "high",
      },
    },
  };
}

function plainMessage(id, role, content, extra = {}) {
  return { id, role, content, createdAt: CREATED_AT, ...extra };
}

test("the task title is the call's description, never its brief", () => {
  assert.equal(
    delegateTaskTitle(taskCall("t1", "call-1", { description: "Fix the cache" })),
    "Fix the cache",
  );
  // A description written over several lines prints as one title.
  assert.equal(
    delegateTaskTitle(taskCall("t2", "call-2", { description: "  Fix\n the   cache  " })),
    "Fix the cache",
  );
  // An older log without a description has no title at all: the brief is not a
  // fallback, and neither is a whitespace-only description.
  assert.equal(delegateTaskTitle(taskCall("t3", "call-3")), "");
  assert.equal(delegateTaskTitle(taskCall("t4", "call-4", { description: "   " })), "");
  assert.equal(delegateTaskTitle(plainMessage("t5", "tool", "")), "");
  assert.equal(
    delegateTaskTitle({ ...taskCall("t6", "call-6", { description: "x" }), toolArgs: null }),
    "",
  );
});

test("a resume chain keeps the original task title", () => {
  const original = taskCall("t1", "call-1", {
    description: "Fix the cache stampede",
    delegationId: "d1",
  });
  const resume = taskCall("t2", "call-2", {
    description: "Continue the work",
    resume: "d1",
    delegationId: "d2",
  });
  const resumeWithoutTitle = taskCall("t3", "call-3", {
    resume: "d2",
    delegationId: "d3",
  });
  const messages = [original, resume, resumeWithoutTitle];

  // Entered by any call of the chain, in either direction, the title is the
  // earliest description the chain recorded: a continuation never retitles the
  // work it continues.
  assert.equal(subagentTaskTitle(messages, "d1"), "Fix the cache stampede");
  assert.equal(subagentTaskTitle(messages, "d2"), "Fix the cache stampede");
  assert.equal(subagentTaskTitle(messages, "d3"), "Fix the cache stampede");
  // A call that has no result yet has only its own id: entering the chain by
  // that id still reads the title the chain's first call wrote.
  const pending = { ...taskCall("t4", "call-4", { description: "Fix the cache stampede" }), toolResult: undefined };
  assert.equal(subagentTaskTitle([pending], "call-4"), "Fix the cache stampede");
  assert.equal(subagentTaskTitle([pending], "call-9"), "");
  // An unknown delegation and an empty id have no title to derive.
  assert.equal(subagentTaskTitle(messages, "d9"), "");
  assert.equal(subagentTaskTitle(messages, "   "), "");
  assert.equal(subagentTaskTitle([], "d1"), "");
});

test("the conversation-wide title map names every call of a chain", () => {
  const original = taskCall("t1", "call-1", {
    description: "Fix the cache stampede",
    delegationId: "d1",
  });
  const resume = taskCall("t2", "call-2", {
    description: "Continue the cache work",
    resume: "d1",
    delegationId: "d2",
  });
  const untitled = taskCall("t3", "call-3", {
    resume: "d2",
    delegationId: "d3",
  });
  const solo = taskCall("t4", "call-4", {
    description: "Audit the release",
    delegationId: "d4",
  });
  const messages = [original, resume, untitled, solo, plainMessage("u1", "user", "go")];

  const titles = subagentTaskTitles(messages);
  // Every delegation of the chain resolves to the same original title, and a
  // delegation outside it keeps its own.
  assert.equal(titles.get("d1"), "Fix the cache stampede");
  assert.equal(titles.get("d2"), "Fix the cache stampede");
  assert.equal(titles.get("d3"), "Fix the cache stampede");
  assert.equal(titles.get("d4"), "Audit the release");
  // Non-`Task` rows contribute nothing, and an unknown conversation is empty.
  assert.equal(titles.size, 4);
  assert.equal(subagentTaskTitles([]).size, 0);
  // The map agrees with the per-delegation resolver it generalizes.
  for (const id of ["d1", "d2", "d3", "d4"]) {
    assert.equal(titles.get(id), subagentTaskTitle(messages, id));
  }
  // A chain whose calls carry no description has no title to hand down.
  const bare = subagentTaskTitles([
    taskCall("b1", "call-b1", { delegationId: "b1" }),
    taskCall("b2", "call-b2", { resume: "b1", delegationId: "b2" }),
  ]);
  assert.equal(bare.get("b1"), "");
  assert.equal(bare.get("b2"), "");
});

test("a chain whose only call has no description falls back to the role", () => {
  const messages = [
    taskCall("t1", "call-1", { delegationId: "d1", agent: "inspector" }),
  ];
  assert.equal(subagentTaskTitle(messages, "d1"), "");
  // The card's own fallback order, mirrored here: title, then role, then the
  // panel's localized unnamed label.
  assert.equal(delegateTaskTitle(messages[0]), "");
  assert.equal(messages[0].toolArgs.agent, "inspector");
});

test("the work panel tab is labelled with the same task title", () => {
  const titled = subagentWorkPanelTab("d1", "Fix the cache stampede");
  assert.equal(titled.id, "subagent:d1");
  assert.equal(titled.kind, "subagent");
  assert.equal(titled.resource, "d1");
  assert.equal(titled.label, "Fix the cache stampede");
  // No captured title leaves the label to the strip's own localized name.
  assert.equal(subagentWorkPanelTab("d2").label, undefined);
  assert.equal(subagentWorkPanelTab("d3", "").label, undefined);
});

async function setup() {
  const vite = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
  });
  const { ToolRow } = await vite.ssrLoadModule(
    "/src/features/chat/transcript/ToolRow.tsx",
  );
  const { SubagentTaskCard } = await vite.ssrLoadModule(
    "/src/features/chat/transcript/SubagentTaskCard.tsx",
  );
  const { TranscriptDisclosureProvider } = await vite.ssrLoadModule(
    "/src/features/chat/transcript/disclosure.tsx",
  );
  const { SubagentTitleProvider } = await vite.ssrLoadModule(
    "/src/lib/subagent-title-provider.tsx",
  );
  const render = (node, messages) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        messages
          ? createElement(
              SubagentTitleProvider,
              { messages },
              createElement(TranscriptDisclosureProvider, null, node),
            )
          : createElement(TranscriptDisclosureProvider, null, node),
      ),
    );
  const card = (message) =>
    createElement(ToolRow, { message, variant: "task" });
  return {
    vite,
    render,
    card,
    ToolRow,
    SubagentTaskCard,
    SubagentTitleProvider,
    TranscriptDisclosureProvider,
    i18n,
  };
}

test("a card renders the task title with the role on its own line beneath it", async () => {
  const { vite, render, card } = await setup();
  try {
    const call = taskCall("t1", "call-1", {
      description: "Fix the cache stampede",
      agent: "manifestor",
    });
    const html = render(card(call));

    const title = html.match(
      /<span class="subagent-task-title" title="([^"]*)">([^<]*)<\/span>/,
    );
    assert.ok(title, html.slice(0, 400));
    assert.equal(title[2], "Fix the cache stampede");
    // The hover states the whole title, which the card clamps to two lines.
    assert.equal(title[1], "Fix the cache stampede");

    // The role reads under the title, where the child's step count used to sit,
    // and never in the title row beside the state: the title keeps its width for
    // the work's own name.
    const titleRow = html.slice(
      html.indexOf('class="subagent-task-title-row"'),
      html.indexOf('class="subagent-task-role"'),
    );
    assert.doesNotMatch(titleRow, /subagent-task-role/);
    assert.match(titleRow, /class="subagent-task-state"/);
    assert.match(html, /subagent-task-role" title="Subagent">manifestor<\/span>/);
    assert.ok(
      html.indexOf('class="subagent-task-copy"') < html.indexOf("subagent-task-role"),
    );

    // Neither the model nor the reasoning level reaches the card.
    assert.doesNotMatch(html, /test-model/);
    assert.doesNotMatch(html, /thinking/);
    assert.doesNotMatch(html, /subagent-task-summary/);

    // The title is stated once as a title: the card has no second description
    // line, and the brief stays in the child's transcript.
    assert.equal(html.split(">Fix the cache stampede<").length - 1, 1);
    assert.doesNotMatch(html, /Do the whole job and report back/);

    // A card is not a disclosure: opening the child's transcript is what it
    // does, so it carries no expanded state, no caret and no body.
    assert.doesNotMatch(html, /aria-expanded/);
    assert.doesNotMatch(html, /aria-controls/);
    assert.doesNotMatch(html, /tool-row-body/);
    assert.doesNotMatch(html, /tool-row-caret/);
    assert.match(html, /<span class="subagent-task-status" role="status"/);
    assert.match(html, />Completed</);
  } finally {
    await vite.close();
  }
});

test("a card of a resumed chain keeps the original title, and a titleless card falls back", async () => {
  const { vite, render, card } = await setup();
  try {
    const original = taskCall("t1", "call-1", {
      description: "Fix the cache stampede",
      delegationId: "d1",
      agent: "manifestor",
    });
    const resume = taskCall("t2", "call-2", {
      description: "Continue the cache work",
      resume: "d1",
      delegationId: "d2",
      agent: "inspector",
      status: "running",
    });
    const html = render(
      createElement("div", null, card(original), card(resume)),
      [original, resume],
    );
    // Both cards of the chain read the original title; the continuation's own
    // description never renames the work, and the role still differs per card.
    assert.equal(html.split(">Fix the cache stampede<").length - 1, 2);
    assert.doesNotMatch(html, /Continue the cache work/);
    assert.match(html, /subagent-task-role" title="Subagent">manifestor<\/span>/);
    assert.match(html, /subagent-task-role" title="Subagent">inspector<\/span>/);

    // An older log with no description anywhere is named by its role, and a
    // card with neither shows the localized unnamed label once.
    const untitled = render(
      createElement(
        "div",
        null,
        card(taskCall("t3", "call-3", { delegationId: "d3", agent: "inspector" })),
        card(taskCall("t4", "call-4", { delegationId: "d4", agent: "" })),
      ),
    );
    assert.match(
      untitled,
      /<span class="subagent-task-title" title="inspector">inspector<\/span>/,
    );
    // A role that already names the card is not printed beside itself.
    assert.equal(untitled.split("subagent-task-role").length - 1, 0);
    assert.equal(untitled.split(">Unnamed subagent<").length - 1, 1);
  } finally {
    await vite.close();
  }
});

test("one chain split across two activity groups keeps one title, card and tab", async () => {
  const { vite, render, card } = await setup();
  try {
    const original = taskCall("g1-call", "call-1", {
      description: "Fix the cache stampede",
      delegationId: "d1",
      agent: "manifestor",
    });
    const continuation = taskCall("g2-call", "call-2", {
      description: "Continue the cache work",
      resume: "d1",
      delegationId: "d2",
      agent: "inspector",
      status: "running",
    });
    // The shape a transcript produces: one provider for the conversation, and
    // one activity part per group. The continuation sits in a part of its own,
    // so its chain starts in a part this group cannot see.
    const html = render(
      createElement(
        "div",
        null,
        createElement("div", { "data-part": "first" }, card(original)),
        createElement("div", { "data-part": "second" }, card(continuation)),
      ),
      [original, continuation],
    );

    // Both cards read the chain's original title, and the continuation's own
    // description never reaches the screen.
    assert.equal(html.split(">Fix the cache stampede<").length - 1, 2, html);
    assert.doesNotMatch(html, /Continue the cache work/);
    // The resumed card keeps its own role under the chain's original title.
    assert.match(
      html,
      /data-message-id="g2-call"[\s\S]*?subagent-task-title" title="Fix the cache stampede">Fix the cache stampede<\/span>[\s\S]*?subagent-task-role" title="Subagent">inspector<\/span>/,
    );
    // The card hands the tab the same string it prints, so the tab opened from
    // the continuation group is labelled with the original title too.
    const printedTitle = html.match(
      /data-message-id="g2-call"[\s\S]*?subagent-task-title"[^>]*>([^<]*)</,
    )?.[1];
    const preferredTab = subagentWorkPanelTab("d2", printedTitle);
    assert.equal(preferredTab.id, "subagent:d2");
    assert.equal(preferredTab.label, "Fix the cache stampede");
  } finally {
    await vite.close();
  }
});

test("without a transcript surface a lone card still falls back to its own calls", async () => {
  const { vite, render, card } = await setup();
  try {
    const continuation = taskCall("g2-call", "call-2", {
      description: "Continue the cache work",
      resume: "d1",
      delegationId: "d2",
      agent: "inspector",
    });
    // The provider is what carries the chain across groups; a card rendered
    // with neither provider nor the chain's original call has only its own
    // description to read, which is why the transcript supplies the map.
    const html = render(card(continuation));
    assert.match(html, />Continue the cache work</);

    const titled = render(card(continuation), [
      taskCall("g1-call", "call-1", {
        description: "Fix the cache stampede",
        delegationId: "d1",
        agent: "manifestor",
      }),
      continuation,
    ]);
    assert.match(titled, />Fix the cache stampede</);
    assert.doesNotMatch(titled, /Continue the cache work/);
  } finally {
    await vite.close();
  }
});
