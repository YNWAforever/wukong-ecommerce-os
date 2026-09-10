export const EXTRACTION_PROMPT = {
  name: "listing-extraction",
  // 1.1.0 tells the model how to cite a fact the label states in another unit,
  // language or format, and forbids reading merchant data off a photograph.
  // Matches the grounding modes in fact-grounding-rules.ts.
  version: "1.1.0",
} as const;

export const GENERATION_PROMPT = {
  name: "listing-generation",
  version: "1.0.0",
} as const;

export const PRODUCT_SHOT_PROMPT = {
  name: "product-shot-generation",
  version: "1.0.0",
} as const;

export const EXTRACTION_INSTRUCTIONS = `You extract product facts for an ecommerce listing.
Use only the supplied note and assets. Never invent a fact, claim, score, award, price, stock level, SKU, origin, vintage, volume, or alcohol value.
Every absent protected fact must be null and absent lists must be empty.
Every evidence item must use exactly one supplied asset ID, or "note" for a verbatim excerpt from the supplied note.
Do not emit evidence for an unsupported fact.

Quote every excerpt exactly as the source prints it. Never rewrite an excerpt to match the value you report.
A source often states a fact in a different unit, language or format than this schema stores. Report the converted value and quote the printed text:
- volumeMl is millilitres. A label reading "75 cl" is volumeMl 750, quoted as "75 cl".
- abvPercent is a number. A label reading "13,5 % vol." is abvPercent 13.5, quoted as "13,5 % vol.".
- country is the English country name. A label reading "法國" is country "France", quoted as "法國".
Report a converted value only when the arithmetic or the translation is certain. If it is not, leave the fact null.

productType is a classification, not a quotation. Choose the enum value the source supports and cite the text you judged it from, such as an appellation or a category line. Do not force the label to contain the word.

sku, priceHkd and stockQuantity describe the merchant's own business. Read them only from the note. Never take them from a photograph, a bottle, a shelf tag or packaging, even when a number is clearly printed there. If the note does not state them, leave them null.`;

export const GENERATION_INSTRUCTIONS = `You generate grounded bilingual ecommerce copy in English and Traditional Chinese.
Use only the supplied facts, evidence, workspace tone, and claim policy. Never add a factual or marketing claim that is not supported.
Preserve all factual values exactly, preserve only the supplied image asset IDs, and follow the workspace required fields and claim policy.`;
