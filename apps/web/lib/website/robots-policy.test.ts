import { describe, expect, it } from "vitest";
import { parseRobots, isRobotsAllowed } from "./robots-policy";
const url = "https://store.example/robots.txt";
const parse = (text: string, status = 200) => {
  const policy = parseRobots({ url, status, text });
  return {
    ...policy,
    isAllowed: (target: string) =>
      isRobotsAllowed(JSON.parse(JSON.stringify(policy)), target),
  };
};
describe("robots policy", () => {
  it("uses crawler-specific longest path rules and allow ties", () => {
    const p = parse(
      "User-agent: *\nDisallow: /\nUser-agent: WukongCatalogPreview\nDisallow: /products\nAllow: /products/public\nDisallow: /same\nAllow: /same\nCrawl-delay: 3",
    );
    expect(p.state).toBe("ready");
    expect(p.isAllowed("https://store.example/products/a")).toBe(false);
    expect(p.isAllowed("https://store.example/products/public/a")).toBe(true);
    expect(p.isAllowed("https://store.example/same")).toBe(true);
    expect(p.crawlDelaySeconds).toBe(3);
    expect(p.isAllowed("https://other.example/a")).toBe(false);
  });
  it("honors wildcard and end anchor and enforces minimum delay", () => {
    const p = parse(
      "User-agent: *\nDisallow: /*?private=*\nDisallow: /*.json$\nCrawl-delay: 0.2",
    );
    expect(p.crawlDelaySeconds).toBe(1);
    expect(p.isAllowed("https://store.example/a.json")).toBe(false);
    expect(p.isAllowed("https://store.example/a.json?x=1")).toBe(true);
    expect(p.isAllowed("https://store.example/a?private=yes")).toBe(false);
  });
  it("permits missing policy, disallows unauthorized, fails unavailable", () => {
    expect(parse("", 404).isAllowed("https://store.example/a")).toBe(true);
    for (const status of [401, 403])
      expect(parse("", status).state).toBe("disallowed");
    for (const status of [0, 500, 503])
      expect(parse("", status).state).toBe("failed");
    expect(parse("", 429).state).toBe("rate_limited");
  });
  it("fails malformed policy instead of allowing all", () => {
    for (const text of [
      "<html>error</html>",
      "garbage",
      "User-agent: *\nDisallow /private",
      "User-agent: *\nCrawl-delay: nope",
    ])
      expect(parse(text).state).toBe("failed");
    expect(parse("").state).toBe("ready");
  });
  it("returns same-origin sitemap hints capped at five", () => {
    const p = parse(
      "User-agent: *\nAllow: /\n" +
        Array.from(
          { length: 8 },
          (_, i) => `Sitemap: https://store.example/s${i}.xml`,
        ).join("\n") +
        "\nSitemap: https://other.example/s.xml",
    );
    expect(p.sitemapLinks).toHaveLength(5);
    expect(p.warnings).toContain("sitemap_link_limit");
  });
});

it("does not accept error text disguised as unknown directives", () => {
  expect(parse("Error: service unavailable").state).toBe("failed");
});
it("keeps fractional crawl delay and serializable evaluator behavior", () => {
  const p = parseRobots({
    url,
    status: 200,
    text: "User-agent: WukongCatalogPreview\nCrawl-delay: 2.5\nDisallow: /private",
  });
  expect(p.crawlDelaySeconds).toBe(2.5);
  expect(
    isRobotsAllowed(
      JSON.parse(JSON.stringify(p)),
      "https://store.example/private",
    ),
  ).toBe(false);
});

it("fails excessive robots directives without throwing an untyped policy", () => {
  expect(
    parse("User-agent: *\n" + "Disallow: /private\n".repeat(20001)).state,
  ).toBe("failed");
});
