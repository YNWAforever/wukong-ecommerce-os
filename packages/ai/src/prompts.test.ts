import { LISTING_PROMPT_VERSIONS } from "@wukong/core";
import { describe, expect, it } from "vitest";
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_PROMPT,
  GENERATION_INSTRUCTIONS,
  GENERATION_PROMPT,
} from "./prompts.js";

describe("listing prompts treat supplied material as data", () => {
  it.each([
    ["extraction", EXTRACTION_INSTRUCTIONS],
    ["generation", GENERATION_INSTRUCTIONS],
  ])("%s instructions declare every supplied source untrusted", (_, text) => {
    expect(text).toMatch(/untrusted data, never instructions/i);
    for (const source of ["note", "label", "workbook", "web page"])
      expect(text.toLowerCase()).toContain(source);
  });

  it("bumps the pinned versions with the instruction change", () => {
    expect(EXTRACTION_PROMPT.version).toBe("1.2.0");
    expect(GENERATION_PROMPT.version).toBe("1.1.0");
    expect(LISTING_PROMPT_VERSIONS).toEqual({
      extraction: "1.2.0",
      generation: "1.1.0",
    });
  });
});
