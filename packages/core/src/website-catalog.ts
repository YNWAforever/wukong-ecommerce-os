import { z } from "zod";

/** Static reference validation only. DNS and redirect checks remain mandatory at fetch time. */
export function normalizeWebsiteUrl(raw: string, base?: string): string | null {
  if (raw.length > 4096 || /[\\\u0000-\u0020]/.test(raw)) return null;
  try {
    const url = new URL(raw, base);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      /^https:\/\/[^/]*@/i.test(raw)
    )
      return null;
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (host.startsWith("[")) {
      const halves = host.slice(1, -1).split("::");
      const left = halves[0]?.split(":").filter(Boolean) ?? [],
        right = halves[1]?.split(":").filter(Boolean) ?? [];
      const words = [
        ...left,
        ...Array(8 - left.length - right.length).fill("0"),
        ...right,
      ].map((w) => parseInt(w, 16));
      const a = words[0] ?? 0,
        b = words[1] ?? 0;
      if (
        !(a >= 0x2000 && a <= 0x3fff) ||
        (a === 0x2001 && (b < 0x200 || b === 0xdb8)) ||
        a === 0x2002 ||
        (a === 0x3fff && b < 0x1000)
      )
        return null;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a = 0, b = 0, c = 0] = host.split(".").map(Number);
      // Refuse alternative numeric spellings before URL's normalization loses them.
      if (
        /^https:/i.test(raw) &&
        raw.match(/^https:\/\/([^/:?#]+)/i)?.[1] !== host
      )
        return null;
      if (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 &&
          (b === 168 ||
            (b === 0 && (c === 0 || c === 2)) ||
            (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)
      )
        return null;
    } else if (
      !host.includes(".") ||
      /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home|corp|intranet|onion|arpa|invalid)$/.test(
        host,
      )
    )
      return null;
    url.hostname = host;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
export const websiteUrlSchema = z
  .string()
  .max(4096)
  .refine(
    (value) => normalizeWebsiteUrl(value) === value,
    "Expected normalized public HTTPS URL",
  );
export const websiteScanStateSchema = z.enum([
  "queued",
  "running",
  "ready",
  "partial",
  "failed",
]);
export type WebsiteScanState = z.infer<typeof websiteScanStateSchema>;
export const websiteWarningsSchema = z
  .array(z.string().min(1).max(200))
  .max(30);
export const websitePriceSchema = z.strictObject({
  amount: z
    .string()
    .max(100)
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export const websiteProductSchema = z
  .strictObject({
    key: websiteUrlSchema,
    sourceUrl: websiteUrlSchema,
    capturedAt: z.iso.datetime({ offset: true }),
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20000).nullable(),
    imageUrls: z.array(websiteUrlSchema).max(10),
    price: websitePriceSchema.nullable(),
    availability: z.enum(["in_stock", "out_of_stock", "preorder", "unknown"]),
    attributes: z
      .record(z.string().min(1).max(100), z.string().max(1000))
      .refine((v) => Object.keys(v).length <= 30),
    fieldSources: z
      .record(z.string().min(1).max(100), z.enum(["json_ld", "html"]))
      .refine((v) => Object.keys(v).length <= 40),
    warnings: websiteWarningsSchema,
  })
  .refine((v) => v.key === v.sourceUrl, "Key must equal canonical source URL");
export type WebsiteProduct = z.infer<typeof websiteProductSchema>;
export const websiteScanEnvelopeSchema = z
  .strictObject({
    products: z.array(websiteProductSchema).max(20),
    warnings: websiteWarningsSchema,
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.products.map((p) => p.key)).size !== value.products.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate canonical product URLs",
      });
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      1024 * 1024
    )
      ctx.addIssue({
        code: "custom",
        message: "Normalized scan envelope exceeds 1 MiB",
      });
  });
export type WebsiteScanEnvelope = z.infer<typeof websiteScanEnvelopeSchema>;

export const robotsPolicySchema = z.strictObject({
  origin: websiteUrlSchema.refine(
    (v) => new URL(v).pathname === "/" && !new URL(v).search,
  ),
  state: z.enum(["ready", "disallowed", "failed", "rate_limited"]),
  directives: z
    .array(
      z.strictObject({
        field: z.enum(["user-agent", "allow", "disallow", "crawl-delay"]),
        value: z.string().max(4096),
      }),
    )
    .max(20000),
  sitemapLinks: z.array(websiteUrlSchema).max(5),
  crawlDelaySeconds: z.number().finite().min(1),
  warnings: websiteWarningsSchema,
});
export type RobotsPolicy = z.infer<typeof robotsPolicySchema>;
