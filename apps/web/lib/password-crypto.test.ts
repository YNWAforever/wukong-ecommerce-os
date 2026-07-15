import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password-crypto";

describe("password crypto", () => {
  it("hashes and verifies passwords without exposing plaintext", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(hash).not.toContain("correct horse");
    expect(hash).toContain("$argon2id$");
    expect(hash).toContain("$v=19$m=19456,t=2,p=1$");
    await expect(
      verifyPassword(hash, "correct horse battery staple"),
    ).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong password")).resolves.toBe(false);
  });

  it("accepts only passwords between 12 and 128 characters", async () => {
    await expect(hashPassword("a".repeat(11))).rejects.toThrow("12 to 128");
    await expect(hashPassword("a".repeat(129))).rejects.toThrow("12 to 128");
    await expect(hashPassword("a".repeat(12))).resolves.toContain("$argon2id$");
    await expect(hashPassword("a".repeat(128))).resolves.toContain(
      "$argon2id$",
    );
  });
});
