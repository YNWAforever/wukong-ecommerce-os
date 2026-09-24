// URLs embedded in model prose are not approved hyperlinks; secrets must not survive in display text.
export function safeWineText(text: string): string {
  return (
    text
      // Match scheme AND credential before the single-value fallback can consume the scheme alone.
      .replace(
        /\b(?:proxy-)?authorization[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|apikey|negotiate)[ \t]+[a-z0-9._~+/-]+=*["']?|(?:digest|aws4-hmac-sha256)[ \t]+[^\r\n]+)/gi,
        "[redacted]",
      )
      // Bare Bearer token68 credentials occur in copied snippets. Preserve ordinary "bearer of" prose.
      .replace(
        /(?<![\w-])bearer[ \t]+(?!of\b)["']?[a-z0-9._~+/-]+=*["']?/gi,
        "[redacted]",
      )
      .replace(/(?:https?|s3|file):\/\/[^\s<>"']+/gi, "[link removed]")
      .replace(/\b(?:sk|tvly|key)-[a-z0-9_-]{8,}\b/gi, "[redacted]")
      .replace(
        /\b(?:api[_ -]?key|authorization|bearer|secret|token)\s*[:=]\s*[^\s,;]+/gi,
        "[redacted]",
      )
  );
}
export function sanitizeWineDisplay<T>(value: T): T {
  if (typeof value === "string") return safeWineText(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeWineDisplay) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeWineDisplay(v)]),
    ) as T;
  return value;
}
