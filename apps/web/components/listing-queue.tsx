import Link from "next/link";

import { queueGroups, type QueueItem } from "./listing-view-models";

type ListingQueueProps = { items: QueueItem[] };

export function ListingQueue({ items }: ListingQueueProps) {
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
                <span
                  className="count-badge"
                  aria-label={`${groupItems.length} items`}
                >
                  {groupItems.length}
                </span>
              </div>
              {groupItems.length > 0 ? (
                <ul className="queue-list">
                  {groupItems.map((item) => (
                    <li key={item.id} className="queue-item">
                      <div>
                        <Link
                          className="queue-item-title"
                          href={`/listings/${item.id}`}
                        >
                          {item.title}
                        </Link>
                        <p>{item.subtitle}</p>
                        <time dateTime={item.updatedAt}>{item.updatedAt}</time>
                      </div>
                      <Link
                        className="secondary-button queue-action"
                        href={`/listings/${item.id}`}
                      >
                        {item.nextAction}
                        <span aria-hidden="true"> →</span>
                      </Link>
                    </li>
                  ))}
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
