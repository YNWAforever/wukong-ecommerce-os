import { describe, expect, it } from "vitest";
import { installAdminHistoryGuard } from "./admin-history-guard";
function hostFixture(indexes = true) {
  const entries = ["/catalog", "/jobs", "/admin", "/quality"].map((url) => ({
    url,
    state: {
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: [url],
      unrelated: "kept",
    } as any,
  }));
  let position = 2;
  const listeners: Array<(event: any) => void> = [];
  const traversals: number[] = [];
  let rendered = "/admin";
  const host: any = {
    location: { href: "http://localhost/admin" },
    history: {
      get state() {
        return entries[position]!.state;
      },
      get length() {
        return entries.length;
      },
      pushState(state: any, _title: string, url: string) {
        entries.splice(position + 1);
        entries.push({ state, url: new URL(url, host.location.href).pathname });
        position++;
        host.location.href = new URL(url, host.location.href).href;
      },
      replaceState(state: any, _title: string, url: string) {
        entries[position] = {
          state,
          url: new URL(url, host.location.href).pathname,
        };
        host.location.href = new URL(url, host.location.href).href;
      },
      go(delta: number) {
        traversals.push(delta);
        const next = position + delta;
        if (next < 0 || next >= entries.length) return;
        position = next;
        host.location.href = "http://localhost" + entries[position]!.url;
        let stopped = false;
        const event = {
          state: entries[position]!.state,
          stopImmediatePropagation() {
            stopped = true;
          },
        };
        for (const listener of listeners) {
          listener(event);
          if (stopped) break;
        }
        if (!stopped) rendered = entries[position]!.url;
      },
    },
    dispatchPopState(state: unknown) {
      let stopped = false;
      const event = {
        state,
        stopImmediatePropagation() {
          stopped = true;
        },
      };
      for (const listener of listeners) {
        listener(event);
        if (stopped) break;
      }
      if (!stopped) rendered = new URL(host.location.href).pathname;
    },
    getIndex: indexes ? () => position : () => undefined,
    addEventListener(_name: string, listener: any) {
      listeners.push(listener);
    },
    removeEventListener(_name: string, listener: any) {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return { host, entries, traversals, rendered: () => rendered };
}
describe("admin history dirty guard", () => {
  it("restores browser-back URL before asking and Stay adds no trap entries", () => {
    const fixture = hostFixture();
    let dirty = true;
    let requested: number | null = null;
    const guard = installAdminHistoryGuard(
      fixture.host,
      () => dirty,
      (delta) => {
        requested = delta;
      },
    );
    fixture.host.history.go(-1);
    expect(requested).toBe(-1);
    expect(fixture.host.location.href).toBe("http://localhost/admin");
    expect(fixture.rendered()).toBe("/admin");
    expect(fixture.host.history.length).toBe(4);
    requested = null;
    fixture.host.history.go(-1);
    expect(requested).toBe(-1);
    expect(fixture.host.location.href).toBe("http://localhost/admin");
    expect(fixture.host.history.length).toBe(4);
    dirty = false;
    guard.leave(-1);
    expect(fixture.host.location.href).toBe("http://localhost/jobs");
    expect(fixture.rendered()).toBe("/jobs");
    guard.dispose();
    fixture.host.history.go(-1);
    expect(fixture.rendered()).toBe("/catalog");
  });
  it("replays approved discard exactly once while the dirty ref is still true", () => {
    const fixture = hostFixture();
    const requested: number[] = [];
    const guard = installAdminHistoryGuard(
      fixture.host,
      () => true,
      (delta) => requested.push(delta),
    );
    fixture.host.history.go(-1);
    guard.leave(requested[0]!);
    expect(requested).toEqual([-1]);
    expect(fixture.rendered()).toBe("/jobs");
    expect(fixture.traversals).toEqual([-1, 1, -1]);
    expect(fixture.entries[2]!.state).toMatchObject({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: ["/admin"],
      unrelated: "kept",
    });
    guard.dispose();
  });
  it("restores forward and multi-entry traversal using native entry positions", () => {
    const fixture = hostFixture();
    let delta = 0;
    const guard = installAdminHistoryGuard(
      fixture.host,
      () => true,
      (value) => {
        delta = value;
      },
    );
    fixture.host.history.go(1);
    expect(delta).toBe(1);
    expect(fixture.host.location.href).toBe("http://localhost/admin");
    guard.leave(1);
    expect(fixture.rendered()).toBe("/quality");
    guard.dispose();
    const back = hostFixture();
    const guard2 = installAdminHistoryGuard(
      back.host,
      () => true,
      (value) => {
        delta = value;
      },
    );
    back.host.history.go(-2);
    expect(delta).toBe(-2);
    expect(back.host.location.href).toBe("http://localhost/admin");
    guard2.leave(-2);
    expect(back.rendered()).toBe("/catalog");
    guard2.dispose();
  });
  it("guards an unknown predecessor without guessing its position and restores patched methods", () => {
    const fixture = hostFixture(false);
    const originalPush = fixture.host.history.pushState;
    const originalReplace = fixture.host.history.replaceState;
    let delta = 0;
    const guard = installAdminHistoryGuard(
      fixture.host,
      () => true,
      (value) => {
        delta = value;
      },
    );
    fixture.host.history.go(-1);
    expect(delta).toBe(0);
    expect(fixture.host.location.href).toBe("http://localhost/admin");
    guard.leave(delta);
    expect(fixture.rendered()).toBe("/jobs");
    guard.dispose();
    expect(fixture.host.history.pushState).toBe(originalPush);
    expect(fixture.host.history.replaceState).toBe(originalReplace);
  });
});

it.each([1, -2])(
  "keeps URL and content together for an unknown traversal %i, then approves its exact destination",
  (attempt) => {
    const fixture = hostFixture(false);
    const requested: number[] = [];
    const guard = installAdminHistoryGuard(
      fixture.host,
      () => true,
      (delta) => requested.push(delta),
    );
    fixture.host.history.go(attempt);
    expect(requested).toEqual([0]);
    expect(fixture.host.location.href).toBe("http://localhost/admin");
    expect(fixture.rendered()).toBe("/admin");
    expect(fixture.traversals).toEqual([attempt]);
    expect(fixture.host.history.length).toBe(4);
    guard.leave(requested[0]!);
    const destination = attempt === 1 ? "/quality" : "/catalog";
    expect(fixture.host.location.href).toBe("http://localhost" + destination);
    expect(fixture.rendered()).toBe(destination);
    expect(fixture.traversals).toEqual([attempt]);
    expect(fixture.host.history.length).toBe(4);
    guard.dispose();
  },
);
it("repeated Stay on unknown entries does not guess, add entries, or loop history", () => {
  const fixture = hostFixture(false);
  const requested: number[] = [];
  const guard = installAdminHistoryGuard(
    fixture.host,
    () => true,
    (delta) => requested.push(delta),
  );
  fixture.host.history.go(1);
  fixture.host.history.go(-2);
  expect(requested).toEqual([0, 0]);
  expect(fixture.host.location.href).toBe("http://localhost/admin");
  expect(fixture.rendered()).toBe("/admin");
  expect(fixture.traversals).toEqual([1, -2]);
  expect(fixture.host.history.length).toBe(4);
  guard.leave(0);
  expect(fixture.rendered()).toBe("/jobs");
  guard.dispose();
});
