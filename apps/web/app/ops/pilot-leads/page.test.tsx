import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const resolveOperator = vi.fn();
const listPilotLeads = vi.fn();

vi.mock("../../../lib/ops-access", () => ({
  resolveOpsOperator: () => resolveOperator(),
}));
vi.mock("../../../lib/intake-runtime", () => ({
  getDatabase: () => ({ listPilotLeads }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "en" }) }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Error("notFound");
  },
}));

import OpsPilotLeadsPage from "./page";

const lead = {
  id: "lead-1",
  createdAt: new Date("2026-11-18T12:00:00.000Z"),
  name: "Ada Merchant",
  email: "ada@example.test",
  company: "Synthetic Cellar",
  platforms: ["shopline", "shopify"],
  skuVolume: "100_500",
  message: "We need a bilingual catalog review.",
  locale: "en",
  source: "wukong-ops-suite",
  consentAt: new Date("2026-11-18T11:59:00.000Z"),
};

beforeEach(() => {
  resolveOperator.mockReset();
  listPilotLeads.mockReset();
});

it("hides the page from a signed-in user who is not on the operator allowlist", async () => {
  resolveOperator.mockResolvedValue(null);
  await expect(OpsPilotLeadsPage()).rejects.toThrow("notFound");
  expect(listPilotLeads).not.toHaveBeenCalled();
});

it("renders the latest pilot requests for an allowlisted operator", async () => {
  resolveOperator.mockResolvedValue({
    userId: "ops-user",
    email: "ops@example.test",
  });
  listPilotLeads.mockResolvedValue([lead]);
  const html = renderToStaticMarkup(await OpsPilotLeadsPage());
  expect(html).toContain("Pilot leads");
  expect(html).toContain("Ada Merchant");
  expect(html).toContain("ada@example.test");
  expect(html).toContain("Synthetic Cellar");
  expect(html).toContain("shopline, shopify");
  expect(html).toContain("100–500");
  expect(html).toContain("We need a bilingual catalog review.");
  expect(html).toContain('href="mailto:ada@example.test"');
  expect(listPilotLeads).toHaveBeenCalledWith({ limit: 100 });
});

it("escapes lead content and shows an empty state without a table", async () => {
  resolveOperator.mockResolvedValue({
    userId: "ops-user",
    email: "ops@example.test",
  });
  listPilotLeads.mockResolvedValue([
    { ...lead, message: "<script>alert(1)</script>" },
  ]);
  const html = renderToStaticMarkup(await OpsPilotLeadsPage());
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

  listPilotLeads.mockResolvedValue([]);
  const empty = renderToStaticMarkup(await OpsPilotLeadsPage());
  expect(empty).toContain("No pilot requests yet.");
  expect(empty).not.toContain("Pilot lead list");
});
