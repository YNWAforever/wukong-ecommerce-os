import type { PlatformProduct, WorkspaceRepositories } from "@wukong/db";
import { hashBulkFormHeaderContract } from "@wukong/shopline";
import {
  checkBulkUpdateEligibility,
  type BulkUpdateEligibilityDeps,
  type BulkUpdateLink,
} from "./bulk-update-eligibility";
type ReadinessDeps = BulkUpdateEligibilityDeps & {
  getSourceImport(id: string): Promise<{
    merchantAttestedExportAt: Date;
    headerContractSha256: string;
  } | null>;
};
export type SourceReadiness = Awaited<
  ReturnType<typeof evaluateSourceReadiness>
>;
export async function evaluateSourceReadiness(
  input: {
    workspaceId: string;
    listingId: string | null;
    link?: BulkUpdateLink | null;
  },
  deps: ReadinessDeps,
) {
  const link =
    input.link === undefined && input.listingId
      ? await deps.getPlatformProductLink(input.listingId)
      : (input.link ?? null);
  const state = input.listingId
    ? await deps.getReviewState(input.listingId)
    : null;
  const versionId = state?.activeVersionId ?? null;
  const source = link?.sourceImportId
    ? await deps.getSourceImport(link.sourceImportId)
    : null;
  const receipt = versionId ? await deps.getApprovalReceipt(versionId) : null;
  const currentConfirmation = versionId
    ? await deps.getReviewConfirmation(versionId)
    : null;
  const confirmation =
    currentConfirmation ??
    (receipt && receipt.confirmationVersionId !== versionId
      ? await deps.getReviewConfirmation(receipt.confirmationVersionId)
      : null);
  const headerContractCurrent =
    source !== null &&
    source.headerContractSha256 === deps.currentHeaderContractSha256();
  // Advisory hypothetical evaluation is explicit. It performs the complete shared
  // policy including header checks; no attestation or authorization is persisted.
  // There is no operator attestation to check here, so this asks the policy
  // question with the attestation set aside: `{ kind: "advisory" }` tells
  // `checkBulkUpdateEligibility` to compare against the digest carried by the
  // link *it* reads internally, rather than accepting a digest from this
  // caller. Supplying a digest here -- from `link`, this function's own read,
  // above -- used to be exactly what made the reported reason diverge: `link`
  // can differ from the row `checkBulkUpdateEligibility` resolves internally,
  // because `platform_products` has no unique index on `listing_id`, and a
  // digest mismatch between those two reads would surface as
  // `row_digest_mismatch` and short-circuit the identity check below that is
  // supposed to report `remote_link_changed` for exactly that divergence.
  const hypothetical =
    input.listingId && versionId
      ? await checkBulkUpdateEligibility(
          {
            workspaceId: input.workspaceId,
            listingId: input.listingId,
            versionId,
            attestation: { kind: "advisory" },
          },
          deps,
        )
      : {
          ok: false as const,
          reason: input.listingId
            ? ("version_mismatch" as const)
            : ("no_remote_link" as const),
        };
  const catalogLinkMatches =
    !hypothetical.ok ||
    (!!link &&
      link.remoteProductId === hypothetical.link.remoteProductId &&
      link.connectionId === hypothetical.link.connectionId &&
      link.sourceImportId === hypothetical.link.sourceImportId &&
      link.contentDigest === hypothetical.link.contentDigest &&
      link.origin === hypothetical.link.origin);
  const reason = !catalogLinkMatches
    ? ("remote_link_changed" as const)
    : link?.origin === "import" && !headerContractCurrent
      ? ("header_contract_stale" as const)
      : hypothetical.ok
        ? ("not_attested" as const)
        : hypothetical.reason;
  return {
    sourceImportId: link?.sourceImportId ?? null,
    merchantAttestedExportAt:
      source?.merchantAttestedExportAt.toISOString() ?? null,
    currentVersionId: versionId,
    reviewedBinding: confirmation
      ? {
          versionId: confirmation.versionId,
          sourceImportId: confirmation.sourceImportId,
          rowDigest: confirmation.rowDigest,
          revision: confirmation.revision,
        }
      : null,
    approvedBinding: receipt
      ? {
          versionId: receipt.versionId,
          sourceImportId: receipt.sourceImportId,
          rowDigest: receipt.sourceRowDigest,
          approvalReceiptId: receipt.id,
          confirmationVersionId: receipt.confirmationVersionId,
          confirmationRevision: receipt.confirmationRevision,
        }
      : null,
    headerContractCurrent,
    freshnessAttested: false as const,
    eligible: false as const,
    eligibleAfterAttestation:
      hypothetical.ok && headerContractCurrent && catalogLinkMatches,
    reason,
    downstreamVerification: "unverified" as const,
    scope: "advisory_current_read" as const,
  };
}
export function readSourceReadiness(
  repositories: WorkspaceRepositories,
  workspaceId: string,
  listingId: string | null,
  link?: PlatformProduct | null,
) {
  return evaluateSourceReadiness(
    { workspaceId, listingId, ...(link === undefined ? {} : { link }) },
    {
      async getReviewState(id) {
        const snapshot = await repositories.listings.getReviewSnapshot(id);
        if (!snapshot) return null;
        return {
          status: snapshot.listing.status,
          activeVersionId:
            snapshot.listing.activeVersionId === snapshot.activeVersion?.id
              ? snapshot.activeVersion.id
              : null,
          flags: snapshot.flags,
        };
      },
      getApprovalReceipt: (id) =>
        repositories.approvalReceipts.getByVersionId(id),
      getReviewConfirmation: (id) =>
        repositories.reviewConfirmations.getByVersionId(id),
      getPlatformProductLink: (id) =>
        repositories.platformProducts.getByListingId(id),
      getSourceRow: (input) => repositories.sourceRows.getForProduct(input),
      getSourceImport: (id) => repositories.sourceImports.getById(id),
      async getSourceImportHeaderContractSha256(id) {
        return (
          (await repositories.sourceImports.getById(id))
            ?.headerContractSha256 ?? null
        );
      },
      currentHeaderContractSha256: () => hashBulkFormHeaderContract(),
    },
  );
}
