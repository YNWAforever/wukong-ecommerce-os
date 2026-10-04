import { describe, expect, it } from "vitest";

import { createCatalogPerformance } from "./catalog-performance";

describe("catalog performance attribution", () => {
  it("keeps inclusive workspace time separate from its nested query", async () => {
    let now = 0;
    const timing = createCatalogPerformance(() => now);
    const result = await timing.measure("workspace", async () => {
      now = 10;
      await timing.measure("catalog", async () => {
        now = 35;
      });
      now = 60;
      return "owned result";
    });
    now = 65;
    const response = timing.attach(Response.json({ result }));
    expect(await response.json()).toEqual({ result: "owned result" });
    expect(response.headers.get("server-timing")).toBe(
      "workspace;dur=60.0, catalog;dur=25.0, total;dur=65.0",
    );
  });

  it("propagates the original failure and suppresses failure timings", async () => {
    const failure = Object.assign(new Error("private SQL and customer text"), {
      code: "42501",
    });
    const timing = createCatalogPerformance();
    await expect(
      timing.measure("catalog", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const response = timing.attach(
      Response.json({ code: "internal_error" }, { status: 500 }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("server-timing")).toBeNull();
  });

  it("does not mix simultaneous request measurements", async () => {
    let firstNow = 0;
    let secondNow = 0;
    const first = createCatalogPerformance(() => firstNow);
    const second = createCatalogPerformance(() => secondNow);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = first.measure("session", async () => {
      await gate;
    });
    await second.measure("catalog", async () => {
      secondNow = 7;
    });
    firstNow = 50;
    release();
    await pending;
    expect(first.attach(Response.json({})).headers.get("server-timing")).toBe(
      "session;dur=50.0, total;dur=50.0",
    );
    expect(second.attach(Response.json({})).headers.get("server-timing")).toBe(
      "catalog;dur=7.0, total;dur=7.0",
    );
  });

  it("omits invalid durations and ignores non-allowlisted runtime labels", async () => {
    let now = 10;
    const timing = createCatalogPerformance(() => now);
    await timing.measure("session", async () => {
      now = 5;
    });
    await timing.measure("catalog", async () => {
      now = Number.NaN;
    });
    now = 10;
    await timing.measure("customer-name;desc=secret" as "sources", async () => {
      now = 12;
    });
    expect(timing.attach(Response.json({})).headers.get("server-timing")).toBe(
      "total;dur=2.0",
    );
  });
});
