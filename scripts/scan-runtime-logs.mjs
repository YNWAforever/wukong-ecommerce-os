#!/usr/bin/env node
/**
 * Readiness-gate log scanner (roadmap A5 follow-on).
 *
 * Scans runtime log text for credential, signed-URL, and prompt-marker forms
 * that the production readiness gate forbids. It reports pattern names and
 * line numbers only: it never echoes the matched value, so scanning a log with
 * a leaked secret cannot itself leak that secret into CI output or a ticket.
 *
 * Usage:
 *   node scripts/scan-runtime-logs.mjs <log-file> [...]
 *   vercel logs --environment production --json | node scripts/scan-runtime-logs.mjs -
 *   node scripts/scan-runtime-logs.mjs --help
 *
 * Exit codes: 0 clean, 1 findings or unreadable input, 2 usage error.
 *
 * This is a best-effort automated sample; the readiness gate still requires a
 * person to review deployment-specific logs.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Patterns mirror the production-readiness log-review checklist. */
export const LOG_SECRET_PATTERNS = Object.freeze([
  { name: "openai_style_key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: "bearer_token",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  },
  { name: "postgres_url", pattern: /postgres(?:ql)?:\/\/[^\s"']+/i },
  { name: "aws_signature", pattern: /X-Amz-Signature=/i },
  {
    name: "signed_query_param",
    pattern: /[?&](?:sig|signature|token|expires)=/i,
  },
  { name: "shopline_token", pattern: /shp(?:at|ca)_[A-Za-z0-9]{10,}/ },
  {
    name: "password_json_field",
    pattern: /"password"\s*:\s*"[^"]{1,}"/i,
  },
  {
    name: "api_key_json_field",
    pattern: /"api[_-]?key"\s*:\s*"[^"]{1,}"/i,
  },
  {
    name: "prompt_injection_marker",
    pattern: /(?:ignore (?:all|previous) instructions|system prompt)/i,
  },
]);

/**
 * Scan log text. Returns pattern names with line/column positions only (no
 * matched content), plus line/byte counts for the report.
 */
export function scanLogText(text, patterns = LOG_SECRET_PATTERNS) {
  const lines = text.split(/\r?\n/);
  const matches = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (const { name, pattern } of patterns) {
      const found = line.match(pattern);
      if (found && found.index !== undefined) {
        matches.push({
          pattern: name,
          line: lineIndex + 1,
          column: found.index + 1,
        });
      }
    }
  }
  return { lines: lines.length, matches };
}

/** Human/CI report: pattern counts and positions, never values. */
export function formatScanReport(result) {
  const counts = new Map();
  for (const match of result.matches)
    counts.set(match.pattern, (counts.get(match.pattern) ?? 0) + 1);
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pattern, count]) => `${pattern}=${count}`)
    .join(", ");
  return JSON.stringify({
    event: "readiness_log_scan",
    lines: result.lines,
    findings: result.matches.length,
    patterns: summary || "none",
    positions: result.matches.map(
      (match) => `${match.pattern}@${match.line}:${match.column}`,
    ),
    ok: result.matches.length === 0,
  });
}

function usage() {
  console.error(
    "Usage: node scripts/scan-runtime-logs.mjs <log-file> [...]\n" +
      "       <command> | node scripts/scan-runtime-logs.mjs -",
  );
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) return 0;
  const files = argv.filter((value) => value !== "-");
  const readStdin = argv.includes("-");
  if (!readStdin && files.length === 0) {
    usage();
    return 2;
  }
  let combined = "";
  try {
    for (const file of files) combined += readFileSync(file, "utf8") + "\n";
    if (readStdin) combined += readFileSync(0, "utf8");
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "readiness_log_scan",
        ok: false,
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return 1;
  }
  const result = scanLogText(combined);
  console.log(formatScanReport(result));
  return result.matches.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
