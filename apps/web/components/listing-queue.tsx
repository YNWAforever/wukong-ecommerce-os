"use client";
import { useLocale } from "../lib/locale-context";
import { localized, commonCopy, formatHkDate } from "../lib/ui-copy";
import Link from "next/link";

import { queueGroups, type QueueItem } from "./listing-view-models";

type ListingQueueProps = {
  items: QueueItem[];
  selected: Set<string>;
  eligibleIds: string[];
  onToggle: (id: string) => void;
  onSelectAllEligible: () => void;
};

export function ListingQueue({
  items,
  selected,
  eligibleIds,
  onToggle,
  onSelectAllEligible,
}: ListingQueueProps) {
  const locale = useLocale();
  const c = commonCopy[locale];
  const eligibleSet = new Set(eligibleIds);
  return (
    <section className="queue" aria-labelledby="queue-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {localized(locale, "工作佇列", "Work queue")}
          </p>
          <h2 id="queue-heading">
            {localized(locale, "下一步工作", "Next actions")}
          </h2>
        </div>
        <Link className="text-link" href="/listings/new">
          {c.createDraft}
          <span aria-hidden="true"> →</span>
        </Link>
      </div>
      <div className="queue-groups">
        {queueGroups.map((group) => {
          const groupItems = items.filter(
            (item) => item.status === group.status,
          );
          const groupEligibleCount = groupItems.filter((item) =>
            eligibleSet.has(item.id),
          ).length;
          return (
            <section
              className="queue-group"
              key={group.status}
              aria-labelledby={`queue-${group.status}`}
            >
              <div className="queue-group-heading">
                <div>
                  <h3 id={`queue-${group.status}`}>
                    {localized(locale, group.label, group.englishLabel)}
                  </h3>
                </div>
                {group.status === "in_review" && groupEligibleCount > 0 ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={onSelectAllEligible}
                  >
                    {localized(locale, "全選可批准項目", "Select all eligible")}
                  </button>
                ) : null}
                <span
                  className="count-badge"
                  aria-label={localized(
                    locale,
                    `${groupItems.length} 個項目`,
                    `${groupItems.length} items`,
                  )}
                >
                  {groupItems.length}
                </span>
              </div>
              {groupItems.length > 0 ? (
                <ul className="queue-list">
                  {groupItems.map((item) => {
                    const eligible = eligibleSet.has(item.id);
                    return (
                      <li key={item.id} className="queue-item">
                        {item.status === "in_review" ? (
                          <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            disabled={!eligible}
                            aria-label={
                              eligible
                                ? localized(
                                    locale,
                                    `選取 ${item.title}`,
                                    `Select ${item.title}`,
                                  )
                                : item.openBlockingFlagCount > 0
                                  ? localized(
                                      locale,
                                      `${item.title} · ${item.openBlockingFlagCount} 個未解決的合規標記`,
                                      `${item.title} · ${item.openBlockingFlagCount} unresolved compliance flags`,
                                    )
                                  : localized(
                                      locale,
                                      `${item.title} · 請開啟項目完成審核`,
                                      `${item.title} · Open listing to complete review`,
                                    )
                            }
                            title={
                              eligible
                                ? undefined
                                : item.openBlockingFlagCount > 0
                                  ? localized(
                                      locale,
                                      `${item.title} · ${item.openBlockingFlagCount} 個未解決的合規標記`,
                                      `${item.title} · ${item.openBlockingFlagCount} unresolved compliance flags`,
                                    )
                                  : localized(
                                      locale,
                                      `${item.title} · 請開啟項目完成審核`,
                                      `${item.title} · Open listing to complete review`,
                                    )
                            }
                            onChange={() => onToggle(item.id)}
                          />
                        ) : null}
                        <div>
                          <Link
                            className="queue-item-title"
                            href={`/listings/${item.id}`}
                          >
                            {item.title}
                          </Link>
                          <p>{item.subtitle}</p>
                          <time dateTime={item.updatedAt}>
                            {formatHkDate(item.updatedAt, locale)}
                          </time>
                        </div>
                        <Link
                          className="secondary-button queue-action"
                          href={`/listings/${item.id}`}
                        >
                          {item.nextAction}
                          <span aria-hidden="true"> →</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="empty-state">{c.empty}</p>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
