// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { CatalogDetailDrawer } from "./catalog-detail-drawer";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("moves focus, traps both Tab directions, closes on Escape and restores the exact trigger", async () => {
  const trigger = document.createElement("button"),
    container = document.createElement("div");
  document.body.append(trigger, container);
  trigger.focus();
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <CatalogDetailDrawer
        title="Synthetic details"
        onClose={() => root.render(null)}
      >
        <a href="/listings/new">Maintenance</a>
      </CatalogDetailDrawer>,
    ),
  );
  const dialog = container.querySelector("dialog")!,
    close = dialog.querySelector("button")!,
    last = dialog.querySelector("a")!;
  expect(dialog.getAttribute("aria-labelledby")).toBe(
    dialog.querySelector("h2")!.id,
  );
  expect(document.activeElement).toBe(close);
  close.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(document.activeElement).toBe(last);
  last.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(document.activeElement).toBe(close);
  await act(async () =>
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(container.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");
  await act(async () => root.unmount());
  trigger.remove();
  container.remove();
});
