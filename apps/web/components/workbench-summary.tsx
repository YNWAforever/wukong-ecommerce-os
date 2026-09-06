import type { WorkbenchPage, WorkbenchState } from "@wukong/db";
import type { Locale } from "../lib/locale";
import { workbenchCopy } from "../lib/workbench-copy";
export function WorkbenchSummary({
  counts,
  selected,
  locale,
  onSelect,
}: {
  counts: WorkbenchPage["counts"] | null;
  selected: WorkbenchState;
  locale: Locale;
  onSelect: (state: WorkbenchState) => void;
}) {
  const copy = workbenchCopy[locale];
  return (
    <div className="workbench-summary">
      {(["attention", "progress", "completed"] as const).map((state) => (
        <button
          key={state}
          type="button"
          aria-pressed={selected === state}
          onClick={() => onSelect(state)}
        >
          <span>{copy.states[state]}</span>
          {counts ? (
            <strong>{counts[state].toLocaleString(locale)}</strong>
          ) : (
            <span className="workbench-count-pending">—</span>
          )}
          <small>{copy.tasks}</small>
        </button>
      ))}
    </div>
  );
}
