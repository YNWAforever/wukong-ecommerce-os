/**
 * Deterministic merchant-audit period parser (B3).
 *
 * The operator's turn text may name a reporting period. Parsing is deliberately
 * small and strict: relative phrases (`last 30 days`, `past 2 weeks`,
 * `previous 3 months`, `last 1 year`) or one explicit ISO range
 * (`2026-10-01 to 2026-11-01`). Anything else is `null`, meaning "no period";
 * the report then states that the totals are current snapshots rather than
 * silently guessing a window. Nothing here uses locale rules or the system
 * clock: the caller passes `now`, and all day arithmetic is UTC.
 */

export type AuditPeriod = {
  /** First included UTC day, `YYYY-MM-DD`. */
  from: string;
  /** Last included UTC day, `YYYY-MM-DD`. */
  to: string;
  /** Number of inclusive calendar days covered. */
  days: number;
  /** Human-readable, locale-independent description stored in the artifact. */
  label: string;
};

const MAX_PERIOD_DAYS = 365;

const RELATIVE =
  /(?:^|\b)(last|past|previous)\s+(\d{1,4})\s+(day|days|week|weeks|month|months|year|years)\b/i;
const ISO_RANGE =
  /(?:^|\b)(\d{4}-\d{2}-\d{2})\s*(?:to|until|-)\s*(\d{4}-\d{2}-\d{2})\b/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDay(value: string): Date | null {
  if (!ISO_DAY.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject rolled-over dates such as 2026-02-30.
  return formatDay(parsed) === value ? parsed : null;
}

function inclusiveDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

function unitDays(unit: string): number | null {
  switch (unit.toLowerCase()) {
    case "day":
    case "days":
      return 1;
    case "week":
    case "weeks":
      return 7;
    case "month":
    case "months":
      return 30;
    case "year":
    case "years":
      return 365;
    default:
      return null;
  }
}

function relativePeriod(match: RegExpExecArray, now: Date): AuditPeriod | null {
  const amount = Number(match[2]);
  const perUnit = unitDays(match[3] ?? "");
  if (!Number.isInteger(amount) || amount < 1 || perUnit === null) return null;
  const days = amount * perUnit;
  if (days < 1 || days > MAX_PERIOD_DAYS) return null;
  const to = utcDay(now);
  const from = new Date(to.getTime() - (days - 1) * DAY_MS);
  return {
    from: formatDay(from),
    to: formatDay(to),
    days,
    label: `${match[1]!.toLowerCase()} ${days} day${days === 1 ? "" : "s"}`,
  };
}

function explicitPeriod(match: RegExpExecArray): AuditPeriod | null {
  const from = parseDay(match[1] ?? "");
  const to = parseDay(match[2] ?? "");
  if (!from || !to) return null;
  const days = inclusiveDays(from, to);
  if (days < 1 || days > MAX_PERIOD_DAYS) return null;
  return {
    from: formatDay(from),
    to: formatDay(to),
    days,
    label: `${formatDay(from)} - ${formatDay(to)}`,
  };
}

/** Parse the first period-like phrase in the text; `null` means no period. */
export function parseAuditPeriod(
  text: string | null | undefined,
  now: Date,
): AuditPeriod | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const explicit = ISO_RANGE.exec(trimmed);
  if (explicit) return explicitPeriod(explicit);
  const relative = RELATIVE.exec(trimmed);
  if (relative) return relativePeriod(relative, now);
  return null;
}

/** True when the text appears to ask for a period we could not parse. */
export function mentionsUnparseablePeriod(
  text: string | null | undefined,
): boolean {
  if (typeof text !== "string") return false;
  if (parseAuditPeriod(text, new Date()) !== null) return false;
  return /\b(period|range|from|between|last|past|previous|days?|weeks?|months?|years?)\b/i.test(
    text,
  );
}

/** Whether an ISO timestamp falls inside the period's inclusive UTC days. */
export function isWithinAuditPeriod(
  createdAt: string,
  period: AuditPeriod,
): boolean {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return false;
  const from = Date.parse(`${period.from}T00:00:00.000Z`);
  const to = Date.parse(`${period.to}T23:59:59.999Z`);
  return parsed >= from && parsed <= to;
}

/** Payload shape for the period section (or `null` for current totals). */
export function auditPeriodPayload(
  period: AuditPeriod | null,
): { from: string; to: string; label: string } | null {
  return period
    ? { from: period.from, to: period.to, label: period.label }
    : null;
}
