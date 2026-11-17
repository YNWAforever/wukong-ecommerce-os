export const ADMIN_TABS = [
  "members",
  "connection",
  "settings",
  "capabilities",
] as const;

export type AdminTab = (typeof ADMIN_TABS)[number];

/**
 * Resolve a `?tab=` value to an admin tab without trusting arbitrary input.
 * Links from Studio setup use this so "Connect SHOPLINE" lands on the
 * connection form instead of the members tab.
 */
export function adminTabFromQuery(
  value: string | readonly string[] | undefined,
): AdminTab {
  const candidate = Array.isArray(value) ? value[0] : value;
  return ADMIN_TABS.includes(candidate as AdminTab)
    ? (candidate as AdminTab)
    : "members";
}
