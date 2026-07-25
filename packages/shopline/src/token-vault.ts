const CREDENTIAL_UNAVAILABLE = "SHOPLINE credential is unavailable";
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function unavailable(): Error {
  return new Error(CREDENTIAL_UNAVAILABLE);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeKey(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !BASE64_KEY.test(value)) {
    throw unavailable();
  }
  const decoded = base64ToBytes(value);
  if (decoded.byteLength !== 32 || bytesToBase64(decoded) !== value) {
    throw unavailable();
  }
  return decoded;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value)) throw unavailable();
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const decoded = base64ToBytes(padded);
  if (encodeBase64Url(decoded) !== value) throw unavailable();
  return decoded;
}

async function importKey(
  base64Key: string,
  usage: KeyUsage,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    decodeKey(base64Key),
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

export function assertShoplineEncryptionKey(base64Key: string): void {
  try {
    decodeKey(base64Key);
  } catch {
    throw unavailable();
  }
}

export async function encryptShoplineToken(
  token: string,
  base64Key: string,
): Promise<string> {
  try {
    if (typeof token !== "string" || token.length === 0) throw unavailable();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await importKey(base64Key, "encrypt");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(token),
    );
    return `v1.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(encrypted))}`;
  } catch {
    throw unavailable();
  }
}

export async function decryptShoplineToken(
  envelope: string,
  base64Key: string,
): Promise<string> {
  try {
    const parts = typeof envelope === "string" ? envelope.split(".") : [];
    if (parts.length !== 3 || parts[0] !== "v1") throw unavailable();
    const iv = decodeBase64Url(parts[1] ?? "");
    const ciphertext = decodeBase64Url(parts[2] ?? "");
    if (iv.byteLength !== 12 || ciphertext.byteLength <= 16) {
      throw unavailable();
    }
    const key = await importKey(base64Key, "decrypt");
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    const token = new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
    if (token.length === 0) throw unavailable();
    return token;
  } catch {
    throw unavailable();
  }
}
