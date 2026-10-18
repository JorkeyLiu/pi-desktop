import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, SubagentWakeupKind, SubagentWakeupSettings } from "@pi-desktop/shared";
import {
  DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
  DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS,
  DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS,
  MAX_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
  MAX_SUBAGENT_WAKEUP_TIME_SECONDS,
  MAX_SUBAGENT_WAKEUP_TOOL_CALLS,
  MIN_SUBAGENT_WAKEUP_CONTEXT_TOKENS,
  MIN_SUBAGENT_WAKEUP_TIME_SECONDS,
  MIN_SUBAGENT_WAKEUP_TOOL_CALLS,
  normalizeSubagentWakeupSettings,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { Input } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { resolveWakeValueCommit } from "../../lib/subagent-settings-save";

function rawWakeup(settings: AppSettings): SubagentWakeupSettings | undefined {
  const candidate = (settings as { subagentWakeup?: unknown }).subagentWakeup;
  if (candidate && typeof candidate === "object" && "kind" in (candidate as Record<string, unknown>)) {
    return candidate as SubagentWakeupSettings;
  }
  // Legacy sections migrate through the normalizer; the renderer only needs
  // the resolved canonical view.
  return undefined;
}

function boundsFor(kind: SubagentWakeupKind): readonly [number, number] | null {
  if (kind === "time") return [MIN_SUBAGENT_WAKEUP_TIME_SECONDS, MAX_SUBAGENT_WAKEUP_TIME_SECONDS] as const;
  if (kind === "tool-calls") return [MIN_SUBAGENT_WAKEUP_TOOL_CALLS, MAX_SUBAGENT_WAKEUP_TOOL_CALLS] as const;
  if (kind === "context-tokens")
    return [MIN_SUBAGENT_WAKEUP_CONTEXT_TOKENS, MAX_SUBAGENT_WAKEUP_CONTEXT_TOKENS] as const;
  return null;
}

function defaultFor(kind: SubagentWakeupKind): string {
  if (kind === "time") return String(DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS);
  if (kind === "tool-calls") return String(DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS);
  return String(DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS);
}

/**
 * Single-setting wake control for the Subagents destination.
 *
 * One row: select the progress kind (elapsed time / tool calls / context
 * threshold / off), then a numeric value with a visible unit. Result delivery
 * is unconditional — settling delegates always wake the parent — so there is
 * no completion toggle and no per-row checkboxes. Each kind remembers its own
 * draft while inactive so switching back restores it; saves replace the whole
 * `{kind, value}` atomically and serialize through the page queue.
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
  const stored = rawWakeup(settings);
  const resolved = normalizeSubagentWakeupSettings(
    stored ?? (settings as { subagentWakeup?: unknown }).subagentWakeup as never,
  );
  const kind: SubagentWakeupKind = resolved.kind;

  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
    time: resolved.kind === "time" && resolved.value != null ? String(resolved.value) : String(DEFAULT_SUBAGENT_WAKEUP_TIME_SECONDS),
    "tool-calls":
      resolved.kind === "tool-calls" && resolved.value != null
        ? String(resolved.value)
        : String(DEFAULT_SUBAGENT_WAKEUP_TOOL_CALLS),
    "context-tokens":
      resolved.kind === "context-tokens" && resolved.value != null
        ? String(resolved.value)
        : String(DEFAULT_SUBAGENT_WAKEUP_CONTEXT_TOKENS),
  }));

  // Sync the active kind's draft when the stored value changes externally.
  // Inactive drafts are remembered untouched. A draft the user is editing is
  // never clobbered by our own save landing: it only follows when it still
  // matches the previous resolved value (no unsaved edit) or the kind itself
  // changed.
  const lastResolved = useRef<{ kind: SubagentWakeupKind; value?: number }>({
    kind: resolved.kind,
    value: resolved.value,
  });
  useEffect(() => {
    const previous = lastResolved.current;
    lastResolved.current = { kind: resolved.kind, value: resolved.value };
    if (resolved.kind === "off" || resolved.value == null) return;
    const next = String(resolved.value);
    setDrafts((current) => {
      if (current[resolved.kind] === next) return current;
      // Kind switch always follows the stored value; same-kind updates only
      // follow when there is no unsaved user edit in flight.
      if (resolved.kind !== previous.kind) return { ...current, [resolved.kind]: next };
      const prevText = previous.value != null && previous.kind === resolved.kind ? String(previous.value) : undefined;
      if (prevText !== undefined && current[resolved.kind] !== prevText) return current;
      return { ...current, [resolved.kind]: next };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.kind, resolved.value]);

  const draft = kind === "off" ? "" : (drafts[kind] ?? defaultFor(kind));
  const bounds = boundsFor(kind);
  const isOff = kind === "off";

  const unitLabel =
    kind === "time"
      ? t("settings.subagentWakeUnitSeconds")
      : kind === "tool-calls"
        ? t("settings.subagentWakeUnitCalls")
        : kind === "context-tokens"
          ? t("settings.subagentWakeUnitTokens")
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
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const selectKind = (nextKind: string) => {
    if (nextKind !== "time" && nextKind !== "tool-calls" && nextKind !== "context-tokens" && nextKind !== "off") {
      return;
    }
    if (nextKind === kind) return;
    if (nextKind === "off") {
      void save({ kind: "off" });
      return;
    }
    const remembered = drafts[nextKind] ?? defaultFor(nextKind);
    const parsed = Number(remembered);
    const nextBounds = boundsFor(nextKind);
    const value =
      nextBounds && Number.isFinite(parsed)
        ? Math.min(nextBounds[1], Math.max(nextBounds[0], Math.floor(parsed)))
        : Number(defaultFor(nextKind));
    setDrafts((current) => ({ ...current, [nextKind]: String(value) }));
    void save({ kind: nextKind, value });
  };

  const commitValue = () => {
    if (isOff || !bounds) return;
    const decision = resolveWakeValueCommit(draft, resolved.value, bounds[0], bounds[1]);
    if (decision.action === "revert") {
      setDrafts((current) => ({ ...current, [kind]: decision.draft }));
      return;
    }
    setDrafts((current) => ({ ...current, [kind]: String(decision.next) }));
    if (decision.next === resolved.value) return;
    void save({ kind, value: decision.next });
  };

  const step = kind === "context-tokens" ? 1000 : 1;

  return (
    <SettingsCard title={t("settings.subagentWakeTitle")} description={t("settings.subagentWakeDesc")}>
      <SettingsRow title={t("settings.subagentWakeKind")} description={t("settings.subagentWakeKindDesc")}>
        <div
          className="settings-wake-kind-control"
          style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}
        >
          <SettingsMenuSelect
            value={kind}
            label={t("settings.subagentWakeKind")}
            onChange={selectKind}
            options={[
              { id: "time", label: t("settings.subagentWakeKindTime") },
              { id: "tool-calls", label: t("settings.subagentWakeKindToolCalls") },
              { id: "context-tokens", label: t("settings.subagentWakeKindContextTokens") },
              { id: "off", label: t("settings.subagentWakeKindOff") },
            ]}
          />
          {isOff ? null : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Input
                type="number"
                min={bounds?.[0]}
                max={bounds?.[1]}
                step={step}
                inputMode="numeric"
                value={draft}
                disabled={isOff}
                aria-label={t("settings.subagentWakeKind")}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [kind]: event.target.value }))
                }
                onBlur={commitValue}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                style={{ width: 120 }}
              />
              <span className="settings-wake-unit" aria-hidden="true">
                {unitLabel}
              </span>
            </span>
          )}
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}
