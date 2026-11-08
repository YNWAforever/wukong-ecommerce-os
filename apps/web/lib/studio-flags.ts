/**
 * Server-only Conversation Studio feature flags.
 *
 * Every flag is fail-closed: the environment value must be exactly the string
 * `"true"` (no `"1"`, no `"yes"`, no whitespace) and, where the workspace row
 * carries a matching switch, that row must also be on. Anything malformed,
 * missing or read as a non-boolean is treated as disabled.
 *
 * Two boundaries sit behind this module and remain authoritative:
 *  - the `(app)` layout hides the nav item and `/studio` calls `notFound()`,
 *    but neither is the security boundary -- every Studio route re-checks the
 *    same flags server-side;
 *  - a missing `studio_workspace_settings` row means "disabled defaults", so a
 *    workspace that never opted in can never become enabled by deploying the
 *    shell alone.
 */

/**
 * The subset of a `studio_workspace_settings` row these parsers need.
 *
 * Deliberately structural instead of importing the `@wukong/db` type: this
 * module stays a pure function library so it can be unit-tested with plain
 * object literals, and the repository's returned settings are assignable
 * without a cast.
 */
export type StudioFlagSettings = {
  readonly enabled: boolean;
  readonly defaultHome: boolean;
  readonly ai: unknown | null;
} | null;

const ON = "true";

function flagOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] === ON;
}

/**
 * The deployment-wide half of `isStudioEnabled`, exposed separately so a
 * caller can skip a workspace settings read entirely while the feature is off
 * (the shipped state) and still use the one fail-closed env parser.
 */
export function isStudioFeatureFlagOn(env: NodeJS.ProcessEnv): boolean {
  return flagOn(env, "CONVERSATION_STUDIO_ENABLED");
}

/**
 * Studio exists for this workspace only when the deployment-wide flag is on
 * AND this workspace's settings row says `enabled`.
 *
 * The Settings tab, threads, outputs and connections all hang off this answer;
 * a reader with Studio disabled sees no nav item and gets a 404 on the direct
 * route (never a redirect loop).
 */
export function isStudioEnabled(
  env: NodeJS.ProcessEnv,
  settings: StudioFlagSettings,
): boolean {
  return isStudioFeatureFlagOn(env) && settings?.enabled === true;
}

/**
 * Live model suggestions need their own flag on top of a configured model
 * (the repository represents "not configured" as `ai: null`). A workspace can
 * be Studio-enabled and still have no live analysis.
 */
export function isStudioAiEnabled(
  env: NodeJS.ProcessEnv,
  settings: StudioFlagSettings,
): boolean {
  return (
    flagOn(env, "CONVERSATION_STUDIO_AI_ENABLED") &&
    settings !== null &&
    settings.ai !== null
  );
}

/**
 * Making `/studio` the post-sign-in home is a separate rollback switch: both
 * it and Studio itself (env flag + workspace row) must be on, and the
 * workspace must opt into the default home.
 */
export function isStudioDefaultHome(
  env: NodeJS.ProcessEnv,
  settings: StudioFlagSettings,
): boolean {
  return (
    flagOn(env, "CONVERSATION_STUDIO_DEFAULT_HOME") &&
    isStudioEnabled(env, settings) &&
    settings?.defaultHome === true
  );
}

/**
 * The hosted MCP server flag never stands alone: without Studio there is no
 * token or thread model for a caller to reach, so this is false whenever
 * Studio is disabled.
 */
export function isStudioMcpServerEnabled(
  env: NodeJS.ProcessEnv,
  settings: StudioFlagSettings,
): boolean {
  return (
    flagOn(env, "STUDIO_MCP_SERVER_ENABLED") && isStudioEnabled(env, settings)
  );
}
