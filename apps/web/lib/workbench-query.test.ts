import { describe, expect, it } from "vitest";
import {
  parseWorkbenchQuery,
  workbenchQueryKey,
  changeWorkbenchQuery,
} from "./workbench-query";
describe("workbench URL", () => {
  it("normalizes invalid filters and bounded pages", () => {
    expect(parseWorkbenchQuery("state=no&kind=no&page=-1")).toEqual({
      state: "attention",
      page: 1,
      pageSize: 25,
    });
    expect(
      workbenchQueryKey(
        parseWorkbenchQuery("page=2&kind=export&state=completed"),
      ),
    ).toBe("state=completed&kind=export&page=2&pageSize=25");
  });
  it("resets exactly page on filter changes", () => {
    const query = parseWorkbenchQuery("state=completed&kind=export&page=9");
    expect(changeWorkbenchQuery(query, { kind: "listing" })).toEqual({
      ...query,
      kind: "listing",
      page: 1,
    });
    expect(changeWorkbenchQuery(query, { state: "progress" })).toEqual({
      ...query,
      state: "progress",
      page: 1,
    });
    expect(changeWorkbenchQuery(query, { page: 8 })).toEqual({
      ...query,
      page: 8,
    });
  });
});
