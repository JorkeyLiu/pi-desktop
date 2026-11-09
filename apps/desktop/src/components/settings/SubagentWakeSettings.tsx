import { useTranslation } from "react-i18next";
import type {
  AppSettings,
  SubagentWakeupKind,
  SubagentWakeupSettings,
} from "@pi-desktop/shared";
import {
  DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
  DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS,
  DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS,
  normalizeSubagentWakeupSettings,
  subagentHandoffKTokensToTokens,
  subagentHandoffMinutesToSeconds,
  subagentHandoffSecondsToMinutes,
  subagentHandoffTokensToKTokens,
  subagentWakeupBounds,
} from "@pi-desktop/shared";
import { roundSubagentThresholdValue } from "../../lib/subagent-settings-save";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { SubagentThresholdRow } from "./SubagentThresholdRow";

/** The stored section, whatever shape it has; the normalizer resolves it. */
function storedWakeup(settings: AppSettings): unknown {
  return (settings as { subagentWakeup?: unknown }).subagentWakeup;
}

/**
 * Storage unit → the unit this card edits.
 *
/**
 * Storage unit → the unit this row edits.
 *
 * Two triggers are stored in a unit the row does not edit in: the context
 * trigger is stored in tokens and edited in thousands (`k tokens`), and the
 * time trigger is stored in seconds and edited in minutes — the same units the
 * self-handoff row uses, so the two rows' figures mean the same thing. Tool
 * calls are edited in their stored unit. The conversions are the shared ones,
 * so the settings UI and the runtime cannot disagree about what a saved number
 * means.
 */
function toDisplay(kind: string, stored: number): number {
  if (kind === "context-tokens") return subagentHandoffTokensToKTokens(stored);
  if (kind === "time") return subagentHandoffSecondsToMinutes(stored);
  return stored;
}

function toStored(kind: string, display: number): number {
  if (kind === "context-tokens") return subagentHandoffKTokensToTokens(display);
  if (kind === "time") return subagentHandoffMinutesToSeconds(display);
  return Math.floor(display);
}

/**
 * Parent-side progress checks for the Subagents destination.
 *
 * One shaded full-width row: the feature name on the left, and flush to the
 * right edge a bounded numeric value with a visible unit followed by the
 * trigger selector that says when a waiting parent is told about delegate
 * progress (context size / tool calls / elapsed time / off, the same order and
 * the same labels the self-handoff row offers) — the selector last, so it is
 * the row's rightmost control for every kind. Subagent results reach the
 * parent — so there is no completion toggle. The options and units are the
 * self-handoff row's, so the two rows read alike, while the stored `kind`
 * identifiers stay the wake contract's. The row geometry and draft rules are
 * shared, and each kind remembers its own draft while inactive; saves replace
 * the whole `{kind, value}` section atomically through the page's save queue.
 * Context is edited in k tokens and time in minutes, while the persisted value
 * stays a raw token count and seconds, so the stored contract is unchanged.
 */
export function SubagentWakeSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const resolved = normalizeSubagentWakeupSettings(
    storedWakeup(settings) as SubagentWakeupSettings | null | undefined,
  );

  // The figure is shown rounded the way an edit of that kind would round it, so
  // a legacy value that is not a whole display unit reads exactly and is not
  // rewritten by merely opening or leaving the field.
  const displayValue =
    resolved.kind === "off" || resolved.value === undefined
      ? undefined
      : roundSubagentThresholdValue(
          toDisplay(resolved.kind, resolved.value),
          resolved.kind,
        );

  const unitLabel =
    resolved.kind === "time"
      ? t("settings.subagentSelfHandoffUnitMinutes")
      : resolved.kind === "tool-calls"
        ? t("settings.subagentSelfHandoffUnitCalls")
        : resolved.kind === "context-tokens"
          ? t("settings.subagentSelfHandoffUnitKTokens")
          : "";

  const save = async (next: SubagentWakeupSettings) => {
    try {
      // Atomic kind+value: the page rebases onto latest settings at execution
      // time and replaces the section, so rapid kind/value edits stay ordered
      // and a prior unit never leaks into the new kind.
      await saveSettings({ subagentWakeup: next } as Partial<AppSettings>);
    } catch (error) {
      // Drafts stay untouched so nothing the user typed is lost; the error is
      // observable and the selector reverts via the unchanged settings prop.
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  return (
    <SettingsCard>
      <SettingsRow
        title={t("settings.subagentWakeTitle")}
        description={t("settings.subagentWakeKindDesc")}
      >
        <SubagentThresholdRow
          label={t("settings.subagentWakeTitle")}
          valueLabel={t("settings.subagentWakeKind")}
          kind={resolved.kind}
          value={displayValue}
          options={[
            {
              id: "context-tokens",
              label: t("settings.subagentSelfHandoffKindContextTokens"),
            },
            { id: "tool-calls", label: t("settings.subagentSelfHandoffKindToolCalls") },
            { id: "time", label: t("settings.subagentSelfHandoffKindRuntime") },
            { id: "off", label: t("settings.subagentSelfHandoffKindOff") },
          ]}
          valueBounds={wakeBounds()}
          defaults={{
            time: toDisplay("time", DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS),
            "tool-calls": toDisplay("tool-calls", DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS),
            "context-tokens": toDisplay(
              "context-tokens",
              DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
            ),
          }}
          unit={unitLabel}
          step={1}
          round={roundSubagentThresholdValue}
          onSelectKind={(kind, value) =>
            void save(
              kind === "off" || value === undefined
                ? { kind: "off" }
                : ({
                    kind: kind as SubagentWakeupKind,
                    value: toStored(kind, value),
                  } as SubagentWakeupSettings),
            )
          }
          onCommitValue={(kind, value) =>
            void save({
              kind: kind as SubagentWakeupKind,
              value: toStored(kind, value),
            })
          }
        />
      </SettingsRow>
    </SettingsCard>
  );
}

/**
 * Display bounds per enabled kind, in the unit the row edits.
 *
 * The stored bounds are token counts and seconds; the fields show their k-token
 * and minute equivalents, so the context floor is 1 (1,000 tokens) and the
 * ceiling 1000 (1,000,000 tokens), and the time floor is 1 second and the
 * ceiling 900 seconds, rounded the same way the field rounds an edit. Tool
 * calls are already edited in their stored unit.
 */
function wakeBounds(): Record<string, readonly [number, number]> {
  const bounds: Record<string, readonly [number, number]> = {};
  for (const kind of ["time", "tool-calls", "context-tokens"] as const) {
    const range = subagentWakeupBounds(kind);
    if (range) {
      const display = [toDisplay(kind, range[0]), toDisplay(kind, range[1])] as const;
      bounds[kind] = [
        roundSubagentThresholdValue(display[0], kind),
        roundSubagentThresholdValue(display[1], kind),
      ] as const;
    }
  }
  return bounds;
}
