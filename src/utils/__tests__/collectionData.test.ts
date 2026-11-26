import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { TargetPolygonFile } from "@/types/collection.types";
import planExample from "./fixtures/collection-plan.example.json";
import {
  appendPolygonVertex,
  deletePolygonVertex,
  findNearestVertexIndex,
  formatSuggestionsCsv,
  insertPolygonVertexAfter,
  markerCodeForItem,
  movePolygonVertex,
  parseCollectionPlan,
  parseSuggestionsJson,
  parseTargetPolygonJson,
  pointInPolygon,
  serializeTargetPolygon,
  SUGGESTIONS_CSV_COLUMNS,
} from "../collectionData";

const SUGGESTIONS_FIXTURE_PATH = path.join(
  import.meta.dir,
  "fixtures",
  "suggestions.example.json",
);

describe("collection plan v1", () => {
  it("reads the same portable example as the Python capture module", () => {
    const plan = parseCollectionPlan(JSON.stringify(planExample));
    expect(plan).toEqual(planExample);
    expect(plan.rounds[0].targets[0]).toMatchObject({
      arm: "left",
      outline_plane_z_m: -0.11,
      yaw_symmetry_deg: 180,
    });
    expect(plan.rounds[1].targets[0]).toMatchObject({
      object: "box_base",
      outline: null,
      reason: "No reliable pose proxy",
    });
  });

  it("rejects a manual target in a multi-object round and an out-of-frame outline", () => {
    const multi = structuredClone(planExample);
    multi.settings.objects_per_round = 2;
    multi.rounds[0].targets.push(multi.rounds[1].targets[0]);
    expect(() => parseCollectionPlan(JSON.stringify(multi))).toThrow(
      /unprojectable target/,
    );
    const offscreen = structuredClone(planExample);
    offscreen.rounds[0].targets[0].outline = [
      [0, 0],
      [640, 0],
      [0, 1],
    ];
    expect(() => parseCollectionPlan(JSON.stringify(offscreen))).toThrow(
      /outline bounds/,
    );
  });

  it("rejects a duplicate saved episode and invalid hashes or versions", () => {
    const progress = structuredClone(planExample);
    for (const round of progress.rounds)
      Object.assign(round, { status: "collected", episode_index: 100 });
    expect(() => parseCollectionPlan(JSON.stringify(progress))).toThrow(
      /collected episode index/,
    );
    expect(() =>
      parseCollectionPlan(
        JSON.stringify({ ...planExample, mask_bundle_sha256: "INVALID" }),
      ),
    ).toThrow(/hashes/);
    expect(() =>
      parseCollectionPlan(JSON.stringify({ ...planExample, version: 2 })),
    ).toThrow(/format or version/);
  });
});

describe("collectionData", () => {
  it("round-trips targets.json and rejects malformed or degenerate polygons", () => {
    const file: TargetPolygonFile = {
      version: 1,
      camera: "observation.images.head",
      image_size: [640, 480],
      polygon: [
        [180, 160],
        [460, 160],
        [480, 360],
        [160, 360],
      ],
    };

    const raw = serializeTargetPolygon(file);
    const parsed = parseTargetPolygonJson(raw);
    expect(parsed).toEqual(file);

    expect(() => parseTargetPolygonJson("{broken")).toThrow(
      /Malformed targets\.json/,
    );
    expect(() =>
      parseTargetPolygonJson(
        JSON.stringify({
          version: 1,
          camera: "observation.images.head",
          image_size: [640, 480],
          polygon: [
            [10, 10],
            [20, 20],
          ],
        }),
      ),
    ).toThrow(/at least 3/);
  });

  it("supports polygon vertex append, move, insert, delete, hit-test, and point-in-polygon", () => {
    const imgSize: [number, number] = [640, 480];
    let poly = appendPolygonVertex([], [100.24, 100.76], imgSize);
    poly = appendPolygonVertex(poly, [300, 100], imgSize);
    poly = appendPolygonVertex(poly, [700, 500], imgSize); // clamped to [639, 479]
    expect(poly).toEqual([
      [100.2, 100.8],
      [300, 100],
      [639, 479],
    ]);

    poly = movePolygonVertex(poly, 2, [300, 300], imgSize);
    expect(poly[2]).toEqual([300, 300]);

    poly = insertPolygonVertexAfter(poly, 2, [100, 300], imgSize);
    expect(poly).toHaveLength(4);
    expect(findNearestVertexIndex(poly, 103, 297, 10)).toBe(3);
    expect(findNearestVertexIndex(poly, 200, 200, 10)).toBe(-1);

    expect(pointInPolygon(200, 200, poly)).toBe(true);
    expect(pointInPolygon(50, 50, poly)).toBe(false);

    poly = deletePolygonVertex(poly, 3);
    expect(poly).toHaveLength(3);
  });

  it("parses suggestions.example.json and exports the exact 17-column CLI CSV schema", () => {
    const raw = fs.readFileSync(SUGGESTIONS_FIXTURE_PATH, "utf-8");
    const parsed = parseSuggestionsJson(raw);

    expect(parsed.version).toBe(1);
    expect(parsed.provenance.region_source).toBe("target_polygon");
    expect(parsed.objects).toHaveLength(2);
    expect(parsed.placements).toHaveLength(8);
    expect(parsed.test_points).toHaveLength(12);

    // Verify marker codes.
    expect(markerCodeForItem("placement", parsed.placements[0])).toBe("1");
    expect(markerCodeForItem("test_point", parsed.test_points[0])).toBe("D1");
    expect(markerCodeForItem("test_point", parsed.test_points[2])).toBe("E1");
    expect(markerCodeForItem("test_point", parsed.test_points[4])).toBe("X1");

    // Full CSV export
    const csv = formatSuggestionsCsv(parsed);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(SUGGESTIONS_CSV_COLUMNS.join(","));
    expect(lines[0]).toBe(
      "kind,object,arm,index,tier,x_m,y_m,z_m,yaw_deg,ix,iy,yaw_bin,cell_count,pixel_u,pixel_v,arrow_end_u,arrow_end_v",
    );
    expect(lines).toHaveLength(1 + 8 + 12);

    const firstDataCols = lines[1].split(",");
    expect(firstDataCols).toHaveLength(17);
    expect(firstDataCols[0]).toBe("placement");
    expect(firstDataCols[1]).toBe("block");
    expect(firstDataCols[2]).toBe("right");
    expect(firstDataCols[3]).toBe("1");
    expect(firstDataCols[4]).toBe("empty");
    expect(firstDataCols[5]).toBe("1.1685");
    expect(firstDataCols[13]).toBe("321.14");

    // Filtered CSV export (only tray placements)
    const filteredCsv = formatSuggestionsCsv(parsed, {
      objects: new Set(["tray"]),
      includePlacements: true,
      includeTestTiers: new Set(),
    });
    expect(filteredCsv.trimEnd().split("\n")).toHaveLength(1 + 4);
  });
});
