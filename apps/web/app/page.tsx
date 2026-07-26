import { redirect } from "next/navigation";

// The site root needs a route even though it renders nothing of its own.
// Middleware only rewrites "/" for signed-out visitors -- it sends them to
// /signin?callbackUrl=/ and lets anyone holding a session through. That
// callbackUrl is carried into the magic link email and used as the
// post-verification redirect, so the first visitor to ever complete sign-in
// was returned to "/" with a session and fell through to a 404.
//
// Authorization is unchanged: a signed-out visitor is still stopped by
// middleware before reaching this file, and /dashboard resolves its own data
// through the workspace-scoped API.
export default function RootPage() {
  redirect("/dashboard");
}
