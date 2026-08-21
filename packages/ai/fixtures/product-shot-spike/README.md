# Product shot spike fixtures

Drop 3–5 real Opak Cellar wine label photos in this folder (`.jpg`/`.jpeg`/`.png`)
before running:

    pnpm --filter @wukong/ai spike:product-shot

Requires `OPENAI_API_KEY` in your shell environment.

Output goes to `output/` (gitignored): for each photo, a `<name>.mask.png`
(the protective mask sent to OpenAI) and a `<name>.cutout.png` (the result).
Open each cutout next to its original and check, by eye, that every
character of label text is pixel-for-pixel identical to the source. Any
blur, redraw, or color shift on the label is a FAIL for this approach —
stop and report back before building anything on top of it.

Do not commit real product photos to this repo. This folder (other than
this README) is gitignored.
