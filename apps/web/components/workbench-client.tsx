"use client";
import { useCallback, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { WorkbenchPage, WorkbenchQuery, WorkbenchKind } from "@wukong/db";
import { useLocale } from "../lib/locale-context";
import { useLatestRequest } from "../lib/use-latest-request";
import { workbenchCopy } from "../lib/workbench-copy";
import {
  parseWorkbenchQuery,
  workbenchQueryKey,
  workbenchUrl,
  changeWorkbenchQuery,
  workbenchKinds,
} from "../lib/workbench-query";
import { WorkbenchSummary } from "./workbench-summary";
import { WorkbenchList, type WorkbenchCapabilities } from "./workbench-list";
type ResponsePage = WorkbenchPage & { capabilities: WorkbenchCapabilities };
export function WorkbenchClient() {
  const locale = useLocale();
  const copy = workbenchCopy[locale];
  const params = useSearchParams();
  const router = useRouter();
  const query = parseWorkbenchQuery(params.toString());
  const queryKey = workbenchQueryKey(query);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch(`/api/workbench?${queryKey}`, {
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("workbench_read_failed");
      return { queryKey, page: (await response.json()) as ResponsePage };
    },
    [queryKey],
  );
  const {
    data: response,
    error,
    loading,
    reload,
  } = useLatestRequest(load, copy.error);
  const matching = response?.queryKey === queryKey ? response.page : null;
  const retainedStale = matching !== null && (loading || error !== null);
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  const change = (
    value: Partial<Pick<WorkbenchQuery, "kind" | "state" | "page">>,
  ) => router.push(workbenchUrl(changeWorkbenchQuery(query, value)));
  const busy = loading || (!matching && !error);
  return (
    <section className="workbench" aria-busy={busy}>
      <header className="workbench-header">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.intro}</p>
        </div>
        {matching?.capabilities.canImport ? (
          <Link className="primary-button" href="/listings/import">
            ＋ {copy.import}
          </Link>
        ) : (
          matching && <p className="workbench-readonly">{copy.readonly}</p>
        )}
      </header>
      <WorkbenchSummary
        counts={matching?.counts ?? null}
        selected={query.state}
        locale={locale}
        onSelect={(state) => change({ state })}
      />
      <div className="workbench-status" role="status">
        {busy && <p>{copy.loading}</p>}
        {error && !loading && <p>{copy.error}</p>}
        {retainedStale && <p>{copy.stale}</p>}
        {matching && (
          <p>
            {copy.observed}:{" "}
            <time dateTime={matching.observedAt}>
              {new Date(matching.observedAt).toLocaleString(locale, {
                timeZone: "Asia/Hong_Kong",
              })}
            </time>
          </p>
        )}
      </div>
      <div className="workbench-layout">
        <section className="workbench-panel">
          <div className="workbench-controls">
            <h2>
              {copy.states[query.state]}
              {matching
                ? ` · ${matching.totalMatching.toLocaleString(locale)}`
                : ""}
            </h2>
            <label>
              {copy.kind}
              <select
                value={query.kind ?? ""}
                onChange={(e) =>
                  change({
                    kind: (e.target.value || undefined) as
                      WorkbenchKind | undefined,
                  })
                }
              >
                <option value="">{copy.all}</option>
                {workbenchKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {copy.kinds[kind]}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={reload} disabled={loading}>
              {error ? copy.retry : copy.refresh}
            </button>
          </div>
          {matching && matching.counts.unclassified > 0 && (
            <Link
              className="workbench-unclassified"
              href={workbenchUrl(
                changeWorkbenchQuery(query, { state: "unclassified" }),
              )}
            >
              {copy.states.unclassified}:{" "}
              {matching.counts.unclassified.toLocaleString(locale)}
            </Link>
          )}
          {matching &&
            (matching.items.length ? (
              <WorkbenchList
                items={matching.items}
                capabilities={matching.capabilities}
                locale={locale}
                returnTo={workbenchUrl(query)}
              />
            ) : (
              <p className="workbench-empty">
                {!query.kind &&
                Object.values(matching.counts).every((count) => count === 0)
                  ? matching.capabilities.canImport
                    ? copy.noWork
                    : copy.noWorkReadonly
                  : copy.empty}
              </p>
            ))}
          <nav className="workbench-pagination" aria-label={copy.page}>
            <button
              type="button"
              disabled={query.page <= 1}
              onClick={() => change({ page: query.page - 1 })}
            >
              {copy.previous}
            </button>
            <span>
              {copy.page} {query.page}
            </span>
            <button
              type="button"
              disabled={
                !matching ||
                query.page * query.pageSize >= matching.totalMatching
              }
              onClick={() => change({ page: query.page + 1 })}
            >
              {copy.next}
            </button>
          </nav>
        </section>
        <aside className="workbench-guidance">
          <details>
            <summary>{copy.guidance}</summary>
            <ol>
              {copy.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p>{copy.caution}</p>
          </details>
        </aside>
      </div>
    </section>
  );
}
