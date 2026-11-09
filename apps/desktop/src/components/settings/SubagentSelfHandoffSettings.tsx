import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  SubagentSelfHandoffSettings,
} from "@pi-desktop/shared";
import {
  DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS,
  DEFAULT_SUBAGENT_HANDOFF_TOKENS,
  DEFAULT_SUBAGENT_HANDOFF_TOOL_CALLS,
  normalizeSubagentSelfHandoffSettings,
  subagentHandoffKTokensToTokens,
  subagentHandoffMinutesToSeconds,
  subagentHandoffSecondsToMinutes,
  subagentHandoffTokensToKTokens,
  subagentSelfHandoffBounds,
} from "@pi-desktop/shared";
import { roundSubagentThresholdValue } from "../../lib/subagent-settings-save";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { SubagentThresholdRow } from "./SubagentThresholdRow";

/** Stored section, whatever shape it has; the normalizer resolves it. */
function storedSection(settings: AppSettings): unknown {
  return (settings as { subagentSelfHandoff?: unknown }).subagentSelfHandoff;
}

/**
 * Storage unit → the unit this row edits.
 *
 * The context trigger is stored in tokens and seconds for the runtime trigger,
 * but a person sets them in k tokens and minutes. The conversions are the
 * shared ones, so the runtime and the settings UI cannot disagree about what a
 * saved number means.
 */
function toDisplay(kind: string, stored: number): number {
  if (kind === "context-tokens") return subagentHandoffTokensToKTokens(stored);
  if (kind === "runtime") return subagentHandoffSecondsToMinutes(stored);
  return stored;
}

function toStored(kind: string, display: number): number {
  if (kind === "context-tokens") return subagentHandoffKTokensToTokens(display);
  if (kind === "runtime") return subagentHandoffMinutesToSeconds(display);
  return Math.floor(display);
}

/** Display bounds per enabled kind; the off option carries no value. */
function displayBounds(): Record<string, readonly [number, number]> {
  const bounds: Record<string, readonly [number, number]> = {};
  for (const kind of ["context-tokens", "tool-calls", "runtime"] as const) {
    const range = subagentSelfHandoffBounds(kind);
    if (!range) continue;
    bounds[kind] = [toDisplay(kind, range[0]), toDisplay(kind, range[1])] as const;
  }
  return bounds;
}

/**
 * Delegates rolling their own context over, instead of waiting for compaction.
 *
 * One shaded full-width row: the feature name on the left, the trigger (off /
 * context size / tool calls / elapsed runtime) and its bounded value on the
 * right. Defaults to off, which is exactly what every settings document written
 * before this setting reads as. The value is saved in the runtime's own unit
 * (tokens, calls, seconds) and edited in the unit a person reads — k tokens and
 * minutes — so the persisted contract does not change shape.
 */
export function SubagentSelfHandoffSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const resolved = normalizeSubagentSelfHandoffSettings(
    storedSection(settings) as SubagentSelfHandoffSettings | null | undefined,
  );
  const displayValue =
    resolved.kind === "off" || resolved.value === undefined
      ? undefined
      : toDisplay(resolved.kind, resolved.value);

  const unitLabel =
    resolved.kind === "context-tokens"
      ? t("settings.subagentSelfHandoffUnitKTokens")
      : resolved.kind === "tool-calls"
        ? t("settings.subagentSelfHandoffUnitCalls")
        : resolved.kind === "runtime"
          ? t("settings.subagentSelfHandoffUnitMinutes")
          : "";

  const save = async (next: SubagentSelfHandoffSettings) => {
    try {
      await saveSettings({
        subagentSelfHandoff: next,
      } as Partial<AppSettings>);
    } catch (error) {
      // The draft stays as typed and the card reverts from the unchanged
      // settings prop; the failure is announced, never silently dropped.
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const defaults = {
    "context-tokens": toDisplay("context-tokens", DEFAULT_SUBAGENT_HANDOFF_TOKENS),
    "tool-calls": toDisplay("tool-calls", DEFAULT_SUBAGENT_HANDOFF_TOOL_CALLS),
    runtime: toDisplay("runtime", DEFAULT_SUBAGENT_HANDOFF_RUNTIME_SECONDS),
  } as const;

  return (
    <SettingsCard>
      <SettingsRow
        title={t("settings.subagentSelfHandoffTitle")}
        description={t("settings.subagentSelfHandoffKindDesc")}
      >
        <SubagentThresholdRow
          label={t("settings.subagentSelfHandoffTitle")}
          valueLabel={t("settings.subagentSelfHandoffThreshold")}
          kind={resolved.kind}
          value={displayValue}
          options={[
            {
              id: "context-tokens",
              label: t("settings.subagentSelfHandoffKindContextTokens"),
            },
            { id: "tool-calls", label: t("settings.subagentSelfHandoffKindToolCalls") },
            { id: "runtime", label: t("settings.subagentSelfHandoffKindRuntime") },
            { id: "off", label: t("settings.subagentSelfHandoffKindOff") },
          ]}
          valueBounds={displayBounds()}
          defaults={defaults}
          unit={unitLabel}
          step={1}
          round={roundSubagentThresholdValue}
          onSelectKind={(kind, value) =>
            void save(
              kind === "off" || value === undefined
                ? { kind: "off" }
                : ({ kind, value: toStored(kind, value) } as SubagentSelfHandoffSettings),
            )
          }
          onCommitValue={(kind, value) =>
            void save({
              kind,
              value: toStored(kind, value),
            } as SubagentSelfHandoffSettings)
          }
        />
      </SettingsRow>
    </SettingsCard>
  );
}
