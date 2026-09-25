export function readTypeSafeRuntimeConfig(env) {
  const mode = env.TYPESAFE_VERIFICATION_MODE ?? "off";
  if (mode !== "off" && mode !== "advisory")
    throw new Error("invalid TYPESAFE_VERIFICATION_MODE");
  if (mode === "off")
    return { mode, vars: { TYPESAFE_VERIFICATION_MODE: "off" } };
  const model = env.TYPESAFE_MODEL?.trim();
  if (!model || !/^jev-[A-Za-z0-9._-]{1,80}$/.test(model))
    throw new Error("TYPESAFE_MODEL is required");
  return {
    mode,
    vars: { TYPESAFE_VERIFICATION_MODE: mode, TYPESAFE_MODEL: model },
  };
}
export function typeSafeSecretPolicy(base, mode) {
  return {
    required: [
      ...new Set([
        ...base,
        ...(mode === "advisory" ? ["TYPESAFE_API_KEY"] : []),
      ]),
    ],
    optional: mode === "off" ? ["TYPESAFE_API_KEY"] : [],
  };
}
