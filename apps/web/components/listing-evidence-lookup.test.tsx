// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, it, expect, vi } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import { ListingEvidenceLookup } from "./listing-evidence-lookup";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});
const input = {
  revision: 2,
  baseVersionId: null,
  note: null,
  workingContent: {
    ...emptyWorkingListing(),
    producer: "Maker",
    title: { en: "Cuvee A", "zh-Hant": "" },
    vintage: 2020,
    volumeMl: 750,
    packQuantity: 1,
  },
  fieldStates: {},
  sources: [],
};
const evidence = {
  kind: "website",
  url: "https://producer.example/wine",
  retrievedAt: "2026-09-16T00:00:00Z",
  documentDigest: "a".repeat(64),
  sourceClass: "public_product_page",
  field: "country",
  excerpt: "France",
  location: "Product structured attributes",
  extraction: "structured_product_attributes_v1",
};
async function mount(fetcher: any, canEdit = true) {
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ListingEvidenceLookup, {
        listingId: "listing",
        input,
        canEdit,
        dirty: false,
        onSaved: async () => {},
      }),
    ),
  );
}
async function type(selector: string, value: string) {
  await act(async () => {
    const node = host.querySelector(selector)!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("retrieves explicit identity and adopts only selected stored facts", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ suggestion: null }))
    .mockResolvedValueOnce(
      Response.json({
        id: "suggestion",
        inputRevision: 2,
        url: evidence.url,
        match: "matched",
        reasons: [],
        fields: [
          {
            field: "country",
            value: "France",
            currentValue: null,
            evidence,
            eligible: true,
          },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ inputRevision: 3 }));
  await mount(fetcher);
  await type("[data-evidence-url]", evidence.url);
  await type('[data-evidence-identity="marketVariant"]', "HK");
  await act(async () => {
    (
      host.querySelector(
        '[data-action="retrieve-evidence"]',
      ) as HTMLButtonElement
    ).click();
  });
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({
    expectedInputRevision: 2,
    identity: {
      producer: "Maker",
      productName: "Cuvee A",
      marketVariant: "HK",
    },
  });
  expect(host.textContent).toContain("France");
  await act(async () => {
    (
      host.querySelector('[data-evidence-field="country"]') as HTMLInputElement
    ).click();
  });
  await act(async () => {
    (
      host.querySelector('[data-action="adopt-evidence"]') as HTMLButtonElement
    ).click();
  });
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
    expectedInputRevision: 2,
    baseVersionId: null,
    selectedFields: ["country"],
  });
});
it("shows unresolved identity and blocks viewer mutations", async () => {
  await mount(
    vi.fn().mockResolvedValue(
      Response.json({
        suggestion: {
          id: "s",
          match: "unresolved",
          reasons: ["identity_missing:marketVariant"],
          fields: [
            {
              field: "country",
              value: "France",
              currentValue: null,
              evidence,
              eligible: false,
            },
          ],
        },
      }),
    ),
    false,
  );
  expect(host.textContent).toContain("adoption is disabled");
  expect(
    (host.querySelector('[data-action="adopt-evidence"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (host.querySelector('[data-evidence-field="country"]') as HTMLInputElement)
      .disabled,
  ).toBe(true);
});

it("shows persisted rejection after reload and prevents adopting it", async () => {
  await mount(
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            suggestion: {
              id: "suggestion",
              inputRevision: 2,
              url: evidence.url,
              errorCode: null,
              match: "matched",
              reasons: [],
              candidateIdentity: null,
              fields: [
                {
                  field: "country",
                  value: "France",
                  currentValue: null,
                  evidence,
                  eligible: false,
                  rejected: true,
                },
              ],
            },
          }),
        ),
    ),
  );
  expect(host.textContent).toContain("Rejected");
  expect(
    (host.querySelector('[data-evidence-field="country"]') as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(
    (host.querySelector('[data-action="adopt-evidence"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("can reject conflicting suggestions without enabling adoption", async () => {
  const fetcher = vi.fn(
    async (_url: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "POST"
            ? { decisionId: "decision" }
            : {
                suggestion: {
                  id: "suggestion",
                  inputRevision: 2,
                  url: evidence.url,
                  errorCode: null,
                  match: "conflict",
                  reasons: [],
                  candidateIdentity: null,
                  fields: [
                    {
                      field: "country",
                      value: "France",
                      currentValue: null,
                      evidence,
                      eligible: false,
                      rejected: false,
                    },
                  ],
                },
              },
        ),
      ),
  );
  await mount(fetcher);
  await act(async () => {
    (
      host.querySelector('[data-evidence-field="country"]') as HTMLInputElement
    ).click();
  });
  expect(
    (host.querySelector('[data-action="adopt-evidence"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    (
      host.querySelector('[data-action="reject-evidence"]') as HTMLButtonElement
    ).click();
  });
  expect(
    fetcher.mock.calls.some(
      ([url, init]) => url.endsWith("/reject") && init?.method === "POST",
    ),
  ).toBe(true);
  expect(host.textContent).toContain("rejected and saved");
});

it("accepts a source claim with stable replay key and displays stored lineage", async () => {
  const claim = {
    kind: "rating",
    critic: "Robert Parker",
    value: "95",
    scale: "100",
    year: 2022,
    product: {
      producer: "Maker",
      productName: "Cuvee A",
      vintage: 2020,
      volumeMl: 750,
      packQuantity: 1,
      marketVariant: "HK",
    },
  };
  let calls = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      if (++calls === 1) throw new Error("lost response");
      return new Response(
        JSON.stringify({ inputRevision: 3, supportId: "support" }),
      );
    }
    return new Response(
      JSON.stringify({
        suggestion: {
          id: "suggestion",
          inputRevision: 2,
          url: evidence.url,
          errorCode: null,
          match: "matched",
          reasons: [],
          candidateIdentity: null,
          fields: [],
          claims: [
            {
              claim,
              support: {
                status: "supported",
                reasons: [],
                source: { ...evidence, excerpt: "Robert Parker 95 100 2022" },
              },
            },
          ],
          acceptedClaims: [
            {
              id: "old",
              copyField: "description.en",
              text: "old claim",
              inputRevision: 1,
              valid: false,
            },
          ],
        },
      }),
    );
  });
  await mount(fetcher);
  expect(host.textContent).toContain("Invalidated; review again");
  await act(async () => {
    (host.querySelector('[data-claim-index="0"]') as HTMLButtonElement).click();
  });
  await act(async () => {
    (host.querySelector('[data-claim-index="0"]') as HTMLButtonElement).click();
  });
  const sent = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(sent).toHaveLength(2);
  expect(sent[0]![1]!.headers).toEqual(sent[1]![1]!.headers);
  expect(JSON.parse(sent[1]![1]!.body as string)).toEqual({
    expectedInputRevision: 2,
    baseVersionId: null,
    claimIndex: 0,
    copyField: "description.en",
  });
  expect(host.textContent).toContain(
    "Save the working draft as a review version",
  );
});

it("explains the saved product/variant correction when identity is refused", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ suggestion: null }))
    .mockResolvedValueOnce(
      Response.json(
        { code: "identity_conflict", message: "internal details" },
        { status: 409 },
      ),
    );
  await mount(fetcher);
  await type("[data-evidence-url]", evidence.url);
  await type('[data-evidence-identity="marketVariant"]', "US");
  await act(async () => {
    (
      host.querySelector(
        '[data-action="retrieve-evidence"]',
      ) as HTMLButtonElement
    ).click();
  });
  expect(host.textContent).toContain(
    "First save the exact product name as the English title",
  );
  expect(host.textContent).toContain("Market variant: HK");
  expect(host.textContent).not.toContain("internal details");
});
