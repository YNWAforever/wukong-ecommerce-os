export const runtime = "nodejs";

function unavailable(): Response {
  return Response.json(
    { code: "authentication_unavailable", message: "Authentication is not configured." },
    { status: 503 },
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthConfigured()) return unavailable();
  try {
    const { handlers } = await import("../../../../auth");
    return await handlers.GET(request as never);
  } catch (error) {
    if (error instanceof Error && error.name === "AuthConfigurationUnavailableError") return unavailable();
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthConfigured()) return unavailable();
  try {
    const { handlers } = await import("../../../../auth");
    return await handlers.POST(request as never);
  } catch (error) {
    if (error instanceof Error && error.name === "AuthConfigurationUnavailableError") return unavailable();
    throw error;
  }
}


function isAuthConfigured(): boolean {
  return Boolean(
    process.env.AUTH_SMTP_URL &&
      process.env.AUTH_EMAIL_FROM &&
      process.env.AUTH_SECRET &&
      process.env.DATABASE_URL,
  );
}
