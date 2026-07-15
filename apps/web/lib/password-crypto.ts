import { hash, verify, type Algorithm, type Version } from "@node-rs/argon2";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

const ARGON2ID_OPTIONS = {
  algorithm: 2 as Algorithm,
  version: 1 as Version,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

function validatePassword(password: string): void {
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new RangeError("Password must be 12 to 128 characters long");
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return hash(password, ARGON2ID_OPTIONS);
}

export function verifyPassword(
  encodedHash: string,
  password: string,
): Promise<boolean> {
  return verify(encodedHash, password, ARGON2ID_OPTIONS);
}
