import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import {
  normalizeWebsiteUrl,
  websiteProductSchema,
  websitePriceSchema,
  websiteUrlSchema,
  websiteWarningsSchema,
  type WebsiteProduct,
} from "@wukong/core";
type Node = DefaultTreeAdapterMap["node"];
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const list = (v: unknown): unknown[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const attr = (n: Node, key: string) =>
  "attrs" in n ? n.attrs.find((a) => a.name === key)?.value : undefined;
function nodes(root: Node): Node[] {
  const result: Node[] = [],
    pending = [root];
  while (pending.length) {
    const n = pending.pop()!;
    result.push(n);
    if ("childNodes" in n)
      for (let i = n.childNodes.length - 1; i >= 0; i--)
        pending.push(n.childNodes[i]!);
  }
  return result;
}
function text(root: Node): string {
  const parts: string[] = [],
    pending = [root];
  while (pending.length) {
    const n = pending.pop()!;
    if (
      "tagName" in n &&
      ["script", "style", "template", "noscript", "iframe", "object"].includes(
        n.tagName,
      )
    )
      continue;
    if ("value" in n) parts.push(n.value);
    if ("childNodes" in n)
      for (let i = n.childNodes.length - 1; i >= 0; i--)
        pending.push(n.childNodes[i]!);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
const plain = (v: unknown) =>
  typeof v === "string" ? text(parseFragment(v)) : "";
const hasType = (o: Obj, type: string) =>
  list(o["@type"]).some(
    (t) =>
      typeof t === "string" &&
      (t === type ||
        t === `https://schema.org/${type}` ||
        t === `http://schema.org/${type}`),
  );
export const extractedDocumentSchema = z.strictObject({
  product: websiteProductSchema.nullable(),
  productLinks: z.array(websiteUrlSchema).max(20),
  sitemapLinks: z.array(websiteUrlSchema).max(5),
  warnings: websiteWarningsSchema,
});
export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;
export type ExtractDocumentInput = {
  url: string;
  capturedAt: string;
  html: string;
  contentType?: string;
};
/** Pure extraction; all HTML is untrusted data. No scripts, entities or URLs are fetched. */
export function extractDocument(
  input: ExtractDocumentInput,
): ExtractedDocument {
  const url = normalizeWebsiteUrl(input.url);
  if (!url) throw new Error("invalid_document_url");
  z.iso.datetime({ offset: true }).parse(input.capturedAt);
  const result: ExtractedDocument = {
    product: null,
    productLinks: [],
    sitemapLinks: [],
    warnings: [],
  };
  const warn = (code: string) => {
    if (!result.warnings.includes(code) && result.warnings.length < 30)
      result.warnings.push(code);
  };
  const xml =
    /xml/i.test(input.contentType ?? "") ||
    /^\s*(?:<\?xml\b|<urlset\b|<sitemapindex\b)/i.test(input.html);
  if (
    new TextEncoder().encode(input.html).byteLength >
    (xml ? 1024 * 1024 : 2 * 1024 * 1024)
  )
    throw new Error("document_too_large");
  const same = (raw: unknown) => {
    if (typeof raw !== "string" || /[{}]|%7[bBdD]/i.test(raw)) return null;
    const value = normalizeWebsiteUrl(raw, url);
    return value && new URL(value).origin === new URL(url).origin
      ? value
      : null;
  };
  const link = (raw: unknown, kind: "product" | "sitemap") => {
    const value = same(raw);
    if (!value) return;
    const target =
      kind === "product" ? result.productLinks : result.sitemapLinks;
    const max = kind === "product" ? 20 : 5;
    if (!target.includes(value)) {
      if (target.length < max) target.push(value);
      else warn(`${kind}_link_limit`);
    }
  };
  if (xml && /<!DOCTYPE|<!ENTITY/i.test(input.html)) {
    warn("unsafe_sitemap");
    return result;
  }
  const dom = nodes(parse(input.html));
  if (xml) {
    const index = dom.some(
      (n) => "tagName" in n && n.tagName === "sitemapindex",
    );
    if (!index && !dom.some((n) => "tagName" in n && n.tagName === "urlset")) {
      warn("invalid_sitemap");
      return result;
    }
    for (const n of dom)
      if ("tagName" in n && n.tagName === "loc")
        link(text(n), index ? "sitemap" : "product");
    return extractedDocumentSchema.parse(result);
  }
  let canonical = url;
  const canonicals = new Set<string>();
  for (const n of dom) {
    if (!("tagName" in n)) continue;
    if (n.tagName === "a") {
      const href = attr(n, "href");
      const safe = same(href);
      if (safe && /\/products?\//i.test(new URL(safe).pathname))
        link(safe, "product");
    }
    if (
      n.tagName === "link" &&
      attr(n, "rel")?.split(/\s+/).includes("canonical")
    ) {
      const value = same(attr(n, "href"));
      if (value) canonicals.add(value);
      else warn("invalid_canonical");
    }
  }
  if (canonicals.size === 1) canonical = [...canonicals][0]!;
  else if (canonicals.size > 1) warn("conflicting_canonical");
  const candidates: Obj[] = [];
  const candidateFingerprints = new Set<string>();
  // Wire size alone cannot bound repeated work on overlapping JSON subtrees.
  // Shared budgets bound traversal and fingerprint work; the per-candidate cap
  // also stops JSON.stringify before an attacker-controlled depth exhausts stack.
  const structuredLimit = new Error("structured_data_limit");
  let traversedValues = 0,
    fingerprintValues = 0,
    fingerprintCharacters = 0;
  const fingerprint = (candidate: Obj): string => {
    let candidateValues = 0;
    return JSON.stringify(candidate, (key: string, value: unknown) => {
      candidateValues++;
      fingerprintValues++;
      fingerprintCharacters +=
        key.length + (typeof value === "string" ? value.length : 1);
      if (
        candidateValues > 512 ||
        fingerprintValues > 25000 ||
        fingerprintCharacters > 2 * 1024 * 1024
      )
        throw structuredLimit;
      return value;
    });
  };
  for (const n of dom)
    if (
      "tagName" in n &&
      n.tagName === "script" &&
      attr(n, "type")?.toLowerCase() === "application/ld+json"
    ) {
      const raw =
        "childNodes" in n
          ? n.childNodes.map((c) => ("value" in c ? c.value : "")).join("")
          : "";
      try {
        const queue: unknown[] = [];
        const enqueue = (values: unknown[]) => {
          if (traversedValues + queue.length + values.length > 10000)
            throw structuredLimit;
          for (const value of values) queue.push(value);
        };
        enqueue(list(JSON.parse(raw)));
        while (queue.length) {
          traversedValues++;
          const o = object(queue.pop());
          if (!o) continue;
          if (hasType(o, "Product")) {
            const serialized = fingerprint(o);
            if (!candidateFingerprints.has(serialized)) {
              candidateFingerprints.add(serialized);
              candidates.push(o);
            }
          }
          if (Array.isArray(o["@graph"])) enqueue(o["@graph"]);
          if (hasType(o, "ProductGroup")) enqueue(list(o.hasVariant));
        }
      } catch (error) {
        if (error === structuredLimit) {
          warn("structured_data_limit");
          for (const candidate of candidates) link(candidate.url, "product");
          return extractedDocumentSchema.parse(result);
        }
        warn("invalid_json_ld");
      }
    }
  if (candidates.length > 1) {
    warn("multiple_products");
    for (const candidate of candidates) link(candidate.url, "product");
    return extractedDocumentSchema.parse(result);
  }
  const shopline = dom.some(
    (n) =>
      attr(n, "name") === "generator" &&
      /shopline/i.test(attr(n, "content") ?? ""),
  );
  const scope = shopline
    ? dom.find((n) => attr(n, "class")?.split(/\s+/).includes("product-detail"))
    : undefined;
  const scoped = scope ? nodes(scope) : [];
  const byClass = (name: string) =>
    scoped.find((n) => attr(n, "class")?.split(/\s+/).includes(name));
  const visibleTitle = byClass("product-title"),
    visibleDescription = byClass("product-description");
  const meta = (key: string) => dom.find((n) => attr(n, "property") === key);
  const metaValue = (key: string) => {
    const n = meta(key);
    return n ? attr(n, "content") : undefined;
  };
  const data = candidates[0] ?? null,
    source = data ? "json_ld" : "html";
  if (data?.url !== undefined) {
    const productUrl = same(data.url);
    if (!productUrl) {
      warn("invalid_product_url");
      return extractedDocumentSchema.parse(result);
    }
    if (productUrl !== url && productUrl !== canonical) {
      link(productUrl, "product");
      warn("product_on_another_page");
      return extractedDocumentSchema.parse(result);
    }
  }
  const rawTitle = data
    ? plain(data.name)
    : visibleTitle
      ? text(visibleTitle)
      : "";
  if (!rawTitle) {
    if (data || scope) warn("missing_title");
    return extractedDocumentSchema.parse(result);
  }
  const bounded = (value: string, max: number, field: string) => {
    if (value.length > max) warn(`${field}_truncated`);
    return value.slice(0, max);
  };
  const title = bounded(rawTitle, 500, "title");
  const description =
    bounded(
      data
        ? plain(data.description)
        : visibleDescription
          ? text(visibleDescription)
          : "",
      20000,
      "description",
    ) || null;
  const fieldSources: WebsiteProduct["fieldSources"] = { title: source };
  if (description) fieldSources.description = source;
  if (data && visibleTitle && text(visibleTitle) !== rawTitle)
    warn("conflicting_title");
  if (
    data &&
    visibleDescription &&
    text(visibleDescription) !== plain(data.description)
  )
    warn("conflicting_description");
  const offers = data
    ? list(data.offers)
        .map(object)
        .filter((o): o is Obj => o !== null)
    : scope
      ? [
          {
            price: metaValue("product:price:amount"),
            priceCurrency: metaValue("product:price:currency"),
          },
        ]
      : [];
  const prices = offers.map((o) => {
    const p = websitePriceSchema.safeParse({
      amount:
        typeof o.price === "number" && Number.isFinite(o.price)
          ? String(o.price)
          : o.price,
      currency: o.priceCurrency,
    });
    return p.success ? p.data : null;
  });
  const uniquePrices = new Set(prices.map((p) => JSON.stringify(p)));
  const price = uniquePrices.size === 1 ? (prices[0] ?? null) : null;
  const availabilityValue = (
    value: unknown,
  ): WebsiteProduct["availability"] => {
    if (typeof value !== "string") return "unknown";
    const token = value.replace(/^https?:\/\/schema.org\//, "");
    return token === "InStock"
      ? "in_stock"
      : token === "OutOfStock" || token === "SoldOut"
        ? "out_of_stock"
        : token === "PreOrder" || token === "PreSale"
          ? "preorder"
          : "unknown";
  };
  const availabilities = offers.map((o) => availabilityValue(o.availability));
  const availability =
    new Set(availabilities).size === 1
      ? (availabilities[0] ?? "unknown")
      : "unknown";
  if (uniquePrices.size > 1 || new Set(availabilities).size > 1)
    warn("conflicting_offers");
  if (price) fieldSources.price = source;
  if (availability !== "unknown") fieldSources.availability = source;
  if (data && scope) {
    const visiblePrice = websitePriceSchema.safeParse({
      amount: metaValue("product:price:amount"),
      currency: metaValue("product:price:currency"),
    });
    if (
      visiblePrice.success &&
      JSON.stringify(visiblePrice.data) !== JSON.stringify(price)
    )
      warn("conflicting_price");
  }
  if (data?.hasVariant) warn("multiple_variants");
  const imageUrls: string[] = [];
  const images = data
    ? list(data.image)
    : scope
      ? scoped
          .filter((n) => "tagName" in n && n.tagName === "img")
          .map((n) => attr(n, "src"))
      : [];
  for (const raw of images) {
    const v = typeof raw === "string" ? raw : object(raw)?.url;
    const image = typeof v === "string" ? normalizeWebsiteUrl(v, url) : null;
    if (!image) {
      warn("invalid_image_url");
      continue;
    }
    if (imageUrls.includes(image)) continue;
    if (imageUrls.length === 10) {
      warn("images_truncated");
      continue;
    }
    imageUrls.push(image);
  }
  if (imageUrls.length) fieldSources.imageUrls = source;
  const attributes: Record<string, string> = Object.create(null);
  const conflictingAttributes = new Set<string>();
  // At most 30 original normalized values, bounded by the 2 MiB input document.
  // Compare before output truncation so suffix conflicts remain visible.
  const attributeValues = new Map<string, string>();
  const addAttribute = (rawKey: unknown, rawValue: unknown) => {
    const key = plain(rawKey),
      value = plain(typeof rawValue === "number" ? String(rawValue) : rawValue);
    if (
      !key ||
      !value ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      return;
    const normalizedKey = bounded(key, 100, "attribute_key");
    if (conflictingAttributes.has(normalizedKey)) return;
    if (attributeValues.has(normalizedKey)) {
      if (attributeValues.get(normalizedKey) !== value) {
        warn("conflicting_attributes");
        delete attributes[normalizedKey];
        attributeValues.delete(normalizedKey);
        conflictingAttributes.add(normalizedKey);
      }
      return;
    }
    if (attributeValues.size === 30) {
      warn("attributes_truncated");
      return;
    }
    attributeValues.set(normalizedKey, value);
    attributes[normalizedKey] = bounded(value, 1000, "attribute_value");
  };
  if (data) {
    for (const key of ["brand", "color", "size", "material", "model"]) {
      const value = data[key];
      addAttribute(key, object(value)?.name ?? value);
    }
    for (const p of list(data.additionalProperty)) {
      const value = object(p);
      if (value) addAttribute(value.name, value.value);
    }
  }
  if (Object.keys(attributes).length) fieldSources.attributes = source;
  result.product = websiteProductSchema.parse({
    key: canonical,
    sourceUrl: canonical,
    capturedAt: input.capturedAt,
    title,
    description,
    imageUrls,
    price,
    availability,
    attributes,
    fieldSources,
    warnings: [...result.warnings],
  });
  return extractedDocumentSchema.parse(result);
}
