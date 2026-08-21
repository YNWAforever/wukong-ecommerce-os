import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AssetInputError } from "./asset-store.js";
import { flattenProductShot } from "./product-shot-flatten.js";

async function makeTransparentPng(): Promise<Uint8Array> {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
}

async function makeOpaquePng(): Promise<Uint8Array> {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 255 },
    },
  })
    .png()
    .toBuffer();
}

describe("flattenProductShot", () => {
  it("composites a transparent PNG onto a solid white background", async () => {
    const cutout = await makeTransparentPng();

    const flattened = await flattenProductShot(cutout, "#ffffff");

    const pixel = await sharp(Buffer.from(flattened))
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Fully opaque white after flattening: R=255 G=255 B=255, and if an
    // alpha channel remains it must be fully opaque (255) -- flatten()
    // removes transparency, it does not just recolor it.
    expect(pixel.data[0]).toBe(255);
    expect(pixel.data[1]).toBe(255);
    expect(pixel.data[2]).toBe(255);
    if (pixel.info.channels === 4) {
      expect(pixel.data[3]).toBe(255);
    }
  });

  it("composites onto a brand color", async () => {
    const cutout = await makeTransparentPng();

    const flattened = await flattenProductShot(cutout, "#112233");

    const pixel = await sharp(Buffer.from(flattened))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(pixel.data[0]).toBe(0x11);
    expect(pixel.data[1]).toBe(0x22);
    expect(pixel.data[2]).toBe(0x33);
  });

  it("accepts mixed-case hex and matches the lowercase equivalent", async () => {
    const cutout = await makeTransparentPng();

    const lower = await flattenProductShot(cutout, "#aabbcc");
    const mixed = await flattenProductShot(cutout, "#AaBbCc");

    const lowerPixel = await sharp(Buffer.from(lower))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mixedPixel = await sharp(Buffer.from(mixed))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(mixedPixel.data[0]).toBe(lowerPixel.data[0]);
    expect(mixedPixel.data[1]).toBe(lowerPixel.data[1]);
    expect(mixedPixel.data[2]).toBe(lowerPixel.data[2]);
    expect(mixedPixel.data[0]).toBe(0xaa);
    expect(mixedPixel.data[1]).toBe(0xbb);
    expect(mixedPixel.data[2]).toBe(0xcc);
  });

  it("passes an already-opaque input through unaffected", async () => {
    const cutout = await makeOpaquePng();

    const flattened = await flattenProductShot(cutout, "#ffffff");

    const pixel = await sharp(Buffer.from(flattened))
      .raw()
      .toBuffer({ resolveWithObject: true });
    // No transparency to replace, so the pixel's own opaque color survives
    // flatten() untouched -- the background color never gets a chance to show.
    expect(pixel.data[0]).toBe(10);
    expect(pixel.data[1]).toBe(20);
    expect(pixel.data[2]).toBe(30);
  });

  it("rejects a malformed background color", async () => {
    const cutout = await makeTransparentPng();
    await expect(
      flattenProductShot(cutout, "not-a-color"),
    ).rejects.toThrow(/invalid background color/i);
    await expect(
      flattenProductShot(cutout, "not-a-color"),
    ).rejects.toBeInstanceOf(AssetInputError);
  });
});
