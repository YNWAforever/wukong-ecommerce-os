import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  renderProductShot,
  validateProductShotSource,
} from "./product-shot-render.js";

async function makeCutout(
  options: {
    width?: number;
    height?: number;
    subjectWidth?: number;
    subjectHeight?: number;
    left?: number;
    top?: number;
  } = {},
): Promise<Buffer> {
  const width = options.width ?? 200;
  const height = options.height ?? 200;
  const subjectWidth = options.subjectWidth ?? 40;
  const subjectHeight = options.subjectHeight ?? 100;
  return sharp({
    create: { width, height, channels: 4, background: "#00000000" },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: subjectWidth,
            height: subjectHeight,
            channels: 4,
            background: "#ff0000ff",
          },
        })
          .png()
          .toBuffer(),
        left: options.left ?? 15,
        top: options.top ?? 50,
      },
    ])
    .png()
    .toBuffer();
}

async function decode(bytes: Uint8Array) {
  return sharp(Buffer.from(bytes)).raw().toBuffer({ resolveWithObject: true });
}

function rgbAt(
  decoded: Awaited<ReturnType<typeof decode>>,
  x: number,
  y: number,
) {
  const offset = (y * decoded.info.width + x) * decoded.info.channels;
  return Array.from(decoded.data.subarray(offset, offset + 3));
}

describe("renderProductShot", () => {
  it("renders the actual subject centered on a square white JPEG", async () => {
    const output = await renderProductShot(await makeCutout());
    const metadata = await sharp(Buffer.from(output.bytes)).metadata();
    const decoded = await decode(output.bytes);

    expect(output).toMatchObject({
      mimeType: "image/jpeg",
      width: 125,
      height: 125,
      lowResolution: true,
    });
    expect(metadata).toMatchObject({ format: "jpeg", width: 125, height: 125 });
    expect(output.bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    for (const [x, y] of [
      [0, 0],
      [124, 0],
      [0, 124],
      [124, 124],
    ]) {
      expect(rgbAt(decoded, x, y).every((channel) => channel >= 248)).toBe(
        true,
      );
    }
    const center = rgbAt(decoded, 62, 62);
    expect(center[0]).toBeGreaterThan(220);
    expect(center[1]).toBeLessThan(35);
    expect(center[2]).toBeLessThan(35);
  });

  it("crops an offset subject and preserves its aspect ratio", async () => {
    const output = await renderProductShot(
      await makeCutout({ width: 300, height: 220, left: 237, top: 11 }),
    );
    const decoded = await decode(output.bytes);
    let minX = decoded.info.width;
    let maxX = -1;
    let minY = decoded.info.height;
    let maxY = -1;
    for (let y = 0; y < decoded.info.height; y += 1) {
      for (let x = 0; x < decoded.info.width; x += 1) {
        const [r = 0, g = 255, b = 255] = rgbAt(decoded, x, y);
        if (r > 180 && g < 100 && b < 100) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    const renderedWidth = maxX - minX + 1;
    const renderedHeight = maxY - minY + 1;
    expect(renderedHeight / renderedWidth).toBeCloseTo(2.5, 1);
    expect(
      Math.abs((minX + maxX) / 2 - (output.width - 1) / 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((minY + maxY) / 2 - (output.height - 1) / 2),
    ).toBeLessThanOrEqual(1);
  });

  it("never enlarges a small subject", async () => {
    const output = await renderProductShot(await makeCutout());
    const decoded = await decode(output.bytes);
    let redPixelsOnCenterRow = 0;
    for (let x = 0; x < output.width; x += 1) {
      const [r = 0, g = 255, b = 255] = rgbAt(decoded, x, 62);
      if (r > 180 && g < 100 && b < 100) redPixelsOnCenterRow += 1;
    }
    expect(redPixelsOnCenterRow).toBeGreaterThanOrEqual(38);
    expect(redPixelsOnCenterRow).toBeLessThanOrEqual(42);
  });

  it("rejects a fully transparent input", async () => {
    const input = await sharp({
      create: { width: 20, height: 20, channels: 4, background: "#00000000" },
    })
      .png()
      .toBuffer();
    await expect(renderProductShot(input)).rejects.toThrow("empty_alpha");
  });

  it("rejects corrupt image bytes", async () => {
    await expect(renderProductShot(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "invalid_image",
    );
  });

  it("rejects inputs over the encoded byte limit before decoding", async () => {
    await expect(
      renderProductShot(new Uint8Array(10 * 1024 * 1024 + 1)),
    ).rejects.toThrow("input_too_large");
  });

  it("rejects images over the decoded pixel limit", async () => {
    const input = await sharp({
      create: {
        width: 6401,
        height: 6250,
        channels: 4,
        background: "#ff0000ff",
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(renderProductShot(input)).rejects.toThrow("input_too_large");
  });
});

it("validates and fully decodes selected originals before provider dispatch", async () => {
  await expect(
    validateProductShotSource(await makeCutout(), "image/png"),
  ).resolves.toEqual({ width: 200, height: 200 });
  await expect(
    validateProductShotSource(new Uint8Array([1, 2]), "image/png"),
  ).rejects.toThrow("invalid_image");
  await expect(
    validateProductShotSource(await makeCutout(), "image/jpeg"),
  ).rejects.toThrow("invalid_image");
  await expect(
    validateProductShotSource(
      new Uint8Array(10 * 1024 * 1024 + 1),
      "image/png",
    ),
  ).rejects.toThrow("input_too_large");
});
