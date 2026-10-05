"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Locale } from "../lib/locale";
import { localized } from "../lib/ui-copy";
import { validateSupportRequestId } from "../lib/account-session";
import styles from "./assignment-panel.module.css";

const role = z.enum(["viewer", "operator", "reviewer", "admin", "owner"]);
const assignment = z.object({
  listingId: z.string().uuid(),
  assigneeUserId: z.string().nullable(),
  assignmentRevision: z.number().int().nonnegative(),
  assigneeActive: z.boolean(),
  assigneeEmail: z.string().nullable(),
});
const member = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role,
});
const snapshotSchema = z.object({
  assignments: z.array(assignment).max(100),
  members: z.array(member),
  actorId: z.string(),
  role,
});
const resultSchema = z.object({
  listingId: z.string().uuid(),
  outcome: z.enum([
    "assigned",
    "listing_not_found",
    "target_not_active",
    "insufficient_role",
    "assignment_owned",
    "revision_conflict",
    "idempotency_conflict",
  ]),
  assigneeUserId: z.string().nullable(),
  assignmentRevision: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
const receiptSchema = z.object({
  results: z.array(resultSchema).max(100),
  assigned: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type Receipt = z.infer<typeof receiptSchema>;
export type AssignmentWorkFilterValue =
  "all" | "mine" | "unassigned" | "review";
export function AssignmentWorkFilter({
  value,
  onChange,
  locale,
}: {
  value: AssignmentWorkFilterValue;
  onChange(value: AssignmentWorkFilterValue): void;
  locale: Locale;
}) {
  return (
    <label>
      {localized(locale, "工作責任", "Work responsibility")}
      <select
        aria-label={localized(locale, "工作責任", "Work responsibility")}
        value={value}
        onChange={(event) =>
          onChange(event.target.value as AssignmentWorkFilterValue)
        }
      >
        <option value="all">{localized(locale, "全部工作", "All work")}</option>
        <option value="mine">{localized(locale, "我的工作", "My work")}</option>
        <option value="unassigned">
          {localized(locale, "未指派", "Unassigned")}
        </option>
        <option value="review">
          {localized(locale, "待審", "Awaiting review")}
        </option>
      </select>
    </label>
  );
}
export function AssignmentPanel({
  listingIds,
  locale,
  onUpdated,
  onSettled,
}: {
  listingIds: string[];
  locale: Locale;
  onUpdated?(): void;
  onSettled?(selectionKey: string): void;
}) {
  const key = [...new Set(listingIds)].sort().join(",");
  const ids = key ? key.split(",") : [];
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [target, setTarget] = useState("");
  const [loading, setLoading] = useState(true),
    [pending, setPending] = useState(false);
  const [error, setError] = useState(false),
    [supportId, setSupportId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const requests = useRef(new Map<string, string>());
  const currentScope = useRef<{
    active: boolean;
    snapshot: Snapshot | null;
    mutation: object | null;
  } | null>(null);
  const updated = useRef(onUpdated);
  const settled = useRef(onSettled);
  useEffect(() => {
    updated.current = onUpdated;
    settled.current = onSettled;
  }, [onUpdated, onSettled]);
  useEffect(() => {
    const abort = new AbortController();
    const scope = {
      active: true,
      snapshot: null as Snapshot | null,
      mutation: null as object | null,
    };
    currentScope.current = scope;
    const current = () => scope.active && currentScope.current === scope;
    const dispose = () => {
      scope.active = false;
      abort.abort();
    };
    requests.current.clear();
    setPending(false);
    setSupportId(null);
    setLoading(true);
    setError(false);
    setReceipt(null);
    setSnapshot(null);
    if (!key || ids.length > 100) {
      setLoading(false);
      settled.current?.(key);
      return dispose;
    }
    void (async () => {
      try {
        const response = await fetch(
          "/api/listings/assign?listingIds=" + encodeURIComponent(key),
          { cache: "no-store", signal: abort.signal },
        );
        const body: unknown = await response.json();
        if (!response.ok) throw Error("assignment read failed");
        const data = snapshotSchema.parse(body);
        if (data.assignments.some((item) => !ids.includes(item.listingId)))
          throw Error("foreign assignment response");
        if (current()) {
          scope.snapshot = data;
          setSnapshot(data);
          setTarget(data.role === "operator" ? "" : data.actorId);
        }
      } catch {
        if (current()) setError(true);
      } finally {
        if (current()) {
          setLoading(false);
          settled.current?.(key);
        }
      }
    })();
    return dispose;
  }, [key]);
  const canAssign =
    snapshot && ["reviewer", "admin", "owner"].includes(snapshot.role);
  const eligible =
    snapshot?.members.filter((item) =>
      canAssign
        ? item.role !== "viewer"
        : ["reviewer", "admin", "owner"].includes(item.role),
    ) ?? [];
  async function mutate(action: "assign" | "claim" | "handoff") {
    const scope = currentScope.current;
    if (
      !snapshot ||
      pending ||
      !scope?.active ||
      scope.snapshot !== snapshot ||
      scope.mutation
    )
      return;
    const mutation = {};
    scope.mutation = mutation;
    const current = () =>
      scope.active &&
      currentScope.current === scope &&
      scope.mutation === mutation;
    setPending(true);
    setError(false);
    setReceipt(null);
    setSupportId(null);
    const assigneeUserId =
      action === "claim" ? snapshot.actorId : target || null;
    const items = ids.map((listingId) => {
      const expectedRevision =
        snapshot.assignments.find((item) => item.listingId === listingId)
          ?.assignmentRevision ?? 0;
      const signature = JSON.stringify([
        snapshot.actorId,
        snapshot.role,
        listingId,
        action,
        assigneeUserId,
        expectedRevision,
      ]);
      const idempotencyKey =
        requests.current.get(signature) ?? crypto.randomUUID();
      requests.current.set(signature, idempotencyKey);
      return {
        listingId,
        action,
        assigneeUserId,
        expectedRevision,
        idempotencyKey,
      };
    });
    try {
      const response = await fetch("/api/listings/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
        cache: "no-store",
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        if (
          current() &&
          typeof body === "object" &&
          body &&
          "requestId" in body
        )
          setSupportId(validateSupportRequestId(body.requestId));
        throw Error("assignment mutation failed");
      }
      const result = receiptSchema.parse(body);
      const succeeded = result.results.filter(
        (item) => item.outcome === "assigned",
      ).length;
      if (
        result.results.length !== ids.length ||
        new Set(result.results.map((item) => item.listingId)).size !==
          ids.length ||
        result.results.some((item) => !ids.includes(item.listingId)) ||
        result.assigned !== succeeded ||
        result.failed !== ids.length - succeeded
      )
        throw Error("incomplete assignment receipt");
      // Accepted work continues, but its receipt belongs to its original scope.
      if (current()) {
        setReceipt(result);
        const nextSnapshot = {
          ...snapshot,
          assignments: snapshot.assignments.map((item) => {
            const current = result.results.find(
              (result) => result.listingId === item.listingId,
            );
            return current &&
              ["assigned", "revision_conflict", "assignment_owned"].includes(
                current.outcome,
              )
              ? {
                  ...item,
                  assigneeUserId: current.assigneeUserId,
                  assignmentRevision: current.assignmentRevision,
                }
              : item;
          }),
        };
        scope.snapshot = nextSnapshot;
        setSnapshot(nextSnapshot);
      }
      if (succeeded && currentScope.current?.active) updated.current?.();
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) {
        scope.mutation = null;
        setPending(false);
      }
    }
  }
  const outcomeLabel = (outcome: z.infer<typeof resultSchema>["outcome"]) => {
    const labels = {
      assigned: ["已指派", "Assigned"],
      listing_not_found: [
        "商品不存在或不屬於此工作區",
        "Listing unavailable in this workspace",
      ],
      target_not_active: [
        "成員不存在或角色不適用",
        "Target is no longer eligible",
      ],
      insufficient_role: [
        "角色沒有此權限",
        "Your current role cannot perform this action",
      ],
      assignment_owned: [
        "其他同事負責的工作無法認領或交接",
        "This work belongs to another teammate",
      ],
      revision_conflict: [
        "其他同事已更新，請重新核對後再試",
        "Changed by another teammate; review before retrying",
      ],
      idempotency_conflict: [
        "重試資料不同，請重新載入",
        "Retry details changed; reload before retrying",
      ],
    } as const;
    return localized(locale, labels[outcome][0], labels[outcome][1]);
  };
  return (
    <section
      className={styles.panel}
      aria-label={localized(locale, "工作交接", "Work assignment")}
    >
      <h3>{localized(locale, "工作交接", "Work assignment")}</h3>
      <p>
        {localized(
          locale,
          "指派只表示工作責任，不會批准商品或變更審批狀態。",
          "Assignment records responsibility; approval and workflow status are separate.",
        )}
      </p>
      {ids.length > 100 ? (
        <p role="alert">
          {localized(
            locale,
            "每次最多交接 100 件商品。",
            "Assign up to 100 listings at a time.",
          )}
        </p>
      ) : !ids.length ? (
        <p>
          {localized(
            locale,
            "選取商品以認領或交接。",
            "Select listings to claim or assign work.",
          )}
        </p>
      ) : loading ? (
        <p role="status">
          {localized(locale, "正在載入工作責任…", "Loading assignments…")}
        </p>
      ) : snapshot ? (
        <>
          {snapshot.role !== "viewer" ? (
            <div className={styles.actions}>
              <button
                type="button"
                className="button"
                data-testid="claim-selected"
                disabled={pending}
                onClick={() => void mutate("claim")}
              >
                {localized(locale, "認領自己", "Claim for myself")}
              </button>
              <label>
                {localized(locale, "交接給", "Assign to")}
                <select
                  value={target}
                  disabled={pending}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="">
                    {canAssign
                      ? localized(locale, "未指派", "Unassigned")
                      : localized(locale, "選擇審核員", "Select reviewer")}
                  </option>
                  {eligible.map((item) => (
                    <option key={item.userId} value={item.userId}>
                      {item.name || item.email} · {item.role}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button"
                data-testid={canAssign ? "assign-selected" : "handoff-selected"}
                disabled={pending || (!canAssign && !target)}
                onClick={() => void mutate(canAssign ? "assign" : "handoff")}
              >
                {canAssign
                  ? localized(locale, "指派所選商品", "Assign selected")
                  : localized(locale, "交給審核員", "Hand off to reviewer")}
              </button>
            </div>
          ) : (
            <p>
              {localized(
                locale,
                "檢視者無法認領或交接。",
                "Viewer access cannot claim or assign work.",
              )}
            </p>
          )}
          <ul>
            {snapshot.assignments.map((item) => (
              <li key={item.listingId}>
                <code>{item.listingId}</code> ·{" "}
                {item.assigneeUserId
                  ? (snapshot.members.find(
                      (member) => member.userId === item.assigneeUserId,
                    )?.email ??
                    localized(locale, "成員已停用", "Member no longer active"))
                  : localized(locale, "未指派", "Unassigned")}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {receipt ? (
        <div role="status">
          <p>
            {receipt.assigned} {localized(locale, "件已指派", "assigned")} ·{" "}
            {receipt.failed} {localized(locale, "件失敗", "failed")}
          </p>
          <ul>
            {receipt.results.map((item) => (
              <li key={item.listingId}>
                <code>{item.listingId}</code> · {outcomeLabel(item.outcome)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p role="alert">
          {localized(
            locale,
            "未能更新或載入工作責任，請重新載入後再試。",
            "Could not update assignments. Reload and retry.",
          )}
          {supportId ? (
            <>
              {" "}
              · {localized(locale, "支援編號", "Support ID")}:{" "}
              <a href={"/support?requestId=" + supportId}>{supportId}</a>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
