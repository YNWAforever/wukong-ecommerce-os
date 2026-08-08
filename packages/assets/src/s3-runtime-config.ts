import type { S3ClientConfig } from "@aws-sdk/client-s3";

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

// Carries the variable name so a route can report which piece of configuration
// is absent. A bare Error here is indistinguishable from a genuine fault, which
// turned a missing deployment variable into an opaque 500.
export class RuntimeConfigurationError extends Error {
  constructor(
    readonly variable: string,
    message = `${variable} is required`,
  ) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

function required(env: RuntimeEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new RuntimeConfigurationError(name);
  return value;
}

export function readS3RuntimeConfig(env: RuntimeEnv): {
  bucket: string;
  client: S3ClientConfig;
} {
  const pathStyle = env.S3_FORCE_PATH_STYLE ?? "false";
  if (pathStyle !== "true" && pathStyle !== "false") {
    throw new RuntimeConfigurationError(
      "S3_FORCE_PATH_STYLE",
      "S3_FORCE_PATH_STYLE must be true or false",
    );
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
