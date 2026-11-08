/**
 * Clipboard write used by Studio copy actions (B2).
 *
 * Returns a boolean instead of throwing: the UI must distinguish "copied" from
 * "the browser refused or has no clipboard API" so it never claims success it
 * did not observe. No fallback that silently drops the text is attempted.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator === "undefined" ||
      typeof navigator.clipboard?.writeText !== "function"
    ) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
