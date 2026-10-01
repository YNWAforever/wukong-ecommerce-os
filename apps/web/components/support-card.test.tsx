// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SupportCard } from "./support-card";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
  vi.restoreAllMocks();
});
it("shows explicitly unconfigured contact when no active workspace admin exists", () => {
  act(() => root.render(<SupportCard contacts={[]} locale="en" />));
  expect(container.textContent).toContain(
    "No workspace administrator contact is configured",
  );
  expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
});
it("uses actual workspace admins and only copies an opaque request ID", async () => {
  const clipboard = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
  const id = "00000000-0000-4000-8000-000000000001";
  act(() =>
    root.render(
      <SupportCard
        contacts={[
          {
            userId: "admin",
            email: "admin@local.invalid",
            name: "Synthetic admin",
          },
        ]}
        locale="en"
        requestId={id}
      />,
    ),
  );
  expect(
    container.querySelector('a[href="mailto:admin@local.invalid"]'),
  ).not.toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="copy-support-id"]')!
      .click(),
  );
  expect(clipboard).toHaveBeenCalledWith(id);
  expect(container.textContent).toContain("Copied");
});
it("does not render unsafe request input as a support identifier", () => {
  act(() =>
    root.render(
      <SupportCard contacts={[]} locale="en" requestId="token=secret" />,
    ),
  );
  expect(container.textContent).not.toContain("token=secret");
  expect(container.querySelector('[data-testid="copy-support-id"]')).toBeNull();
});
