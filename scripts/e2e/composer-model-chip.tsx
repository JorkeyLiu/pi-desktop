import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useRef, useState } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { SessionThinkingLevel } from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import { ComposerModelPicker } from "../../apps/desktop/src/features/chat/composer/ComposerModelPicker";
import { ComposerPermissionPicker } from "../../apps/desktop/src/features/chat/composer/ComposerPermissionPicker";
import { ComposerSendButton } from "../../apps/desktop/src/features/chat/composer/ComposerPrimaryAction";
import { ModeIcon } from "../../apps/desktop/src/features/chat/composer/ComposerModeIcon";
import type { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { IconPlus } from "../../apps/desktop/src/components/icons";
import { TooltipButton } from "../../apps/desktop/src/components/ui";

declare global {
  var composerModelChipProbe: () => Promise<unknown>;
}

/*
 * The Composer model chip at the widths a real chat column takes: the toolbar's
 * own production controls (attachment, mode, permission, model/reasoning,
 * send), the application's stylesheet, and a probe that measures what the
 * window paints. Nothing here re-implements the chip; the fixture only supplies
 * the controller the toolbar would own.
 */

const LEVELS: SessionThinkingLevel[] = ["omit", "off", "low", "medium", "high", "xhigh", "max"];

type Case = {
  width: number;
  /** The complete wire id the runtime would receive. */
  wireId: string;
  /** A configured alias, when the user named the model themselves. */
  alias?: string;
  level: SessionThinkingLevel;
  /** What the chip must paint as the model name. */
  expectModel: string;
  /** Whether the name must fit, or may ellipsize, at this width. */
  expectModelTruncated: boolean;
  /** Toolbar rows the controls need at this width. */
  expectRows: 1 | 2;
};

const CASES: Case[] = [
  // The reported case: the routing prefix used to consume the whole chip.
  {
    width: 760,
    wireId: "opencode-go/deepseek-v4.1-flash",
    level: "medium",
    expectModel: "deepseek-v4.1-flash",
    expectModelTruncated: false,
    expectRows: 1,
  },
  {
    width: 340,
    wireId: "opencode-go/deepseek-v4.1-flash",
    level: "medium",
    expectModel: "deepseek-v4.1-flash",
    expectModelTruncated: false,
    expectRows: 2,
  },
  {
    width: 280,
    wireId: "opencode-go/deepseek-v4.1-flash",
    level: "medium",
    expectModel: "deepseek-v4.1-flash",
    expectModelTruncated: false,
    expectRows: 2,
  },
  // An alias is the user's own name for the model and stays as typed.
  {
    width: 340,
    wireId: "opencode-go/fast-coder-7b",
    alias: "fast-coder",
    level: "minimal",
    expectModel: "fast-coder",
    expectModelTruncated: false,
    expectRows: 2,
  },
  // One very long name: the name ellipsizes, the level never does.
  {
    width: 340,
    wireId: "anthropic/claude-sonnet-4-6-experimental-long-context-2026",
    level: "medium",
    expectModel: "claude-sonnet-4-6-experimental-long-context-2026",
    expectModelTruncated: true,
    expectRows: 2,
  },
  {
    width: 280,
    wireId: "deepseek-v4.1-flash",
    level: "low",
    expectModel: "deepseek-v4.1-flash",
    expectModelTruncated: false,
    expectRows: 2,
  },
];

const noop = () => {};

function Toolbar({
  t,
  width,
  modelLabel,
  wireId,
  level,
}: {
  t: TFunction;
  width: number;
  modelLabel: string;
  wireId: string;
  level: SessionThinkingLevel;
}) {
  const [open, setOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const controller: ReturnType<typeof useComposerModelMenu> = {
    open,
    setOpen,
    otherModelsExpanded: false,
    setOtherModelsExpanded: noop,
    hasOtherModels: false,
    query: "",
    setQuery: noop,
    modelHighlight: -1,
    setModelHighlight: noop,
    modelSearchRef: searchRef,
    modelListRef: listRef,
    modelGroups: [],
    recentEntries: [],
    flatModels: [],
    thinkingMenuLevels: LEVELS,
    selectModel: async () => {},
    commitThinkingLevel: async () => true,
    onMenuKeyDown: noop,
    controlsBlocked: false,
  };
  return (
    <div className="composer-stack" style={{ width, transition: "none" }}>
      <div className="composer-shell">
        <div className="composer-toolbar">
          <div className="composer-left">
            <div className="composer-plus">
              <TooltipButton
                type="button"
                className="icon-btn icon-btn-square"
                tooltip={t("chat.addFiles")}
                ariaLabel={t("chat.addFiles")}
                onClick={noop}
              >
                <IconPlus size={15} aria-hidden="true" />
              </TooltipButton>
            </div>
            <TooltipButton
              type="button"
              className="icon-btn mode-chip composer-mode-chip"
              data-mode="agent"
              tooltip={t("settings.mode")}
              ariaLabel={t("settings.mode")}
              onClick={noop}
            >
              <span className="composer-mode-chip-face">
                <ModeIcon mode="agent" />
                <span className="composer-mode-chip-label text-sm">{t("settings.modeAgent")}</span>
              </span>
            </TooltipButton>
            <ComposerPermissionPicker
              t={t}
              mode="agent"
              composerPermissionMode="ask"
              permissionOpen={permissionOpen}
              setPermissionOpen={setPermissionOpen}
              controlsBlocked={false}
              onCloseOtherMenus={noop}
              onSelect={noop}
            />
          </div>
          <div className="composer-right">
            <ComposerModelPicker
              t={t}
              controller={controller}
              modelLabel={modelLabel}
              thinkingLabel={level}
              thinkingLevel={level}
              selectedProviderId="opencode-go"
              selectedModelId={wireId}
              controlsBlocked={false}
              onCloseOtherMenus={noop}
            />
            <ComposerSendButton
              ariaLabel={t("chat.send")}
              tooltip={t("chat.send")}
              onClick={noop}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

type Probe = { failures: string[]; observed: Record<string, unknown> };

const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

function element<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

const box = (node: Element) => node.getBoundingClientRect();

/**
 * The painted width of an element's text. `scrollWidth` rounds to whole pixels
 * and a fractional line box can look clipped when it is not, so the probe
 * compares real geometry instead. One and a half pixels is the sub-pixel noise
 * of font shaping; anything wider is a visible ellipsis.
 */
const textWidth = (node: HTMLElement) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect().width;
};
const TEXT_SLACK = 1.5;
const isTruncated = (node: HTMLElement) =>
  textWidth(node) - node.getBoundingClientRect().width > TEXT_SLACK;

globalThis.composerModelChipProbe = async () => {
  const probe: Probe = { failures: [], observed: {} };
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) probe.observed[name] = detail ?? true;
    else probe.failures.push(`${name}: ${JSON.stringify(detail ?? null)}`);
  };

  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });
  await document.fonts.ready;

  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:0;top:0;padding:8px";
  document.body.append(host);
  const root = createRoot(host);
  const t = i18n.t.bind(i18n) as TFunction;

  const reasoningLabel = catalogs.en.chat.reasoningLevel as string;

  for (const [index, config] of CASES.entries()) {
    const modelLabel = config.alias ?? config.wireId;
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Toolbar
            t={t}
            width={config.width}
            modelLabel={modelLabel}
            wireId={config.wireId}
            level={config.level}
          />
        </I18nextProvider>,
      ),
    );
    await settle();

    const label = `${config.width}/${modelLabel}`;
    const stack = element<HTMLElement>(host, ".composer-stack");
    const shell = element<HTMLElement>(host, ".composer-shell");
    const toolbar = element<HTMLElement>(host, ".composer-toolbar");
    const left = element<HTMLElement>(host, ".composer-left");
    const right = element<HTMLElement>(host, ".composer-right");
    const chip = element<HTMLElement>(host, ".composer-model-thinking-chip");
    const wrapper = element<HTMLElement>(host, ".composer-model-thinking");
    const model = element<HTMLElement>(host, ".composer-model-thinking-model");
    const level = element<HTMLElement>(host, ".composer-model-thinking-level");
    const dot = element<HTMLElement>(host, ".composer-model-thinking-dot");
    const send = element<HTMLElement>(host, ".send-btn");
    const attach = element<HTMLElement>(host, ".composer-plus button");
    const permission = element<HTMLElement>(host, ".composer-permission button");

    const stackBox = box(stack);
    const shellBox = box(shell);
    const chipBox = box(chip);

    // ── 1. The painted model name is the model, not its routing namespace ──
    check(
      `${label}: the chip paints the model name`,
      model.textContent === config.expectModel,
      { painted: model.textContent, expected: config.expectModel },
    );
    if (config.alias) {
      check(
        `${label}: an alias stays as the user typed it`,
        !model.textContent?.includes("/"),
        model.textContent,
      );
    }

    // ── 2. The reasoning level is a stable slot: shown, never ellipsized ──
    check(
      `${label}: the reasoning level is painted`,
      level.textContent === config.level && box(level).width > 0,
      { painted: level.textContent, width: box(level).width },
    );
    check(
      `${label}: the reasoning level is not truncated`,
      !isTruncated(level),
      { text: textWidth(level), box: box(level).width },
    );
    check(
      `${label}: the level and its separator sit inside the chip`,
      box(level).right <= chipBox.right - 0.5 && box(dot).width > 0,
      { levelRight: box(level).right, chipRight: chipBox.right, dotWidth: box(dot).width },
    );
    check(
      `${label}: only the model name may ellipsize`,
      chip.scrollWidth <= chip.clientWidth + 1,
      { chipScroll: chip.scrollWidth, chipClient: chip.clientWidth },
    );
    check(
      `${label}: the model name ${config.expectModelTruncated ? "ellipsizes" : "fits"}`,
      isTruncated(model) === config.expectModelTruncated,
      {
        truncated: isTruncated(model),
        expected: config.expectModelTruncated,
        text: textWidth(model),
        box: box(model).width,
      },
    );

    // ── 3. The complete ids stay reachable on the trigger ──
    const accessibleName = chip.getAttribute("aria-label") ?? "";
    check(
      `${label}: the accessible name carries the complete wire id and level`,
      accessibleName.includes(config.wireId) &&
        accessibleName.includes(reasoningLabel) &&
        accessibleName.includes(config.level),
      accessibleName,
    );
    if (config.alias) {
      check(
        `${label}: the accessible name keeps alias and wire id`,
        accessibleName.includes(modelLabel),
        accessibleName,
      );
    }

    // ── 4. Nothing overflows the composer, and no control is squeezed out ──
    check(
      `${label}: the composer does not overflow horizontally`,
      shell.scrollWidth <= shell.clientWidth + 1 && shellBox.width <= stackBox.width + 0.5,
      {
        shellScroll: shell.scrollWidth,
        shellClient: shell.clientWidth,
        shellWidth: shellBox.width,
        stackWidth: stackBox.width,
      },
    );
    for (const [name, node] of [
      ["attachment", attach],
      ["permission", permission],
      ["model chip", chip],
      ["send", send],
    ] as const) {
      const control = box(node);
      check(
        `${label}: the ${name} control stays inside the shell`,
        control.width >= 20 &&
          control.height > 0 &&
          control.left >= shellBox.left - 0.5 &&
          control.right <= shellBox.right + 0.5,
        { left: control.left, right: control.right, width: control.width, shell: [shellBox.left, shellBox.right] },
      );
    }
    check(
      `${label}: the chip sits inside its own slot`,
      chipBox.right <= box(wrapper).right + 0.5,
      { chipRight: chipBox.right, wrapperRight: box(wrapper).right },
    );

    // ── 5. The toolbar takes a second row before it truncates a control ──
    const rows = new Set(
      [...toolbar.children].map((child) => Math.round(box(child).top)),
    );
    check(
      `${label}: the toolbar uses the expected rows`,
      rows.size === config.expectRows,
      { rows: rows.size, expected: config.expectRows },
    );
    if (rows.size === 2) {
      check(
        `${label}: the wrapped action row sits below the mode row`,
        box(right).top > box(left).top &&
          box(left).bottom <= box(right).top &&
          box(right).bottom <= shellBox.bottom + 0.5,
        { leftBottom: box(left).bottom, rightTop: box(right).top, rightBottom: box(right).bottom },
      );
    }
    check(
      `${label}: both clusters stay inside the toolbar`,
      box(left).right <= shellBox.right + 0.5 && box(right).right <= shellBox.right + 0.5,
      { leftRight: box(left).right, rightRight: box(right).right, shellRight: shellBox.right },
    );

    probe.observed[`${label}`] = {
      case: index,
      rows: rows.size,
      chip: { width: chipBox.width, right: chipBox.right },
      model: { painted: model.textContent, width: box(model).width, truncated: model.scrollWidth > model.clientWidth + 0.5 },
      level: { painted: level.textContent, width: box(level).width },
      send: { width: box(send).width },
      accessibleName,
    };
  }

  return { ok: probe.failures.length === 0, failures: probe.failures, observed: probe.observed };
};
