import { WineArtifactValidationError } from "@wukong/core";
import { ProviderOutputError } from "./listing-provider-errors.js";
/** Preserve the AI boundary's existing error class and default diagnostic. */
export function withWineProviderOutputError<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof WineArtifactValidationError)
      throw new ProviderOutputError(error.message);
    throw error;
  }
}
