import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { baselineClaim, checkCurated, claimOf, readCurated, shippedClaim } from "../src/curated.ts";

async function stationFiles(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stations-"));
  await writeFile(
    join(dir, "active-pass.yaml"),
    [
      "name: Active Pass",
      "provider: chs",
      "sources:",
      "  - chs-active-pass",
      "chs_fit:",
      "  tier: bounded",
      "  days: 210",
      "  slack_bound_minutes: 35",
      "  provisional_slack_minutes: 40",
      "  evidence: fit-2026-10-22-8f85912-r1",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "malibu-rapids.yaml"),
    "provider: chs\nderived: { reference: chs-point-atkinson, high_water_lag_minutes: 25, low_water_lag_minutes: 35 }\nsources: [chs-malibu-rapids]\n",
  );
  await writeFile(
    join(dir, "great-bras-d-or.yaml"),
    "provider: chs\nsources: [chs-great-bras-dor]\n",
  );
  await writeFile(join(dir, "trial-island.yaml"), "provider: noaa\nsources: [noaa/PCT1391]\n");
  return dir;
}

describe("readCurated", () => {
  test("keys each CHS gate by its source id", async () => {
    const curated = await readCurated(await stationFiles());
    expect([...curated.keys()].sort()).toEqual([
      "chs-active-pass",
      "chs-great-bras-dor",
      "chs-malibu-rapids",
    ]);
    expect(curated.get("chs-active-pass")?.chs_fit?.tier).toBe("bounded");
  });

  test("names a station file it can't parse", async () => {
    const dir = await stationFiles();
    await writeFile(join(dir, "broken.yaml"), "provider: chs\nsources: [chs-broken\n");
    await expect(readCurated(dir)).rejects.toThrow(/broken\.yaml/);
  });
});

describe("checkCurated", () => {
  test("names no gate when every fitted gate has a CHS station file", async () => {
    const dir = await stationFiles();
    const curated = await readCurated(dir);
    expect(checkCurated(curated, ["chs-active-pass", "chs-great-bras-dor"], dir)).toEqual([]);
  });

  test("names each fitted gate with no station file, without throwing, while at most half have none", async () => {
    const dir = await stationFiles();
    const curated = await readCurated(dir);
    const gates = ["chs-active-pass", "chs-great-bras-dor", "chs-new", "chs-other"];
    expect(checkCurated(curated, gates, dir)).toEqual(["chs-new", "chs-other"]);
  });

  test("throws when more than half the fitted gates have no station file, naming the count and a few", async () => {
    const dir = await stationFiles();
    const curated = await readCurated(dir);
    expect(() => checkCurated(curated, ["chs-active-pass", "chs-new", "chs-other"], dir)).toThrow(
      `2 of 3 fitted gates have no station file in ${dir}, such as chs-new, chs-other`,
    );
    const renamed = ["chs-active-pass", ...Array.from({ length: 6 }, (_, k) => `ca-gate-${k + 1}`)];
    expect(() => checkCurated(curated, renamed, dir)).toThrow(
      `6 of 7 fitted gates have no station file in ${dir}, such as ca-gate-1, ca-gate-2, ca-gate-3`,
    );
  });

  test("throws when no station file is a CHS gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stations-"));
    await writeFile(join(dir, "trial-island.yaml"), "provider: noaa\nsources: [noaa/PCT1391]\n");
    const curated = await readCurated(dir);
    expect(() => checkCurated(curated, [], dir)).toThrow(`${dir} holds no CHS station file`);
    expect(() => checkCurated(curated, ["chs-active-pass"], dir)).toThrow(
      `${dir} holds no CHS station file`,
    );
  });
});

describe("curated claims", () => {
  test("reads a chs_fit as a claim", async () => {
    const curated = await readCurated(await stationFiles());
    expect(claimOf(curated.get("chs-active-pass")!.chs_fit!)).toEqual({
      tier: "bounded",
      days: 210,
      bound: 35,
      provisional: 40,
    });
  });

  test("holds a gate to its curated claim only when this history released its evidence", async () => {
    const curated = await readCurated(await stationFiles());
    const gate = curated.get("chs-active-pass");
    expect(baselineClaim(gate, new Set(["fit-2026-10-22-8f85912-r1"]))).toEqual({
      tier: "bounded",
      days: 210,
      bound: 35,
      provisional: 40,
    });
    expect(baselineClaim(gate, new Set(["fit-2026-10-22-0000000-r1"]))).toBeUndefined();
    expect(baselineClaim(curated.get("chs-great-bras-dor"), new Set())).toBeUndefined();
  });

  test("ships a gate with no chs_fit online", async () => {
    const curated = await readCurated(await stationFiles());
    expect(shippedClaim(curated.get("chs-great-bras-dor"))).toEqual({ tier: "online" });
    expect(shippedClaim(undefined)).toEqual({ tier: "online" });
  });
});
