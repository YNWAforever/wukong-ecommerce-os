import Link from "next/link";
import type { WorkbenchItem } from "@wukong/db";
import type { Locale } from "../lib/locale";
import { workbenchCopy } from "../lib/workbench-copy";
import { workbenchDestination } from "../lib/workbench-actions";
export type WorkbenchCapabilities = {
  canImport: boolean;
  canReview: boolean;
  canRecordImportResult: boolean;
};
export function WorkbenchList({
  items,
  capabilities,
  locale,
  returnTo,
}: {
  items: WorkbenchItem[];
  capabilities: WorkbenchCapabilities;
  locale: Locale;
  returnTo: string;
}) {
  const copy = workbenchCopy[locale];
  return (
    <ul className="workbench-list">
      {items.map((item) => (
        <li key={item.key} className="workbench-row">
          <div className="workbench-row-content">
            <span className="workbench-kind">{copy.kinds[item.kind]}</span>
            <h3>
              {item.title ||
                (item.kind === "export"
                  ? `${copy.exportAttempt} ${item.id.slice(0, 8)}`
                  : copy.untitled)}
            </h3>
            <p>{copy.reasons[item.reason]}</p>
            {item.reason === "result_reported" && (
              <p>{copy.reportedQualifier}</p>
            )}
            <div className="workbench-meta">
              {item.sourceLabel && <span>{item.sourceLabel} · </span>}
              {item.productCount !== null ? (
                <span>
                  {item.productCount.toLocaleString(locale)} {copy.products}{" "}
                  ·{" "}
                </span>
              ) : (
                <span>{copy.countUnavailable} · </span>
              )}
              <span>
                {item.timestampKind === "recorded"
                  ? copy.recorded
                  : copy.updated}
                :{" "}
                <time dateTime={item.occurredAt}>
                  {new Date(item.occurredAt).toLocaleString(locale, {
                    timeZone: "Asia/Hong_Kong",
                  })}
                </time>
              </span>
            </div>
          </div>
          <Link
            className="workbench-action"
            href={workbenchDestination(item, returnTo)}
          >
            {item.reason === "review" && capabilities.canReview
              ? copy.review
              : item.reason === "result_needed" &&
                  capabilities.canRecordImportResult
                ? copy.result
                : copy.view}
          </Link>
        </li>
      ))}
    </ul>
  );
}
