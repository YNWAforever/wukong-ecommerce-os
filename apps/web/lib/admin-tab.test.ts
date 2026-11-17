import { describe, expect, it } from "vitest";

import { adminTabFromQuery } from "./admin-tab";

describe("adminTabFromQuery", () => {
  it("accepts only known tabs", () => {
    expect(adminTabFromQuery("connection")).toBe("connection");
    expect(adminTabFromQuery("capabilities")).toBe("capabilities");
    expect(adminTabFromQuery("members")).toBe("members");
    expect(adminTabFromQuery("settings")).toBe("settings");
  });

  it("falls back to members for missing or unknown values", () => {
    expect(adminTabFromQuery(undefined)).toBe("members");
    expect(adminTabFromQuery("")).toBe("members");
    expect(adminTabFromQuery("billing")).toBe("members");
    expect(adminTabFromQuery("../../connection")).toBe("members");
  });

  it("uses the first value when the query repeats", () => {
    expect(adminTabFromQuery(["connection", "settings"])).toBe("connection");
  });
});
