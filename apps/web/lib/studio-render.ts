import type { Locale } from "./locale";
import { STUDIO_COPY, studioCopy, type StudioCopyKey } from "./studio-copy";

/**
 * Render one persisted Studio "line" — a copy key plus values — for operators.
 *
 * Persisted turns and trace events never store formatted prose: a section, a
 * check or a trace detail is `{ key, values }` so the same database row renders
 * in either locale and the copy parity test can police the wording (design
 * spec §3.3). This module is the only place that turns such a line into text,
 * which keeps three promises in one place:
 *
 *  - a **known** key is interpolated with the line's values and read through
 *    `studioCopy`, so both languages come from the same catalogue;
 *  - a **missing key or value** never reaches an operator as a raw key or a
 *    JSON blob: it logs a content-free diagnostic (the copy key only — never a
 *    value, because values can carry record text) and returns the generic
 *    fallback line from the same catalogue;
 *  - values are **plain text**, never markup. React escapes text nodes, and
 *    callers render the returned string as a child, so a record title such as
 *    `<b>` is shown literally instead of becoming HTML.
 *
 * `values` is typed loosely on purpose: it comes from persisted JSON, so the
 * renderer has to defend against `null`, nested objects or a number outside a
 * template's expectation rather than trusting the writer.
 */

/** A value a persisted line may interpolate into copy. */
export type StudioRenderValue = string | number | boolean;

/**
 * Anything the renderer can display: a `{ key, values }` line from a persisted
 * turn, a trace event payload, or the result of a client fetch. Only `key` is
 * required; the renderer decides whether the template needs values.
 */
export type StudioRenderableLine = {
  readonly key: string;
  readonly values?: Readonly<Record<string, unknown>> | undefined;
};

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const FALLBACK_KEY: StudioCopyKey = "studio.render.fallback";
const YES_KEY: StudioCopyKey = "studio.render.yes";
const NO_KEY: StudioCopyKey = "studio.render.no";

function copyTuple(key: string): readonly [string, string] | undefined {
  return (STUDIO_COPY as Readonly<Record<string, readonly [string, string]>>)[
    key
  ];
}

/**
 * Content-free diagnostic for a line that could not be rendered.
 *
 * The reason and the copy key are the only fields: a value can be a listing
 * title or a check result, so logging one would put record content in runtime
 * logs, which the readiness gate forbids.
 */
function reportFallback(
  reason: "missing_key" | "missing_value" | "empty_copy",
  key: string,
): void {
  console.info(
    JSON.stringify({
      event: "studio_line_render_fallback",
      reason,
      key,
    }),
  );
}

function isRenderableValue(value: unknown): value is StudioRenderValue {
  if (typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Format one value as operator-facing text.
 *
 * Booleans become localized yes/no rather than `true`/`false`: several
 * persisted lines carry flags (`truncated`, `blocking`) and a raw boolean in a
 * sentence reads like a machine dump. Numbers use the plain decimal form
 * because every current value is a count or a duration.
 */
export function formatStudioValue(
  locale: Locale,
  value: StudioRenderValue,
): string {
  if (typeof value === "boolean") {
    return studioCopy(locale, value ? YES_KEY : NO_KEY);
  }
  return String(value);
}

/**
 * Interpolate `{placeholder}` tokens from `line.values` into the copy key.
 *
 * Any unresolvable placeholder falls the whole line back to the generic line:
 * rendering a half sentence ("Found  listings") or a raw `{missingKinds}`
 * would both be misleading, and a missing key must never surface as
 * `studio.answer.foo` to an operator. Values are substituted once, so a value
 * that itself contains braces stays literal text.
 */
export function renderStudioLine(
  locale: Locale,
  line: StudioRenderableLine,
): string {
  const tuple = copyTuple(line.key);
  if (!tuple) {
    reportFallback("missing_key", line.key);
    return studioCopy(locale, FALLBACK_KEY);
  }
  const template = locale === "zh-Hant" ? tuple[0] : tuple[1];
  if (!template) {
    reportFallback("empty_copy", line.key);
    return studioCopy(locale, FALLBACK_KEY);
  }

  const values = line.values ?? {};
  let missing = false;
  const rendered = template.replace(
    PLACEHOLDER,
    (placeholder: string, name: string) => {
      const value: unknown = values[name];
      if (!isRenderableValue(value)) {
        missing = true;
        return placeholder;
      }
      return formatStudioValue(locale, value);
    },
  );
  if (missing) {
    reportFallback("missing_value", line.key);
    return studioCopy(locale, FALLBACK_KEY);
  }
  return rendered;
}
