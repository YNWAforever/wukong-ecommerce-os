import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { STUDIO_AGENTS } from "../lib/studio/agents";
import { StudioAgents } from "./studio-agents";

function render(canCreateThread: boolean, locale: "zh-Hant" | "en" = "en") {
  return renderToStaticMarkup(
    <StudioAgents locale={locale} canCreateThread={canCreateThread} />,
  );
}

function hrefs(html: string): string[] {
  return Array.from(html.matchAll(/href="([^"]+)"/g), (match) => match[1]!);
}

describe("StudioAgents", () => {
  it("renders every reviewed agent, grouped with maturity badges", () => {
    const html = render(true);
    expect(html).toContain("Guided agent suite");
    expect(html).toContain("Core agents");
    expect(html).toContain("Advanced agents");
    expect(html).toContain("Operator tools");
    expect((html.match(/<h3/g) ?? []).length).toBe(STUDIO_AGENTS.length);
    expect(html).toContain("Pilot");
    expect(html).toContain("Planned");
    expect(html).toContain("Unavailable");
    expect(html).toContain("nothing executes or publishes by itself");
  });

  it("links only pilot agents to the composer, never planned or unavailable ones", () => {
    const links = hrefs(render(true));
    expect(links).toContain("/studio?agent=listing.copy_proposal");
    expect(links).toContain("/studio?agent=category.map_proposal");
    expect(links).not.toContain("/studio?agent=seo.merchant");
    expect(links).not.toContain("/studio?agent=customer.reply_draft");
    expect(links).not.toContain("/studio?agent=logistics.followup");
  });

  it("shows a role hint instead of a dead action for readers below operator", () => {
    const html = render(false);
    expect(html).not.toContain('href="/studio?agent=');
    expect(html).toContain("Ask an operator");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render(true, "zh-Hant");
    expect(html).toContain("引導式代理套件");
    expect(html).toContain("核心代理");
    expect(html).toContain("在工作室使用");
  });
});
