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
