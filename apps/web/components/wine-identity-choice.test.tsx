// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WineIdentityChoice } from "./wine-identity-choice";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("confirms an eligible persisted candidate ID, never a browser identity", async () => {
  const el = document.createElement("div"),
    root = createRoot(el),
    confirm = vi.fn();
  const candidate = {
    id: "persisted-source",
    runId: "persisted-run",
    stage: "verification",
    confirmationAvailable: true,
    identity: {
      productName: "Bottle",
      producer: "Producer",
      vintage: { state: "known", year: 2020 },
      volumeMl: 750,
      marketVariant: "HK",
    },
  } as any;
  await act(async () =>
    root.render(
      <WineIdentityChoice
        candidates={[
          candidate,
          { ...candidate, id: "unavailable", confirmationAvailable: false },
        ]}
        onConfirm={confirm}
        busy={false}
      />,
    ),
  );
  const radio = el.querySelector('input[type="radio"]') as HTMLInputElement;
  expect(radio).not.toBeNull();
  expect(el.textContent).toContain("2020");
  expect(el.textContent).toContain("750");
  await act(async () => radio.click());
  await act(async () =>
    (el.querySelector("button") as HTMLButtonElement).click(),
  );
  expect(confirm).toHaveBeenCalledWith(candidate);
  expect((el.querySelectorAll("input")[1] as HTMLInputElement).disabled).toBe(
    true,
  );
  await act(async () => root.unmount());
});

vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));

it("groups duplicate eligible identity coordinates while submitting an existing exact reference", async () => {
  const el = document.createElement("div"),
    root = createRoot(el),
    confirm = vi.fn();
  const candidate = {
    id: "document-2020",
    runId: "current-run",
    stage: "verification_deep",
    confirmationAvailable: true,
    identity: {
      kind: "wine",
      producer: "Producer",
      productName: "Bottle",
      cuvee: null,
      vintage: { state: "known", year: 2020 },
      volumeMl: 750,
      packQuantity: 1,
      marketVariant: "HK",
      barcode: null,
    },
  } as any;
  await act(async () =>
    root.render(
      <WineIdentityChoice
        candidates={[
          candidate,
          { ...candidate, id: "snippet-2020" },
          {
            ...candidate,
            id: "document-2021",
            identity: {
              ...candidate.identity,
              vintage: { state: "known", year: 2021 },
            },
          },
          {
            ...candidate,
            id: "different-pack",
            identity: { ...candidate.identity, packQuantity: 6 },
          },
        ]}
        onConfirm={confirm}
        busy={false}
      />,
    ),
  );
  expect(el.querySelectorAll("input")).toHaveLength(3);
  expect(el.textContent).toContain("2 source references");
  await act(async () =>
    (el.querySelector("input") as HTMLInputElement).click(),
  );
  await act(async () =>
    (el.querySelector("button") as HTMLButtonElement).click(),
  );
  expect(confirm).toHaveBeenCalledWith(candidate);
  await act(async () => root.unmount());
});

it("keeps ABV, category facts and unknown versus non-vintage choices distinct", async () => {
  const el = document.createElement("div"),
    root = createRoot(el),
    confirm = vi.fn();
  const candidate = {
    id: "abv-13",
    runId: "run",
    stage: "verification_deep",
    confirmationAvailable: true,
    identity: {
      kind: "wine",
      producer: "Producer",
      productName: "Bottle",
      vintage: { state: "unknown", year: null },
      volumeMl: 750,
      abvPercent: 13,
      category: {
        appellation: {
          state: "observed",
          value: "Region A",
          evidenceIds: ["source-a"],
        },
      },
    },
  } as any;
  const choices = [
    candidate,
    {
      ...candidate,
      id: "same-facts-other-source",
      identity: {
        ...candidate.identity,
        category: {
          appellation: {
            state: "observed",
            value: "Region A",
            evidenceIds: ["source-b"],
          },
        },
      },
    },
    {
      ...candidate,
      id: "abv-14",
      identity: { ...candidate.identity, abvPercent: 14 },
    },
    {
      ...candidate,
      id: "region-b",
      identity: {
        ...candidate.identity,
        category: {
          appellation: {
            state: "observed",
            value: "Region B",
            evidenceIds: ["source-c"],
          },
        },
      },
    },
    {
      ...candidate,
      id: "non-vintage",
      identity: {
        ...candidate.identity,
        vintage: { state: "not_applicable", year: null },
      },
    },
  ];
  await act(async () =>
    root.render(
      <WineIdentityChoice
        candidates={choices}
        onConfirm={confirm}
        busy={false}
      />,
    ),
  );
  expect(el.querySelectorAll("input")).toHaveLength(4);
  expect(el.textContent).toContain("13% ABV");
  expect(el.textContent).toContain("14% ABV");
  expect(el.textContent).toContain("Appellation: Region A");
  expect(el.textContent).toContain("Appellation: Region B");
  expect(el.textContent).toContain("Unknown vintage");
  expect(el.textContent).toContain("Non-vintage / not applicable");
  await act(async () =>
    (el.querySelectorAll("input")[2] as HTMLInputElement).click(),
  );
  await act(async () =>
    (el.querySelector("button") as HTMLButtonElement).click(),
  );
  expect(confirm).toHaveBeenCalledWith(choices[3]);
  await act(async () => root.unmount());
});
