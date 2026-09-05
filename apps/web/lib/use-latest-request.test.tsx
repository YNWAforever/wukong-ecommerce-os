// @vitest-environment happy-dom
import { act, createElement, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useLatestRequest } from "./use-latest-request";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};
function Harness({
  loader,
}: {
  loader: (signal: AbortSignal) => Promise<string>;
}) {
  const stable = useCallback(loader, [loader]);
  const state = useLatestRequest(stable, "failed");
  return createElement(
    "div",
    null,
    createElement("span", null, state.data ?? "empty"),
    state.error && createElement("p", { role: "alert" }, state.error),
    createElement("button", { onClick: state.reload }, "Retry"),
  );
}
describe("useLatestRequest", () => {
  it.each(["resolve", "reject"] as const)(
    "aborts cleanup and ignores a late %s from a transport ignoring abort",
    async (outcome) => {
      const request = deferred<string>();
      let signal!: AbortSignal;
      const loader = (value: AbortSignal) => {
        signal = value;
        return request.promise;
      };
      const host = document.createElement("div");
      const root = createRoot(host);
      await act(async () => root.render(createElement(Harness, { loader })));
      await act(async () => root.unmount());
      expect(signal.aborted).toBe(true);
      await act(async () => {
        if (outcome === "resolve") request.resolve("late");
        else request.reject(new Error("late"));
      });
      expect(host.textContent).toBe("");
    },
  );

  it("recovers on retry and clears the error", async () => {
    const first = deferred<string>(),
      second = deferred<string>();
    const loader = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Harness, { loader })));
    await act(async () => first.reject(new Error("temporary")));
    expect(host.querySelector("[role=alert]")?.textContent).toBe("temporary");
    await act(async () => {
      (host.querySelector("button") as HTMLButtonElement).click();
      second.resolve("current");
      await second.promise;
    });
    expect(host.textContent).toContain("current");
    expect(host.querySelector("[role=alert]")).toBeNull();
    await act(async () => root.unmount());
  });
  it("ignores an older success after a newer request even when abort is ignored", async () => {
    const first = deferred<string>(),
      second = deferred<string>();
    const loader = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Harness, { loader })));
    await act(async () => {
      (host.querySelector("button") as HTMLButtonElement).click();
      second.resolve("new");
      await second.promise;
    });
    await act(async () => {
      first.resolve("old");
      await first.promise;
    });
    expect(host.textContent).toContain("new");
    expect(host.textContent).not.toContain("old");
    await act(async () => root.unmount());
  });
});
