import { useEffect, useRef, useState } from "react";
import { Input } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { resolveWakeValueCommit } from "../../lib/subagent-settings-save";

export type ThresholdOption = { id: string; label: string };

/** Default granularity: one whole display unit. */
function defaultRound(value: number): number {
  return Math.floor(value);
}
/**
 * One compact threshold control: a bounded compact numeric value with its unit,
 * then the trigger selector, laid out in three reserved columns flush to the
 * row's right edge — so the selector stays the rightmost control and keeps its
 * position when the selected kind's label or unit changes width, and when the
 * kind carries no value at all.
 *
 * The Subagent execution rows share it, so selector geometry, the numeric
 * width, per-kind draft memory, and commit-on-blur rules cannot drift apart
 * between them. The feature name and its explanation live on the enclosing
 * settings row, not here: this component is the control column only. The value
 * edited here is the *display* unit — seconds, calls, thousands of tokens,
 * minutes — and the caller converts to the stored unit before saving;
 * `valueBounds` therefore maps display ranges per enabled kind.
 *
 * `round` is the granularity the numeric field edits in: whole units by
 * default, and a token-exact rounding for a k-token field, whose stored count
 * may not be a whole thousand. It receives the kind the value belongs to, so a
 * kind switch rounds the incoming draft like an edit of that kind would.
 *
 * Every kind keeps its own draft while inactive, so switching away and back
 * restores what the user last typed. A kind with no bounds entry is the
 * "no value" option (off): the numeric field is not rendered at all — never a
 * hidden or disabled focus target — while the grid's value and unit columns
 * stay reserved, so the selector does not move.
 */
export function SubagentThresholdRow({
  label,
  valueLabel,
  kind,
  value,
  options,
  valueBounds,
  defaults,
  unit,
  step,
  round = defaultRound,
  onSelectKind,
  onCommitValue,
}: {
  /**
   * Accessible name of the trigger selector.
   *
   * The visible feature name on the left of the row names the setting and
   * carries the explanation, so the selector has no visible label of its own;
   * it takes the feature name as its own name to stay unambiguous on its own.
   */
  label: string;
  /** Accessible name of the numeric field: which value of the feature it edits. */
  valueLabel: string;
  kind: string;
  /** Resolved display value for the active kind; undefined when off. */
  value: number | undefined;
  options: readonly ThresholdOption[];
  /** Display bounds per enabled kind id. Ids absent here carry no value. */
  valueBounds: Record<string, readonly [number, number]>;
  /** Remembered display default per enabled kind id. */
  defaults: Record<string, number>;
  unit: string;
  step: number;
  /** Rounds a typed display value onto the granularity of the kind it belongs to. */
  round?: (value: number, kind: string) => number;
  onSelectKind: (nextKind: string, nextValue: number | undefined) => void;
  onCommitValue: (nextKind: string, nextValue: number) => void;
}) {
  const bounds = valueBounds[kind];
  const isOff = bounds === undefined;

  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [id, fallback] of Object.entries(defaults)) {
      initial[id] = String(fallback);
    }
    if (value !== undefined && bounds !== undefined) {
      initial[kind] = String(round(value, kind));
    }
    return initial;
  });

  // Follow the stored value when it changes externally, without clobbering a
  // draft the user is editing: a same-kind update is adopted only when the
  // draft still matched the previous resolved value, while a kind switch
  // always adopts the stored value.
  const lastResolved = useRef<{ kind: string; value?: number }>({ kind, value });
  useEffect(() => {
    const previous = lastResolved.current;
    lastResolved.current = { kind, value };
    if (value === undefined) return;
    const next = String(round(value, kind));
    setDrafts((current) => {
      if (current[kind] === next) return current;
      if (kind !== previous.kind) return { ...current, [kind]: next };
      const prevText =
        previous.value !== undefined && previous.kind === kind
          ? String(previous.value)
          : undefined;
      if (prevText !== undefined && current[kind] !== prevText) return current;
      return { ...current, [kind]: next };
    });
  }, [kind, value]);

  const draft = isOff ? "" : (drafts[kind] ?? String(defaults[kind] ?? ""));
  const activeBounds = bounds ?? [1, 1];

  const selectKind = (nextKind: string) => {
    if (nextKind === kind) return;
    if (!options.some((option) => option.id === nextKind)) return;
    const nextBounds = valueBounds[nextKind];
    if (nextBounds === undefined) {
      onSelectKind(nextKind, undefined);
      return;
    }
    const remembered = drafts[nextKind] ?? String(defaults[nextKind] ?? "");
    const parsed = Number(remembered);
    const nextValue = Number.isFinite(parsed)
      ? Math.min(nextBounds[1], Math.max(nextBounds[0], round(parsed, nextKind)))
      : defaults[nextKind];
    setDrafts((current) => ({ ...current, [nextKind]: String(nextValue) }));
    onSelectKind(nextKind, nextValue);
  };

  const commitValue = () => {
    if (isOff) return;
    const decision = resolveWakeValueCommit(
      draft,
      value,
      activeBounds[0],
      activeBounds[1],
      (typed) => round(typed, kind),
    );
    if (decision.action === "revert") {
      setDrafts((current) => ({ ...current, [kind]: decision.draft }));
      return;
    }
    setDrafts((current) => ({ ...current, [kind]: String(decision.next) }));
    if (decision.next === value) return;
    onCommitValue(kind, decision.next);
  };

  return (
    <div className="settings-threshold-control">
      {isOff ? null : (
        <>
          <Input
            type="number"
            min={activeBounds[0]}
            max={activeBounds[1]}
            step={step}
            inputMode="numeric"
            value={draft}
            aria-label={valueLabel}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [kind]: event.target.value,
              }))
            }
            onBlur={commitValue}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            className="settings-threshold-input"
          />
          <span className="settings-number-unit" title={unit}>
            {unit}
          </span>
        </>
      )}
      {/*
        Selector column sizer: every option label, laid out in one hidden grid
        cell, so the column is as wide as the longest label this locale can
        show. The trigger then never sizes to the label that happens to be
        selected, and the two execution rows — which offer the same options —
        reserve the same width. It is invisible, zero-height and absent from
        the accessibility tree, so it cannot be focused or read; the visible
        trigger keeps its own label.
      */}
      <span className="settings-threshold-select-sizer" aria-hidden="true">
        {options.map((option) => (
          <span key={option.id}>{option.label}</span>
        ))}
      </span>
      <SettingsMenuSelect
        value={kind}
        label={label}
        onChange={selectKind}
        options={options.map((option) => ({ id: option.id, label: option.label }))}
      />
    </div>
  );
}
