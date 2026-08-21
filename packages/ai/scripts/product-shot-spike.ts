import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.resolve(here, "../fixtures/product-shot-spike");
const OUTPUT_DIR = path.join(INPUT_DIR, "output");

type BoundingBox = { x: number; y: number; width: number; height: number };

async function detectProductBox(
  client: OpenAI,
  imageBase64: string,
): Promise<BoundingBox> {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Return ONLY JSON {"x":number,"y":number,"width":number,"height":number} — a bounding box around the bottle/product in this photo, as fractions of image width/height (0 to 1). No other text.',
          },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
          },
        ],
      },
    ],
  });
  const text = response.choices[0]?.message.content ?? "";
  return JSON.parse(text) as BoundingBox;
}

// Mask semantics for OpenAI's image edit endpoint: transparent (alpha 0)
// pixels are editable, opaque pixels are preserved from the original. We
// want the model to repaint everything EXCEPT the product, so the mask
// starts fully transparent and gets one opaque rectangle over the
// detected product region.
async function buildProtectiveMask(
  width: number,
  height: number,
  box: BoundingBox,
): Promise<Buffer> {
  const boxLeft = Math.round(box.x * width);
  const boxTop = Math.round(box.y * height);
  const boxWidth = Math.max(1, Math.round(box.width * width));
  const boxHeight = Math.max(1, Math.round(box.height * height));

  const opaqueRect = await sharp({
    create: {
      width: boxWidth,
      height: boxHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: opaqueRect, left: boxLeft, top: boxTop }])
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required to run the spike");
  const client = new OpenAI({ apiKey });

  await mkdir(OUTPUT_DIR, { recursive: true });
  const entries = await readdir(INPUT_DIR);
  const files = entries.filter((name) => /\.(jpe?g|png)$/i.test(name));
  if (files.length === 0) {
    throw new Error(
      `No photos found in ${INPUT_DIR} — drop real bottle photos there first (see README.md).`,
    );
  }

  for (const file of files) {
    const originalBuffer = await readFile(path.join(INPUT_DIR, file));
    const metadata = await sharp(originalBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height)
      throw new Error(`Could not read dimensions for ${file}`);

    const box = await detectProductBox(
      client,
      originalBuffer.toString("base64"),
    );
    const mask = await buildProtectiveMask(width, height, box);
    const pngInput = await sharp(originalBuffer).png().toBuffer();

    await writeFile(path.join(OUTPUT_DIR, `${file}.mask.png`), mask);

    const edit = await client.images.edit({
      model: "gpt-image-1",
      image: await OpenAI.toFile(pngInput, file, { type: "image/png" }),
      mask: await OpenAI.toFile(mask, "mask.png", { type: "image/png" }),
      prompt:
        "Replace the background with full transparency. Do not alter the product, its label, or any text on it.",
      background: "transparent",
      size: "auto",
    });

    const resultBase64 = edit.data?.[0]?.b64_json;
    if (!resultBase64) throw new Error(`No image data returned for ${file}`);
    await writeFile(
      path.join(OUTPUT_DIR, `${file}.cutout.png`),
      Buffer.from(resultBase64, "base64"),
    );

    console.log(
      JSON.stringify({
        event: "product_shot_spike_result",
        file,
        detectedBox: box,
      }),
    );
  }

  console.log(
    `\nDone. Compare each *.cutout.png against its original in ${OUTPUT_DIR}. ` +
      "Any visible change to label text/color/detail is a FAIL for the mask-based " +
      "approach — stop and report the finding before continuing.",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
