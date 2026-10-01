// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AccountMenu } from "./account-menu";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it("shows actual user identity, workspace, role and support entry", () => {
  act(() =>
    root.render(
      <AccountMenu
        user={{
          userId: "synthetic",
          name: "Synthetic operator",
          email: "synthetic@local.invalid",
        }}
        workspaceName="Synthetic cellar"
        roleLabel="Operator"
        locale="en"
      />,
    ),
  );
  expect(container.textContent).toContain("Synthetic operator");
  expect(container.textContent).toContain("synthetic@local.invalid");
  expect(container.textContent).toContain("Synthetic cellar");
  expect(container.textContent).toContain("Operator");
  expect(container.querySelector('a[href="/support"]')).not.toBeNull();
});
it("reports failed server logout and retains stored work", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
  sessionStorage.setItem(
    "wukong:catalog:selection:synthetic",
    "sensitive selection",
  );
  act(() =>
    root.render(
      <AccountMenu
        user={{
          userId: "synthetic",
          name: null,
          email: "synthetic@local.invalid",
        }}
        workspaceName="Synthetic cellar"
        roleLabel="Operator"
        locale="en"
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="sign-out"]')!
      .click(),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not sign out",
  );
  expect(sessionStorage.getItem("wukong:catalog:selection:synthetic")).toBe(
    "sensitive selection",
  );
});
