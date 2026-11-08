"use client";

import { useState } from "react";

import { BatchList } from "./batch-list";
import { CreateBatchForm } from "./create-batch-form";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";

/**
 * Wires CreateBatchForm's success callback to BatchList's fetch. BatchList
 * fetches on mount with no externally-triggerable refetch, so the simplest
 * correct way to make a successful create show up in the list (per
 * docs/superpowers/specs/2026-08-31-batches-list-detail-and-actions-design.md
 * §5, "On success, the list component re-fetches") is to remount it: bump
 * `refreshKey` and pass it as BatchList's `key`, matching this codebase's
 * existing `-client.tsx` convention of a thin client wrapper composing two
 * presentational components (see listing-intake-client.tsx).
 */
export function BatchesClient() {
  const locale = useLocale();
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="batches-layout">
      <section className="batches-section" aria-labelledby="new-batch-heading">
        <h2 id="new-batch-heading">
          {localized(locale, "建立新批次", "New batch")}
        </h2>
        <CreateBatchForm onCreated={() => setRefreshKey((key) => key + 1)} />
      </section>
      <section
        className="batches-section"
        aria-labelledby="existing-batches-heading"
      >
        <h2 id="existing-batches-heading">
          {localized(locale, "現有批次", "Existing batches")}
        </h2>
        <BatchList key={refreshKey} />
      </section>
    </div>
  );
}
