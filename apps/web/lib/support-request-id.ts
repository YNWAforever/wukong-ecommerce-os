export function supportRequestId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    ? value
    : undefined;
}

export type SafeResponseError = Error & { code?: string; requestId?: string };
export async function safeResponseError(
  response: Response,
): Promise<SafeResponseError> {
  const error: SafeResponseError = new Error(
    `Request failed (${response.status})`,
  );
  error.requestId = supportRequestId(response.headers.get("x-request-id"));
  try {
    const body = (await response.json()) as {
      code?: unknown;
      requestId?: unknown;
    };
    if (typeof body?.code === "string") error.code = body.code;
    error.requestId = supportRequestId(body?.requestId) ?? error.requestId;
  } catch {
    /* HTML/partial responses still retain a safe header ID. */
  }
  return error;
}
