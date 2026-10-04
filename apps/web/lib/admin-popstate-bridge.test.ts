import { expect, it, vi } from "vitest";
import {
  ADMIN_POPSTATE_BRIDGE_SCRIPT,
  type AdminPopstateBridge,
} from "./admin-popstate-bridge";

function targetFixture() {
  const listeners: Array<(event: any) => void> = [];
  const window: {
    __wukongAdminPopstateBridge?: AdminPopstateBridge;
    addEventListener(
      name: string,
      listener: (event: any) => void,
      capture?: boolean,
    ): void;
  } = {
    addEventListener(name, listener) {
      if (name === "popstate") listeners.push(listener);
    },
  };
  const bootstrap = () =>
    new Function("window", ADMIN_POPSTATE_BRIDGE_SCRIPT)(window);
  const dispatch = () => {
    let stopped = false;
    const event = {
      eventPhase: 2,
      stopImmediatePropagation() {
        stopped = true;
      },
    };
    // Actual browser Window popstate is AT_TARGET and uses registration order,
    // even when a later subscription requests capture=true.
    for (const listener of listeners) {
      listener(event);
      if (stopped) break;
    }
  };
  return { window, listeners, bootstrap, dispatch };
}
it("a before-hydration bridge lets a later admin subscription guard Window AT_TARGET before the router", () => {
  const host = targetFixture();
  host.bootstrap();
  const router = vi.fn();
  host.window.addEventListener("popstate", router);
  const guard = vi.fn((event: PopStateEvent) =>
    event.stopImmediatePropagation(),
  );
  host.window.__wukongAdminPopstateBridge!.subscribe(guard);
  host.dispatch();
  expect(guard).toHaveBeenCalledOnce();
  expect(router).not.toHaveBeenCalled();
});
it("clean routes pass through and retired cleanup cannot remove a newer admin callback", () => {
  const host = targetFixture();
  host.bootstrap();
  host.bootstrap();
  expect(host.listeners).toHaveLength(1);
  const router = vi.fn(),
    retired = vi.fn(),
    current = vi.fn();
  host.window.addEventListener("popstate", router);
  host.dispatch();
  expect(router).toHaveBeenCalledOnce();
  const disposeRetired =
    host.window.__wukongAdminPopstateBridge!.subscribe(retired);
  const disposeCurrent =
    host.window.__wukongAdminPopstateBridge!.subscribe(current);
  disposeRetired();
  host.dispatch();
  expect(retired).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledOnce();
  expect(router).toHaveBeenCalledTimes(2);
  disposeCurrent();
  host.dispatch();
  expect(current).toHaveBeenCalledOnce();
  expect(router).toHaveBeenCalledTimes(3);
});
