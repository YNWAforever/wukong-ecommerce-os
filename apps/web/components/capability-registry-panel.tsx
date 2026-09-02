import {
  CAPABILITY_REGISTRY,
  type CapabilityState,
} from "../lib/capability-registry";

const STATE_LABEL: Record<CapabilityState, string> = {
  live: "已上線 Live",
  pilot: "試行中 Pilot",
  planned: "規劃中 Planned",
  blocked: "已封鎖 Blocked",
};

// Reuses the /jobs ledger's existing `status-*` tone classes (see
// globals.css, and jobs-ledger-client.tsx's STATUS_LABELS comment) rather
// than inventing new ones -- capability states only need 4 of the 5 tones
// (cancelled is a /jobs-specific concept with no capability-registry
// equivalent): live is green ("succeeded"), pilot is amber/active
// ("running"), planned is neutral grey ("pending"), and blocked is red,
// reusing the same `status-failed` class the review/connection-status pills
// and the jobs ledger already share.
const STATE_CLASS: Record<CapabilityState, string> = {
  live: "succeeded",
  pilot: "running",
  planned: "pending",
  blocked: "failed",
};

// Deliberately no admin-only assumptions here (no role check, no fetch/
// mutation) -- this component is also reused unmodified by /system-map,
// which is not gated the same way /admin is. The role gate lives at the
// page level (apps/web/app/(app)/admin/page.tsx), not in this component.
export function CapabilityRegistryPanel() {
  return (
    <ul className="flag-list capability-registry-list">
      {CAPABILITY_REGISTRY.map((entry) => (
        <li className="flag-item capability-registry-item" key={entry.id}>
          <div className="flag-content">
            <div className="jobs-row-header">
              <h3>{entry.label}</h3>
              <span
                className={`connection-status status-${STATE_CLASS[entry.state]}`}
              >
                <span aria-hidden="true" />
                {STATE_LABEL[entry.state]}
              </span>
            </div>
            <p>{entry.description}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
