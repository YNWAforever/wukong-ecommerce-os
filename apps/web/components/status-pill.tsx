import type { ReactNode } from "react";

export type StatusTone = "neutral" | "info" | "warning" | "danger" | "success";

/** One visual language for state across Workbench, Catalog, Queue and Jobs. */
export function StatusPill({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return (
    <span className="status-pill" data-tone={tone}>
      {children}
    </span>
  );
}

/** Listing workflow status → tone; unknown values stay neutral. */
export function listingStatusTone(status: string): StatusTone {
  switch (status) {
    case "failed":
    case "publish_failed":
      return "danger";
    case "needs_info":
    case "reopened":
      return "warning";
    case "in_review":
      return "info";
    case "approved":
    case "published":
      return "success";
    default:
      return "neutral";
  }
}
