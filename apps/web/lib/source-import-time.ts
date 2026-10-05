export function sourceImportHasValidTime(
  source: { merchantAttestedExportAt: Date } | null,
): boolean {
  return (
    source !== null &&
    source.merchantAttestedExportAt instanceof Date &&
    Number.isFinite(source.merchantAttestedExportAt.getTime())
  );
}
