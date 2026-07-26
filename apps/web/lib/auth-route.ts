import { AuthConfigurationUnavailableError } from "../auth";

import { createRuntimeAuthFlow, type AuthFlow } from "./auth-flow";

function isConfigurationError(error: unknown): boolean {
  return (
    error instanceof AuthConfigurationUnavailableError ||
    (error instanceof Error &&
      error.name === "AuthConfigurationUnavailableError")
  );
}

export function authUnavailableResponse(): Response {
  return Response.json(
    { ok: false, message: "Authentication is not configured." },
    { status: 503 },
  );
}

// Building the runtime flow reads the auth environment, so it throws before a
// handler's own try block can see it. Bound directly, that surfaced as an
// unexplained 500 with nothing in the logs -- indistinguishable, from the
// caller's side, from a healthy deployment refusing an uninvited address.
export async function withRuntimeAuthFlow(
  handle: (flow: AuthFlow) => Promise<Response>,
  createFlow: () => AuthFlow = createRuntimeAuthFlow,
): Promise<Response> {
  let flow: AuthFlow;
  try {
    flow = createFlow();
  } catch (error) {
    if (!isConfigurationError(error)) throw error;
    console.error(
      JSON.stringify({
        event: "auth_flow",
        outcome: "failure",
        reason: "auth_not_configured",
      }),
    );
    return authUnavailableResponse();
  }
  return handle(flow);
}
