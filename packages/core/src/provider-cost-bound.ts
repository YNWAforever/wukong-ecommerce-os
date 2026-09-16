export function calculateConservativeRunCeiling(input: {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxPhysicalCalls: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}): string {
  const values = [
    input.maxInputTokens,
    input.maxOutputTokens,
    input.maxPhysicalCalls,
    input.inputUsdPerMillion,
    input.outputUsdPerMillion,
  ];
  if (values.some((value) => !Number.isFinite(value) || value <= 0))
    throw new TypeError("paid-run bounds must be positive finite values");
  if (
    ![
      input.maxInputTokens,
      input.maxOutputTokens,
      input.maxPhysicalCalls,
    ].every(Number.isInteger)
  )
    throw new TypeError("token and call bounds must be integers");
  const ceiling =
    (input.maxPhysicalCalls *
      (input.maxInputTokens * input.inputUsdPerMillion +
        input.maxOutputTokens * input.outputUsdPerMillion)) /
    1_000_000;
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 99_999_999)
    throw new TypeError("paid-run ceiling is outside the supported range");
  // PostgreSQL stores USD at six decimal places. Round toward a larger hold so
  // the persisted reservation can never fall below the calculated maximum.
  return (Math.ceil(ceiling * 1_000_000) / 1_000_000).toFixed(6);
}
