import {
  ListingDataError,
  type PlatformProduct,
  type WorkspaceRepositories,
} from "@wukong/db";
import { hashBulkFormHeaderContract } from "@wukong/shopline";
import { sourceImportHasValidTime } from "./source-import-time";
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
  if (source && !sourceImportHasValidTime(source))
    throw new ListingDataError("invalid_source_time");
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

/** Advisory only: one owned snapshot, then the existing policy against in-memory
 * dependencies. Never use this snapshot as a mutation/export attestation. */
export async function loadSourceReadinessBatch(
  repositories: WorkspaceRepositories,
  workspaceId: string,
  listingIds: readonly string[],
  links: readonly PlatformProduct[] = [],
) {
  const bundle = await repositories.reads.sourceReadinessBatch(
    [...new Set(listingIds)],
    [
      ...new Set(
        links.flatMap((link) =>
          link.sourceImportId ? [link.sourceImportId] : [],
        ),
      ),
    ],
  );
  const records = new Map(bundle.listings.map((item) => [item.id, item]));
  const imports = new Map(bundle.imports.map((item) => [item.id, item]));
  const confirmations = new Map(
    bundle.listings.flatMap((item) =>
      [item.currentConfirmation, item.inheritedConfirmation].flatMap(
        (confirmation) =>
          confirmation ? [[confirmation.versionId, confirmation] as const] : [],
      ),
    ),
  );
  const receipts = new Map(
    bundle.listings.flatMap((item) =>
      item.receipt ? [[item.receipt.versionId, item.receipt] as const] : [],
    ),
  );
  const deps: ReadinessDeps = {
    async getReviewState(id) {
      const item = records.get(id);
      if (item?.error) throw item.error;
      return item?.state ?? null;
    },
    async getPlatformProductLink(id) {
      const item = records.get(id);
      if (item?.error) throw item.error;
      return item?.link ?? null;
    },
    getReviewConfirmation: async (id) => confirmations.get(id) ?? null,
    getApprovalReceipt: async (id) => receipts.get(id) ?? null,
    async getSourceRow(input) {
      return (
        bundle.listings.find(
          (item) =>
            item.sourceRow?.sourceImportId === input.sourceImportId &&
            item.sourceRow.connectionId === input.connectionId &&
            item.sourceRow.remoteProductId === input.remoteProductId,
        )?.sourceRow ?? null
      );
    },
    getSourceImport: async (id) => imports.get(id) ?? null,
    getSourceImportHeaderContractSha256: async (id) =>
      imports.get(id)?.headerContractSha256 ?? null,
    currentHeaderContractSha256: () => hashBulkFormHeaderContract(),
  };
  return {
    deps,
    read(listingId: string | null, link?: PlatformProduct | null) {
      return evaluateSourceReadiness(
        { workspaceId, listingId, ...(link === undefined ? {} : { link }) },
        deps,
      );
    },
  };
}

export async function readSourceReadinessBatch(
  repositories: WorkspaceRepositories,
  workspaceId: string,
  listingIds: readonly string[],
) {
  const reader = await loadSourceReadinessBatch(
    repositories,
    workspaceId,
    listingIds,
  );
  return new Map(
    await Promise.all(
      [...new Set(listingIds)].map(
        async (id) => [id, await reader.read(id)] as const,
      ),
    ),
  );
}
