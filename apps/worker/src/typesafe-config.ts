import {
  createTypeSafeListingVerifier,
  type ListingVerifier,
} from "@wukong/ai";
import { unavailableVerification } from "./listing-verification-support.js";
import type { WorkerEnv } from "./worker-env.js";
type VerificationEnv = Pick<
  WorkerEnv,
  "TYPESAFE_VERIFICATION_MODE" | "TYPESAFE_API_KEY" | "TYPESAFE_MODEL"
>;
export type VerifierFactory = (env: WorkerEnv) => ListingVerifier;

/** Gate before invoking any factory so credentials alone can never activate calls. */
export function createConfiguredVerifier(
  env: VerificationEnv,
  factory?: VerifierFactory,
): ListingVerifier | undefined {
  const mode = env.TYPESAFE_VERIFICATION_MODE ?? "off";
  if (mode === "off") return undefined;
  if (
    mode !== "advisory" ||
    !env.TYPESAFE_API_KEY?.trim() ||
    !env.TYPESAFE_MODEL?.trim()
  ) {
    return {
      async verify() {
        return unavailableVerification("configuration", false);
      },
    };
  }
  return factory
    ? factory(env as WorkerEnv)
    : createTypeSafeListingVerifier({
        apiKey: env.TYPESAFE_API_KEY,
        model: env.TYPESAFE_MODEL,
      });
}
