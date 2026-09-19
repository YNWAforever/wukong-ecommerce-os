import {
  validateWineGenerationRequest as validateRequest,
  type WineGenerationRequest,
} from "@wukong/core";
import { withWineProviderOutputError } from "./wine-artifact-validation-errors.js";
export { wineCandidateIssues, wineTextPaths } from "@wukong/core";
export function validateWineGenerationRequest(
  request: WineGenerationRequest,
): void {
  withWineProviderOutputError(() => validateRequest(request));
}
