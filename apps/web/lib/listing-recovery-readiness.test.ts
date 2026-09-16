import { it, expect } from "vitest";
import { requireListingRecovery } from "./listing-recovery-readiness";
it("returns safe setup error for missing recovery schema", async () => {
  await expect(
    requireListingRecovery({
      inspectListingRecoveryCompatibility: async () => ({ ready: false }),
    }),
  ).rejects.toMatchObject({
    status: 503,
    code: "listing_recovery_setup_required",
  });
});
it("redacts catalog failure", async () => {
  await expect(
    requireListingRecovery({
      inspectListingRecoveryCompatibility: async () => {
        throw new Error("secret SQL connection string");
      },
    }),
  ).rejects.toMatchObject({ code: "listing_recovery_setup_required" });
});
it("allows a ready production database and narrow test ports", async () => {
  await expect(
    requireListingRecovery({
      inspectListingRecoveryCompatibility: async () => ({ ready: true }),
    }),
  ).resolves.toBeUndefined();
  await expect(requireListingRecovery({})).resolves.toBeUndefined();
});
