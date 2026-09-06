import { PRODUCT_SHOT_LIMITS } from "@wukong/core";
import sharp from "sharp";

export type ProductShotRender = {
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  lowResolution: boolean;
};

type DecodedImage = {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
};

function renderError(code: string, cause?: unknown): Error {
  return new Error(code, cause === undefined ? undefined : { cause });
}

async function decodeCutout(cutout: Uint8Array): Promise<DecodedImage> {
  try {
    const decoded = await sharp(Buffer.from(cutout), {
      limitInputPixels: PRODUCT_SHOT_LIMITS.inputPixels,
      failOn: "error",
    })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/pixel limit|input image exceeds/i.test(message)) {
      throw renderError("input_too_large", error);
    }
    throw renderError("invalid_image", error);
  }
}

function foregroundBounds(image: DecodedImage) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * image.channels + 3];
      if (alpha !== undefined && alpha > 0) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left || bottom < top) throw renderError("empty_alpha");
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function encodeCandidate(
  image: DecodedImage,
  bounds: ReturnType<typeof foregroundBounds>,
  canvas: number,
  quality: number,
): Promise<Buffer> {
  const longest = Math.max(bounds.width, bounds.height);
  const scale = Math.min(1, (canvas * PRODUCT_SHOT_LIMITS.inset) / longest);
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  const subject = await sharp(image.data, {
    raw: {
      width: image.width,
      height: image.height,
      channels: image.channels as 4,
    },
  })
    .extract(bounds)
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      {
        input: subject,
        left: Math.floor((canvas - width) / 2),
        top: Math.floor((canvas - height) / 2),
      },
    ])
    .jpeg({ quality, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

export async function renderProductShot(
  cutout: Uint8Array,
): Promise<ProductShotRender> {
  if (cutout.byteLength > PRODUCT_SHOT_LIMITS.inputBytes) {
    throw renderError("input_too_large");
  }
  const image = await decodeCutout(cutout);
  const bounds = foregroundBounds(image);
  const longest = Math.max(bounds.width, bounds.height);
  const initialCanvas = Math.min(
    PRODUCT_SHOT_LIMITS.canvas,
    Math.ceil(longest / PRODUCT_SHOT_LIMITS.inset),
  );

  let canvas = initialCanvas;
  while (true) {
    for (const quality of [90, 80, 70]) {
      const bytes = await encodeCandidate(image, bounds, canvas, quality);
      if (bytes.byteLength <= PRODUCT_SHOT_LIMITS.outputBytes) {
        return {
          bytes: new Uint8Array(bytes),
          mimeType: "image/jpeg",
          width: canvas,
          height: canvas,
          lowResolution: longest < 1280,
        };
      }
    }
    if (canvas <= 320) break;
    const nextCanvas = Math.max(320, Math.floor(canvas * 0.8));
    if (nextCanvas === canvas) break;
    canvas = nextCanvas;
  }
  throw renderError("output_too_large");
}
