"use client";

import { useState } from "react";

import { BatchList } from "./batch-list";
import { CreateBatchForm } from "./create-batch-form";

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
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <CreateBatchForm onCreated={() => setRefreshKey((key) => key + 1)} />
      <BatchList key={refreshKey} />
    </>
  );
}
