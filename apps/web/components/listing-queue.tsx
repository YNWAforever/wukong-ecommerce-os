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
  const eligibleSet = new Set(eligibleIds);
  return (
    <section className="queue" aria-labelledby="queue-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            工作佇列 <span>WORK QUEUE</span>
          </p>
          <h2 id="queue-heading">下一步工作</h2>
        </div>
        <Link className="text-link" href="/listings/new">
          建立上架草稿<span aria-hidden="true"> →</span>
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
                  <h3 id={`queue-${group.status}`}>{group.label}</h3>
                  <p>{group.englishLabel}</p>
                </div>
                {group.status === "in_review" && groupEligibleCount > 0 ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={onSelectAllEligible}
                  >
                    全選可批准項目 Select all eligible
                  </button>
                ) : null}
                <span
                  className="count-badge"
                  aria-label={`${groupItems.length} items`}
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
                                ? `選取 ${item.title}`
                                : `${item.title} · ${item.openBlockingFlagCount} 個未解決的合規標記`
                            }
                            title={
                              eligible
                                ? undefined
                                : `${item.title} · ${item.openBlockingFlagCount} 個未解決的合規標記 · ${item.openBlockingFlagCount} unresolved compliance flags`
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
                            {item.updatedAt}
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
                <p className="empty-state">
                  目前沒有項目 <span>No items</span>
                </p>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
