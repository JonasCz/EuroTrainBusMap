import { describe, expect, it } from "vitest";
import { ASSET_KEYS, ASSETS_SOURCE_HASH, ASSETS_VERSION, assetSourcesHash, assetsStamp, compareStamp } from "../src/assets-version.ts";

describe("assets version (R2 version.json against the code)", () => {
  it("the asset-defining sources are reviewed: bump ASSETS_VERSION when the assets change, then update ASSETS_SOURCE_HASH", () => {
    // A change to one of ASSET_SOURCES fails this test until ASSETS_SOURCE_HASH (src/assets-version.ts) is set to the
    // new hash (`pnpm --filter @etbm/etl exec node --import tsx src/assets-version.ts --hash`). If the change alters
    // what an asset contains, bump ASSETS_VERSION too: the next build-deploy then refreshes the assets in R2 first.
    expect(assetSourcesHash()).toBe(ASSETS_SOURCE_HASH);
  });

  it("the stamp holds the version, the coverage and the asset keys", () => {
    const s = assetsStamp();
    expect(s.assetsVersion).toBe(ASSETS_VERSION);
    expect(s.coverage).toBe("eu-ma");
    expect(s.keys).toEqual([...ASSET_KEYS].sort());
    expect(s.keys).toContain("rail/rail-graph-v1.bin");
  });

  it("a missing, older or other-coverage version.json is stale; the same stamp is current", () => {
    const s = assetsStamp();
    expect(compareStamp(s, { ...s, builtAt: "2026-10-19T00:00:00Z", parts: ["rail"] })).toEqual({ current: true, reasons: [] });
    expect(compareStamp(s, { ...s, keys: [...s.keys].reverse() }).current).toBe(true);
    expect(compareStamp(s, null)).toEqual({ current: false, reasons: ["no version.json in the bucket"] });
    expect(compareStamp(s, { ...s, assetsVersion: s.assetsVersion - 1 }).reasons).toEqual([`assets version ${s.assetsVersion - 1} in the bucket, ${s.assetsVersion} in the code`]);
    expect(compareStamp(s, { ...s, coverage: "eu" }).reasons[0]).toMatch(/^coverage eu .* in the bucket, eu-ma/);
    expect(compareStamp(s, { ...s, coverageBoxes: [[-25, 34, 45, 72]] }).current).toBe(false);
    const keys = s.keys.map((k) => (k === "rail/rail-graph-v1.bin" ? "rail/rail-graph-v0.bin" : k));
    expect(compareStamp(s, { ...s, keys }).reasons).toEqual(["asset keys differ (missing rail/rail-graph-v1.bin; retired rail/rail-graph-v0.bin)"]);
  });
});
