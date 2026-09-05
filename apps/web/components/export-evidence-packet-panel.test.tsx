// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ExportEvidencePacketPanel } from "./export-evidence-packet-panel";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const summary = (id = "older") => ({
  exportAttemptId: "attempt",
  comparisonId: id,
  snapshotSha256: "a".repeat(64),
  asOf: "2026-09-05T00:00:00Z",
  memberCount: 2,
  receiptRevisionCount: 3,
  reportedMemberCount: 2,
  unreportedMemberCount: 0,
  comparisonOutcome: "matches_compared_fields",
  comparisonCounts: { expected: 2, matched: 2 },
  byteLength: 1234,
  artifactSha256: "b".repeat(64),
  suppliedSha256: "c".repeat(64),
});
async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (comparisonId = "older", eligible = true) => {
    await act(async () =>
      root.render(
        createElement(ExportEvidencePacketPanel, {
          attemptId: "attempt",
          comparisonId,
          eligible,
        }),
      ),
    );
  };
  await render();
  return {
    host,
    render,
    click: async (name: string) => {
      await act(async () =>
        Array.from(host.querySelectorAll("button"))
          .find((b) => b.textContent === name)!
          .click(),
      );
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
it("previews exact selection and posts its reviewed hash once before downloading unchanged server bytes", async () => {
  const bytes =
    '{"payload":{"comparison":{"id":"older"}},"payloadSha256":"digest"}';
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(summary()))
    .mockResolvedValueOnce(new Response(bytes));
  vi.stubGlobal("fetch", fetcher);
  const urls = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:packet");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const clicks = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const ui = await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await ui.click("Preview evidence packet");
  expect(String(fetcher.mock.calls[0]![0])).toBe(
    "/api/listings/export/attempt/evidence-packet?comparisonId=older",
  );
  expect(ui.host.textContent).toContain(
    "Not a UAT sign-off or merchant-write authorization",
  );
  await act(async () => {
    const b = Array.from(ui.host.querySelectorAll("button")).find(
      (b) => b.textContent === "Download evidence JSON",
    )!;
    b.click();
    b.click();
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
    comparisonId: "older",
    expectedSnapshotSha256: "a".repeat(64),
  });
  expect(await (urls.mock.calls[0]![0] as Blob).text()).toBe(bytes);
  expect(clicks).toHaveBeenCalledTimes(1);
  await ui.close();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:packet");
});
it("ignores old responses on selection changes and revokes controls when ineligible", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockReturnValue(
      new Promise<Response>((r) => {
        finish = r;
      }),
    ),
  );
  const ui = await mount();
  await ui.click("Preview evidence packet");
  await ui.render("newer");
  await act(async () => finish(Response.json(summary())));
  expect(ui.host.textContent).not.toContain("1234");
  expect(
    ui.host.querySelector<HTMLButtonElement>("[data-download-evidence]")!
      .disabled,
  ).toBe(true);
  await ui.render("newer", false);
  expect(ui.host.querySelector("button")).toBeNull();
  await ui.close();
});
it("requires explicit refresh and review after 409 and retains selection and preview for safe 503 retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(summary()))
    .mockResolvedValueOnce(
      Response.json({ code: "evidence_snapshot_changed" }, { status: 409 }),
    )
    .mockResolvedValueOnce(Response.json(summary()))
    .mockResolvedValueOnce(
      Response.json(
        { code: "evidence_packet_unavailable", message: "private" },
        { status: 503 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const ui = await mount();
  await ui.click("Preview evidence packet");
  await ui.click("Download evidence JSON");
  expect(ui.host.textContent).toContain("Refresh the preview and review");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    ui.host.querySelector<HTMLButtonElement>("[data-download-evidence]")!
      .disabled,
  ).toBe(true);
  await ui.click("Preview evidence packet");
  await ui.click("Download evidence JSON");
  expect(ui.host.textContent).toContain("Please retry");
  expect(ui.host.textContent).not.toContain("private");
  expect(
    ui.host.querySelector<HTMLButtonElement>("[data-download-evidence]")!
      .disabled,
  ).toBe(false);
  await ui.close();
});
it("refuses a preview for a different comparison", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json(summary("wrong"))),
  );
  const ui = await mount();
  await ui.click("Preview evidence packet");
  expect(
    ui.host.querySelector<HTMLButtonElement>("[data-download-evidence]")!
      .disabled,
  ).toBe(true);
  await ui.close();
});

it("hides controls when the artifact is no longer ready", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "export_artifact_not_ready" }, { status: 409 }),
      ),
  );
  const ui = await mount();
  await ui.click("Preview evidence packet");
  expect(ui.host.querySelector("button")).toBeNull();
  await ui.close();
});
it("never downloads an old in-flight POST after selection changes", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(summary()))
      .mockReturnValueOnce(
        new Promise<Response>((r) => {
          finish = r;
        }),
      ),
  );
  const urls = vi.spyOn(URL, "createObjectURL");
  const ui = await mount();
  await ui.click("Preview evidence packet");
  await ui.click("Download evidence JSON");
  await ui.render("newer");
  await act(async () => finish(new Response("old packet")));
  expect(urls).not.toHaveBeenCalled();
  await ui.close();
});
