export function listingProviderSecretNames(base, provider) {
  if (!["fake", "openai", "openrouter", "opencode-go"].includes(provider))
    throw new Error("AI_PROVIDER is invalid");
  if (provider === "opencode-go")
    return [
      ...base.filter(
        (name) => name !== "OPENAI_API_KEY" && name !== "OPENROUTER_API_KEY",
      ),
      "OPENCODE_GO_API_KEY",
    ];
  return provider === "openrouter"
    ? [
        ...base.filter((name) => name !== "OPENAI_API_KEY"),
        "OPENROUTER_API_KEY",
      ]
    : [...base];
}

// Keep in sync with the adapter's explicit, non-routing model policy.
export function validateOpenRouterListingModel(value) {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    /(?:^|[\/._-])(auto|free|latest|online|search)(?:$|[._-])/i.test(value) ||
    value.toLowerCase().startsWith("openrouter/")
  )
    throw new Error("OPENROUTER_LISTING_MODEL is invalid");
  return value;
}
export function productShotSecretNames(base, provider) {
  if (!["disabled", "fake", "photoroom"].includes(provider))
    throw new Error("PRODUCT_SHOT_PROVIDER is invalid");
  return provider === "photoroom" ? [...base, "PHOTOROOM_API_KEY"] : base;
}

export function validateOpenCodeGoListingModel(value) {
  if (value !== "deepseek-v4.1-flash")
    throw new Error("OPENCODE_GO_LISTING_MODEL is invalid");
  return value;
}
