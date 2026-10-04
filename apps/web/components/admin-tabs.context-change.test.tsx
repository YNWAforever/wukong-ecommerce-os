// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, it, expect, vi } from "vitest";
const dirty = vi.hoisted(() => ({
  value: true,
  save: vi.fn<() => Promise<boolean>>(),
  discard: vi.fn(),
}));
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
vi.mock("../lib/admin-dirty-context", () => ({
  AdminDirtyProvider: ({ children }: { children: ReactNode }) => children,
  useAdminDirtyNavigation: () => ({
    hasDirty: dirty.value,
    saveAll: dirty.save,
    discardAll: dirty.discard,
  }),
}));
vi.mock("./admin-members-panel", () => ({ AdminMembersPanel: () => null }));
vi.mock("./admin-connection-panel", () => ({
  AdminConnectionPanel: () => null,
}));
vi.mock("./admin-settings-panel", () => ({ AdminSettingsPanel: () => null }));
vi.mock("./capability-registry-panel", () => ({
  CapabilityRegistryPanel: () => null,
}));
vi.mock("./workspace-readiness-panel", () => ({
  WorkspaceReadinessPanel: () => null,
}));
import { AdminTabs } from "./admin-tabs";
import { requestClientContextChange } from "../lib/client-context-change-guard";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  dirty.value = true;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const button = (name: string) =>
  Array.from(document.querySelectorAll("[role=alertdialog] button")).find(
    (item) => item.textContent?.includes(name),
  ) as HTMLButtonElement;
it("holds a second context change throughout pending/saving after dirty becomes clean", async () => {
  let resolve!: (value: boolean) => void;
  dirty.save.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(AdminTabs)));
  await act(async () =>
    (
      document.querySelector("#admin-tab-settings") as HTMLButtonElement
    ).click(),
  );
  await act(async () => button("Save").click());
  dirty.value = false;
  await act(async () => root!.render(createElement(AdminTabs)));
  const work = vi.fn().mockResolvedValue(undefined);
  let blocked!: Promise<boolean>;
  await act(async () => {
    blocked = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
    );
  });
  expect(await blocked).toBe(false);
  expect(work).not.toHaveBeenCalled();
  await act(async () => resolve(false));
  await act(async () => {
    blocked = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
    );
  });
  expect(await blocked).toBe(false);
  expect(work).not.toHaveBeenCalled();
  expect(document.querySelector("[role=alertdialog]")).not.toBeNull();
  await act(async () => button("Stay").click());
  await act(async () => {
    blocked = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
    );
  });
  expect(await blocked).toBe(true);
  expect(work).toHaveBeenCalledOnce();
});
it("unmount during save cannot later run the approved workspace action", async () => {
  let resolve!: (value: boolean) => void;
  dirty.save.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(AdminTabs)));
  const work = vi.fn().mockResolvedValue(undefined);
  let result!: Promise<boolean>;
  await act(async () => {
    result = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
    );
  });
  await act(async () => button("Save").click());
  await act(async () => root!.unmount());
  root = undefined;
  expect(await result).toBe(false);
  await act(async () => resolve(true));
  expect(work).not.toHaveBeenCalled();
});

it.each(["Discard", "Save"])(
  "blocks route/tab/Back while accepted %s workspace work is pending",
  async (choice) => {
    const originalUrl = window.location.href,
      originalReplace = window.history.replaceState;
    const originalNavigation = Object.getOwnPropertyDescriptor(
      window,
      "navigation",
    );
    let position = 1;
    const entries = [
      { href: new URL("/jobs", originalUrl).href, state: { __NA: true } },
      { href: new URL("/admin", originalUrl).href, state: { __NA: true } },
    ];
    Object.defineProperty(window, "navigation", {
      configurable: true,
      value: {
        get currentEntry() {
          return { index: position };
        },
      },
    });
    originalReplace.call(
      window.history,
      entries[1]!.state,
      "",
      entries[1]!.href,
    );
    const go = vi.spyOn(window.history, "go").mockImplementation((delta) => {
      position += delta ?? 0;
      const entry = entries[position]!;
      originalReplace.call(window.history, entry.state, "", entry.href);
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: entry.state }),
      );
    });
    let finish!: () => void;
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    dirty.discard.mockImplementation(() => {
      dirty.value = false;
    });
    dirty.save.mockImplementation(async () => {
      dirty.value = false;
      return true;
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    try {
      await act(async () => root!.render(createElement(AdminTabs)));
      let result!: Promise<boolean>;
      await act(async () => {
        result = requestClientContextChange(
          { kind: "workspace", workspaceId: "second" },
          work,
        );
      });
      await act(async () => button(choice).click());
      await act(async () => root!.render(createElement(AdminTabs)));
      expect(work).toHaveBeenCalledOnce();
      expect(document.querySelector("[role=alertdialog]")).toBeNull();
      await act(async () =>
        (
          document.querySelector("#admin-tab-settings") as HTMLButtonElement
        ).click(),
      );
      expect(
        document
          .querySelector("[role=tabpanel]")
          ?.getAttribute("aria-labelledby"),
      ).toBe("admin-tab-members");
      const link = document.createElement("a");
      link.href = "/catalog";
      document.body.append(link);
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      await act(async () => link.dispatchEvent(click));
      expect(click.defaultPrevented).toBe(true);
      await act(async () => window.history.go(-1));
      expect(window.location.pathname).toBe("/admin");
      expect(go.mock.calls).toEqual([[-1], [1]]);
      const settled = vi.fn();
      result.then(settled);
      await act(async () => root!.unmount());
      root = undefined;
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      finish();
      expect(await result).toBe(true);
    } finally {
      if (root) {
        await act(async () => root!.unmount());
        root = undefined;
      }
      finish?.();
      go.mockRestore();
      originalReplace.call(window.history, {}, "", originalUrl);
      if (originalNavigation)
        Object.defineProperty(window, "navigation", originalNavigation);
      else delete (window as Window & { navigation?: unknown }).navigation;
    }
  },
);
