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

/**
 * Copy that ignores the language toggle.
 *
 * The batch feature was localised twice in one week -- first two components,
 * then the two siblings nobody had named -- because nothing measured the gap.
 * Twelve files still contain Traditional Chinese with no locale awareness at
 * all: no `localized()`, no `stateLabel()`, no `"zh-Hant"` map, not even a
 * `Locale` in scope. For a reader who has chosen English, those surfaces are
 * simply in a language they did not pick.
 *
 * This is a ratchet, not a proof. It cannot see a file that localises most of
 * its copy and hardcodes the rest -- that is what the retired-term check above
 * is for. What it does guarantee is that the list below only ever shrinks: a
 * new file with hardcoded Chinese fails immediately, and a converted file must
 * be struck off, which is what makes the remaining work countable.
 */
const UNLOCALISED_SURFACES = [
  "app/(app)/admin/page.tsx",
  "components/admin-members-panel.tsx",
  "components/admin-settings-panel.tsx",
  "components/bulk-import-panel.tsx",
  "components/listing-intake-form.tsx",
  "components/listing-view-models.ts",
  "components/new-product-blocked-panel.tsx",
  "components/supporting-evidence-panel.tsx",
  "lib/listing-approval.ts",
];

/** Han characters. Deliberately not matching kana or punctuation. */
const HAN = /[\u4e00-\u9fff]/;

/**
 * Any sign the file knows a language exists.
 *
 * Deliberately generous: `read-page-copy.ts` keys a map by `"zh-Hant"` and
 * `auth-form.tsx` takes a `Locale` parameter, and neither is a defect. A file
 * that trips this check has no bilingual mechanism whatsoever.
 */
const LOCALE_AWARE = /localized\(|stateLabel\(|"zh-Hant"|labelZh|Locale/;

describe("localisation coverage", () => {
  const sources = copySources(join(import.meta.dirname, ".."));

  it("has no surface with Chinese copy and no notion of language, beyond the known list", () => {
    const offenders = sources
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return HAN.test(source) && !LOCALE_AWARE.test(source);
      })
      .map((path) => relative(join(import.meta.dirname, ".."), path))
      .map((path) => path.split("\\").join("/"))
      .sort();

    expect(offenders).toEqual([...UNLOCALISED_SURFACES].sort());
  });

  it("keeps the known list honest", () => {
    // A file that has been converted must be struck off, or the list stops
    // meaning anything. A path that no longer exists must go too.
    for (const entry of UNLOCALISED_SURFACES) {
      const source = readFileSync(
        join(import.meta.dirname, "..", entry),
        "utf8",
      );
      expect(HAN.test(source), entry + " no longer has Chinese copy").toBe(
        true,
      );
      expect(
        LOCALE_AWARE.test(source),
        entry + " is localised now, so strike it off the list",
      ).toBe(false);
    }
  });
});
