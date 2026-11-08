import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { studioCopy } from "./studio-copy";
import { formatStudioValue, renderStudioLine } from "./studio-render";

function spyConsole() {
  const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderStudioLine", () => {
  it("interpolates a known key's placeholders in both locales", () => {
    const line = {
      key: "studio.answer.catalog_found",
      values: { count: 3, truncated: false },
    };

    const en = renderStudioLine("en", line);
    expect(en).toContain("Found 3 matching listing records.");
    expect(en).toContain("Results truncated: No.");

    const zh = renderStudioLine("zh-Hant", line);
    expect(zh).toContain("找到 3 筆符合的商品記錄。");
    expect(zh).toContain("結果已截斷：否。");
  });

  it("formats booleans as the locale's yes/no instead of true/false", () => {
    expect(formatStudioValue("en", true)).toBe("Yes");
    expect(formatStudioValue("en", false)).toBe("No");
    expect(formatStudioValue("zh-Hant", true)).toBe("是");
    expect(formatStudioValue("zh-Hant", false)).toBe("否");
    expect(formatStudioValue("en", 250)).toBe("250");
  });

  it("renders a needs-input trace detail, which has no placeholders", () => {
    const spy = spyConsole();
    expect(
      renderStudioLine("en", { key: "studio.trace.needs_input", values: {} }),
    ).toBe("More information is needed before querying; nothing was read.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls back with a content-free log for a missing key", () => {
    const spy = spyConsole();

    const rendered = renderStudioLine("en", {
      key: "studio.answer.does_not_exist",
      values: { secret: "synthetic-listing-title" },
    });

    expect(rendered).toBe(studioCopy("en", "studio.render.fallback"));
    // The raw key, the values and any JSON never reach an operator.
    expect(rendered).not.toContain("does_not_exist");
    expect(rendered).not.toContain("synthetic-listing-title");
    expect(rendered).not.toContain("{");

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(spy.mock.calls[0]?.[0])) as {
      event: string;
      reason: string;
      key: string;
    };
    expect(logged).toEqual({
      event: "studio_line_render_fallback",
      reason: "missing_key",
      key: "studio.answer.does_not_exist",
    });
    // Content-free: no values are logged, only the copy key.
    expect(JSON.stringify(logged)).not.toContain("synthetic-listing-title");
  });

  it("falls back when a template placeholder has no usable value", () => {
    const spy = spyConsole();

    const rendered = renderStudioLine("en", {
      key: "studio.answer.recent_jobs",
      // `count` is required by this line.
      values: { count: null },
    });

    expect(rendered).toBe(studioCopy("en", "studio.render.fallback"));
    expect(rendered).not.toContain("{count}");
    const logged = JSON.parse(String(spy.mock.calls[0]?.[0])) as {
      reason: string;
      key: string;
    };
    expect(logged.reason).toBe("missing_value");
    expect(logged.key).toBe("studio.answer.recent_jobs");
  });

  it("rejects non-finite numbers and nested objects as values", () => {
    const spy = spyConsole();

    expect(
      renderStudioLine("en", {
        key: "studio.check.recent_jobs",
        values: { count: Number.NaN },
      }),
    ).toBe(studioCopy("en", "studio.render.fallback"));
    expect(
      renderStudioLine("en", {
        key: "studio.check.recent_jobs",
        values: { count: { nested: 1 } },
      }),
    ).toBe(studioCopy("en", "studio.render.fallback"));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps extra values that the template does not use", () => {
    const spy = spyConsole();

    // `studio.answer.coverage` does not reference `missingKinds`, so an
    // unused value is legal and must not trigger the fallback.
    const rendered = renderStudioLine("en", {
      key: "studio.answer.coverage",
      values: { present: 2, missing: 1, missingKinds: "website" },
    });

    expect(rendered).toBe("Sources present: 2; missing: 1.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("renders values as text, never markup", () => {
    const line = {
      key: "studio.check.listing_status",
      values: {
        listingId: "<img src=x onerror=alert(1)>",
        status: "approved",
        activeVersion: "present",
      },
    };

    const html = renderToStaticMarkup(
      <span>{renderStudioLine("en", line)}</span>,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("lets a value with braces stay literal text", () => {
    const rendered = renderStudioLine("en", {
      key: "studio.check.recent_jobs",
      values: { count: "{count}" },
    });
    // Substitution happens once; the value is not re-interpreted.
    expect(rendered).toBe("Recent jobs: {count}.");
  });

  it("treats a line without values as empty rather than stringifying it", () => {
    const spy = spyConsole();
    const rendered = renderStudioLine("en", {
      key: "studio.check.recent_jobs",
    });
    expect(rendered).toBe(studioCopy("en", "studio.render.fallback"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
