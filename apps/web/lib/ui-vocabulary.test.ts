/**
 * One workflow, named one way.
 *
 * The interface accumulated synonyms nobody chose: a role chip reading 審閱者
 * while every message gating that role said 審核員, a status reading 發布中 on
 * one screen and 發佈中 on the next -- 發布 being the Simplified form of a word
 * the rest of the product spells 發佈 -- and one copy module calling a product
 * 刊登 where the other hundred-and-ninety usages said 商品. Each on its own is
 * a small thing. Together they tell an operator that two screens are two
 * systems.
 *
 * Fixing the strings does not keep them fixed; the next person to write copy
 * has nothing telling them which word won. So the retired terms are named
 * here, and using one again fails the build with the word to use instead.
 *
 * This is a vocabulary guard, not a translation check. It says nothing about
 * whether the copy is any good -- only that it is consistent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const RETIRED: ReadonlyArray<{ term: string; use: string; because: string }> = [
  {
    term: "發布",
    use: "發佈",
    because: "the Simplified form of the word the product spells 發佈",
  },
  {
    term: "審閱者",
    use: "審核員",
    because: "the word every permission message already uses for this role",
  },
  {
    term: "刊登",
    use: "商品, or 上架 for the act of listing",
    because: "商品 is what the rest of the interface calls the object",
  },
  {
    term: "上架項目",
    use: "商品",
    because: "the same component already says 商品 in its own heading",
  },
];

/** Source that ships as interface copy. Tests and generated output excluded. */
function copySources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      copySources(path, found);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    found.push(path);
  }
  return found;
}

/**
 * Prose about a retired term is not a use of it.
 *
 * Without this the comment explaining why 發布 was retired would itself fail
 * the check, and the only way to pass would be to delete the explanation.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("interface vocabulary", () => {
  const sources = copySources(join(import.meta.dirname, ".."));

  it("reads enough of the app to be worth trusting", () => {
    // A guard that silently stopped finding files would pass for ever.
    expect(sources.length).toBeGreaterThan(100);
  });

  it.each(RETIRED)("no longer says $term", ({ term, use, because }) => {
    const offenders = sources
      .filter((path) =>
        withoutComments(readFileSync(path, "utf8")).includes(term),
      )
      .map((path) => relative(join(import.meta.dirname, ".."), path));

    expect(
      offenders,
      `"${term}" is retired -- use "${use}" (${because}).`,
    ).toEqual([]);
  });
});
