import sharp from "sharp";

import { AssetInputError } from "./asset-store.js";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export async function flattenProductShot(
  cutoutPng: Uint8Array,
  backgroundColor: string,
): Promise<Uint8Array> {
  if (!HEX_COLOR.test(backgroundColor)) {
    throw new AssetInputError(`invalid background color: ${backgroundColor}`);
  }
  const flattened = await sharp(cutoutPng)
    .flatten({ background: backgroundColor })
    .png()
    .toBuffer();
  return new Uint8Array(flattened);
}
