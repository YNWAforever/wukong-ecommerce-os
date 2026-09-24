"use client";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import {
  CAPABILITY_REGISTRY,
  type CapabilityState,
} from "../lib/capability-registry";

const STATE_LABEL: Record<CapabilityState, string> = {
  implemented: "Implemented",
  pilot: "Pilot",
  planned: "Planned",
  blocked: "Blocked",
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
  implemented: "succeeded",
  pilot: "running",
  planned: "pending",
  blocked: "failed",
};

// Deliberately no admin-only assumptions here (no role check, no fetch/
// mutation) -- this component is also reused unmodified by /system-map,
// which is not gated the same way /admin is. The role gate lives at the
// page level (apps/web/app/(app)/admin/page.tsx), not in this component.
export function CapabilityRegistryPanel() {
  const locale = useLocale();
  return (
    <>
      <p role="note">
        {localized(
          locale,
          "此處僅表示原始碼實作成熟度，不代表正式環境已上線或操作驗證。",
          "These entries describe source implementation maturity, not verified production availability or operation.",
        )}
      </p>
      <ul className="flag-list capability-registry-list">
        {CAPABILITY_REGISTRY.map((entry) => (
          <li className="flag-item capability-registry-item" key={entry.id}>
            <div className="flag-content">
              <div className="jobs-row-header">
                <h3>{localized(locale, entry.labelZh, entry.label)}</h3>
                <span
                  className={`connection-status status-${STATE_CLASS[entry.state]}`}
                >
                  <span aria-hidden="true" />
                  {localized(
                    locale,
                    {
                      implemented: "已實作",
                      pilot: "試行中",
                      planned: "規劃中",
                      blocked: "已封鎖",
                    }[entry.state],
                    STATE_LABEL[entry.state],
                  )}
                </span>
              </div>
              <p>{localized(locale, entry.descriptionZh, entry.description)}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
