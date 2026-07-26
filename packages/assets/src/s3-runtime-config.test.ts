import { describe, expect, it } from "vitest";
import {
  readS3RuntimeConfig,
  RuntimeConfigurationError,
} from "./s3-runtime-config.js";

const valid = {
  S3_BUCKET: "wukong-opak-prod-assets",
  S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  S3_REGION: "auto",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
  S3_FORCE_PATH_STYLE: "false",
};

describe("readS3RuntimeConfig", () => {
  it("returns one explicit R2 client configuration", () => {
    expect(readS3RuntimeConfig(valid)).toEqual({
      bucket: "wukong-opak-prod-assets",
      client: {
        endpoint: "https://account.r2.cloudflarestorage.com",
        region: "auto",
        forcePathStyle: false,
        credentials: {
          accessKeyId: "access-key",
          secretAccessKey: "secret-key",
        },
      },
    });
  });

  it.each([
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ])("fails closed when %s is missing", (name) =>
    expect(() => readS3RuntimeConfig({ ...valid, [name]: "" })).toThrow(name),
  );

  it("rejects a non-boolean path-style value", () => {
    expect(() =>
      readS3RuntimeConfig({ ...valid, S3_FORCE_PATH_STYLE: "sometimes" }),
    ).toThrow("S3_FORCE_PATH_STYLE");
  });

  it.each([
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
  ])("names %s on a typed error a route can report", (name) => {
    const broken =
      name === "S3_FORCE_PATH_STYLE"
        ? { ...valid, S3_FORCE_PATH_STYLE: "sometimes" }
        : { ...valid, [name]: "" };
    try {
      readS3RuntimeConfig(broken);
      expect.unreachable("expected a runtime configuration error");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigurationError);
      expect((error as RuntimeConfigurationError).variable).toBe(name);
      expect((error as Error).name).toBe("RuntimeConfigurationError");
    }
  });

  it("never carries a configured value on the error", () => {
    try {
      readS3RuntimeConfig({ ...valid, S3_BUCKET: "" });
      expect.unreachable("expected a runtime configuration error");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-key");
      expect((error as Error).message).not.toContain("access-key");
    }
  });
});
