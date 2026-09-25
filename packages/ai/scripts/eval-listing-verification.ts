import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  prepareVerification,
  type ListingVerifier,
} from "../src/listing-verification.js";
import { createTypeSafeListingVerifier } from "../src/typesafe-listing-verifier.js";
import { buildVerificationFixtures } from "../src/verification-eval-fixtures.js";
import {
  evaluateVerificationCases,
  validateEvaluationOptions,
} from "../src/verification-eval.js";

type Environment = { TYPESAFE_API_KEY?: string; TYPESAFE_MODEL?: string };
type Factory = (options: { apiKey: string; model: string }) => ListingVerifier;
function parseArgs(args: string[]) {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    // pnpm may forward its separator to tsx.
    if (key === "--" && i === 0) continue;
    if (
      ![
        "--dry-run",
        "--live",
        "--confirm-synthetic",
        "--max-requests",
        "--budget-usd",
        "--output",
      ].includes(key) ||
      flags.has(key)
    )
      throw new Error("Invalid evaluation arguments.");
    if (["--max-requests", "--budget-usd", "--output"].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error("Missing evaluation argument.");
      flags.set(key, value);
    } else flags.set(key, true);
  }
  if (flags.has("--live") && flags.has("--dry-run"))
    throw new Error("Choose live or dry-run.");
  return flags;
}
export async function runEvaluationCli(
  args: string[],
  env: Environment,
  factory: Factory = createTypeSafeListingVerifier,
) {
  const flags = parseArgs(args);
  const cases = buildVerificationFixtures();
  if (cases.some((c) => prepareVerification(c.input).reason !== null))
    throw new Error("Invalid synthetic fixture.");
  if (!flags.has("--live"))
    return {
      dryRun: true,
      cases: cases.length,
      holdout: cases.filter((c) => c.split === "holdout").length,
      requests: 0,
      fixtures: cases.map(({ id, split, category, labels }) => ({
        id,
        split,
        category,
        labels,
      })),
    };
  if (
    !flags.has("--confirm-synthetic") ||
    !flags.has("--max-requests") ||
    !flags.has("--budget-usd")
  )
    throw new Error(
      "Live evaluation requires synthetic confirmation and explicit request and budget caps.",
    );
  const options = {
    maxRequests: Number(flags.get("--max-requests")),
    budgetUsd: Number(flags.get("--budget-usd")),
  };
  validateEvaluationOptions(options);
  // No credential access or client construction occurs until argument validation succeeds.
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  const model = env.TYPESAFE_MODEL?.trim();
  if (!apiKey || !model || !/^jev-\d+\.\d+\.\d+$/.test(model))
    throw new Error(
      "Live evaluation requires a credential and a pinned Jev version.",
    );
  return evaluateVerificationCases(cases, factory({ apiKey, model }), options);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    const flags = parseArgs(args);
    const report = await runEvaluationCli(args, process.env);
    const json = JSON.stringify(report, null, 2);
    const output = flags.get("--output");
    if (typeof output === "string")
      await writeFile(output, `${json}\n`, { encoding: "utf8", flag: "wx" });
    else process.stdout.write(`${json}\n`);
  } catch {
    // Do not print environment values, filesystem errors, inputs, or provider exception text.
    process.stderr.write(
      "Evaluation failed. Check flags, explicit output path, credential presence, and pinned model.\n",
    );
    process.exitCode = 1;
  }
}
