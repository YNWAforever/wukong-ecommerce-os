import robotsParser from "robots-parser";
import {
  normalizeWebsiteUrl,
  robotsPolicySchema,
  type RobotsPolicy,
} from "@wukong/core";
export const WEBSITE_ROBOTS_AGENT = "WukongCatalogPreview";
export const WEBSITE_USER_AGENT = "WukongCatalogPreview/1.0";
export { robotsPolicySchema };
export type { RobotsPolicy };
const content = (policy: RobotsPolicy) =>
  policy.directives.map((d) => `${d.field}: ${d.value}`).join("\n");
/** Re-evaluate serialized policy after a queue/process restart. No network access. */
export function isRobotsAllowed(policy: RobotsPolicy, rawUrl: string): boolean {
  const url = normalizeWebsiteUrl(rawUrl);
  if (
    policy.state !== "ready" ||
    !url ||
    new URL(url).origin + "/" !== policy.origin
  )
    return false;
  return (
    robotsParser(
      new URL("/robots.txt", policy.origin).href,
      content(policy),
    ).isAllowed(url, WEBSITE_ROBOTS_AGENT) === true
  );
}
export function parseRobots(input: {
  url: string;
  status: number;
  text: string;
  contentType?: string;
  retryAfterSeconds?: number | null;
}): RobotsPolicy {
  const url = normalizeWebsiteUrl(input.url);
  if (!url) throw new Error("invalid_robots_url");
  const policy: RobotsPolicy = {
    origin: new URL(url).origin + "/",
    state: "ready",
    directives: [],
    sitemapLinks: [],
    crawlDelaySeconds: 1,
    warnings: [],
  };
  const fail = (state: RobotsPolicy["state"], warning: string) =>
    robotsPolicySchema.parse({
      ...policy,
      state,
      directives: [],
      sitemapLinks: [],
      warnings: [warning],
    });
  if (input.status === 429) return fail("rate_limited", "robots_rate_limited");
  if (input.status === 404) return robotsPolicySchema.parse(policy);
  if (input.status === 401 || input.status === 403)
    return fail("disallowed", "robots_access_denied");
  if (input.status < 200 || input.status >= 300)
    return fail("failed", "robots_unavailable");
  if (new TextEncoder().encode(input.text).byteLength > 1024 * 1024)
    return fail("failed", "robots_too_large");
  if (
    input.contentType &&
    !/^(?:text\/plain|application\/octet-stream)(?:;|$)/i.test(
      input.contentType,
    )
  )
    return fail("failed", "malformed_robots");
  let agentSeen = false,
    meaningfulLine = false,
    recognizedLine = false;
  for (const rawLine of input.text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) continue;
    meaningfulLine = true;
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) return fail("failed", "malformed_robots");
    const field = match[1]!.toLowerCase(),
      value = match[2]!.trim();
    if (value.length > 4096 || /[\u0000-\u001f<>]/.test(value))
      return fail("failed", "malformed_robots");
    if (field === "sitemap") {
      recognizedLine = true;
      const hint = normalizeWebsiteUrl(value);
      if (
        hint &&
        new URL(hint).origin === new URL(url).origin &&
        !policy.sitemapLinks.includes(hint)
      ) {
        if (policy.sitemapLinks.length < 5) policy.sitemapLinks.push(hint);
        else if (!policy.warnings.includes("sitemap_link_limit"))
          policy.warnings.push("sitemap_link_limit");
      }
      continue;
    }
    if (
      field !== "user-agent" &&
      field !== "allow" &&
      field !== "disallow" &&
      field !== "crawl-delay"
    )
      continue;
    if (field === "user-agent") {
      if (!/^[A-Za-z0-9_*.-]+(?:\/[\d.]+)?$/.test(value))
        return fail("failed", "malformed_robots");
      agentSeen = true;
    } else if (!agentSeen) return fail("failed", "malformed_robots");
    if (
      (field === "allow" || field === "disallow") &&
      value &&
      !value.startsWith("/")
    )
      return fail("failed", "malformed_robots");
    if (
      field === "crawl-delay" &&
      (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
    )
      return fail("failed", "malformed_robots");
    recognizedLine = true;
    policy.directives.push({ field, value });
    if (policy.directives.length > 20000)
      return fail("failed", "robots_rule_limit");
  }
  if (meaningfulLine && !recognizedLine)
    return fail("failed", "malformed_robots");
  const delay = robotsParser(url, content(policy)).getCrawlDelay(
    WEBSITE_ROBOTS_AGENT,
  );
  policy.crawlDelaySeconds = Math.max(1, delay ?? 1);
  return robotsPolicySchema.parse(policy);
}
