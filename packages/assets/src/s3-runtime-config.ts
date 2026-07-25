import type { S3ClientConfig } from "@aws-sdk/client-s3";

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function required(env: RuntimeEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readS3RuntimeConfig(env: RuntimeEnv): {
  bucket: string;
  client: S3ClientConfig;
} {
  const pathStyle = env.S3_FORCE_PATH_STYLE ?? "false";
  if (pathStyle !== "true" && pathStyle !== "false") {
    throw new Error("S3_FORCE_PATH_STYLE must be true or false");
  }
  return {
    bucket: required(env, "S3_BUCKET"),
    client: {
      endpoint: required(env, "S3_ENDPOINT"),
      region: env.S3_REGION?.trim() || "auto",
      forcePathStyle: pathStyle === "true",
      credentials: {
        accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
      },
    },
  };
}
