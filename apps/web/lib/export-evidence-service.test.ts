import { describe, it, expect, vi } from "vitest";
import { packetFixture } from "./export-evidence-fixtures";
import { createExportEvidenceService } from "./export-evidence-service";
function setup() {
  const f = packetFixture(),
    write = vi.fn(async () => undefined),
    getSnapshot = vi.fn(async () => f.snapshot),
    readObject = vi.fn(async () => f.bytes);
  const forWorkspace = vi.fn(async (_w: string, fn: any) =>
    fn({ exportEvidence: { getSnapshot }, audit: { write } }),
  );
  return {
    ...f,
    write,
    getSnapshot,
    readObject,
    forWorkspace,
    service: createExportEvidenceService({
      getDatabase: () => ({ forWorkspace }) as any,
      getAssetStore: () => ({ readObject }),
    }),
  };
}
describe("evidence packet service", () => {
  it("previews without audit and downloads exact preview contents with one content-free audit", async () => {
    const f = setup();
    const preview = await f.service.preview(f.input);
    expect(preview).toMatchObject({
      exportAttemptId: f.input.exportAttemptId,
      comparisonId: f.input.comparisonId,
      receiptRevisionCount: 2,
      unreportedMemberCount: 1,
    });
    expect(f.write).not.toHaveBeenCalled();
    const result = await f.service.download({
      ...f.input,
      actorId: "actor",
      expectedSnapshotSha256: preview.snapshotSha256,
    });
    expect(JSON.parse(result.json).payload.comparison.id).toBe(
      f.input.comparisonId,
    );
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.write.mock.calls)).not.toContain("corrected");
    expect(f.getSnapshot).toHaveBeenLastCalledWith(
      f.input.exportAttemptId,
      f.input.comparisonId,
    );
  });
  it("rejects changes since preview before audit", async () => {
    const f = setup();
    const preview = await f.service.preview(f.input);
    f.snapshot.receipts[1]!.correctionReason = "changed";
    await expect(
      f.service.download({
        ...f.input,
        actorId: "actor",
        expectedSnapshotSha256: preview.snapshotSha256,
      }),
    ).rejects.toMatchObject({ status: 409, code: "evidence_snapshot_changed" });
    expect(f.write).not.toHaveBeenCalled();
  });
  it("allows a new asOf alone", async () => {
    const f = setup();
    const p = await f.service.preview(f.input);
    f.snapshot.asOf = new Date("2026-09-05T06:00:00Z");
    await expect(
      f.service.download({
        ...f.input,
        actorId: "actor",
        expectedSnapshotSha256: p.snapshotSha256,
      }),
    ).resolves.toHaveProperty("json");
  });
  it.each(["missing", "corrupt", "audit"])(
    "fails closed on %s without exposing internals",
    async (kind) => {
      const f = setup();
      const p = await f.service.preview(f.input);
      if (kind === "missing")
        f.readObject.mockRejectedValue(new Error("SECRET"));
      if (kind === "corrupt")
        f.readObject.mockResolvedValue(new Uint8Array([1]));
      if (kind === "audit") f.write.mockRejectedValue(new Error("SECRET"));
      await expect(
        f.service.download({
          ...f.input,
          actorId: "actor",
          expectedSnapshotSha256: p.snapshotSha256,
        }),
      ).rejects.toMatchObject({
        code:
          kind === "missing"
            ? "export_artifact_unavailable"
            : kind === "corrupt"
              ? "export_artifact_hash_mismatch"
              : "evidence_packet_unavailable",
      });
      if (kind !== "audit") expect(f.write).not.toHaveBeenCalled();
    },
  );
  it("rejects retained expected rows that contradict hashed artifact", async () => {
    const f = setup();
    f.snapshot.comparison.comparison.products[0]!.expectedRow.rowNumber = 4;
    f.snapshot.comparison.comparison.products[1]!.expectedRow.rowNumber = 3;
    await expect(f.service.preview(f.input)).rejects.toMatchObject({
      code: "evidence_binding_invalid",
    });
    expect(f.write).not.toHaveBeenCalled();
  });
});
