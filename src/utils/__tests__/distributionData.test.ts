import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  defaultObjectLayer,
  hasAnyObjectLayer,
  parseDistributionJson,
  parseEpisodeSelection,
  resolveEffectiveObjectLayer,
  selectObjectLayer,
} from "../distributionData";

const FIXTURE_PATH = path.join(
  import.meta.dir,
  "fixtures",
  "distribution.example.json",
);

describe("distributionData", () => {
  it("parses the synthetic lerobot-check distribution.example.json fixture", () => {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
    const parsed = parseDistributionJson(raw);

    expect(parsed.version).toBe(1);
    expect(parsed.provenance.repo_id).toBe("Synthetic/demo");
    expect(parsed.provenance.position_point).toBe("tool_point");
    expect(parsed.provenance.annotated_episodes).toEqual([0, 2]);
    expect(parsed.coverage_config).toEqual({
      xy_bin_m: 0.05,
      yaw_bin_deg: 30,
      sparse_threshold: 2,
    });
    expect(parsed.frame_shares.total_frames).toBe(110);
    expect(parsed.objects).toHaveLength(2);
    expect(parsed.subtasks).toHaveLength(2);
    expect(parsed.subtasks[1].participating_arms).toEqual(["right", "left"]);
  });

  it("rejects malformed JSON and unsupported schema versions", () => {
    expect(() => parseDistributionJson("{bad")).toThrow(
      /Malformed distribution\.json/,
    );
    expect(() => parseDistributionJson(JSON.stringify({ version: 2 }))).toThrow(
      /Unsupported distribution\.json version/,
    );
  });

  it("parses episode ranges and lists matching lerobot-check syntax", () => {
    expect(parseEpisodeSelection("")).toEqual({ episodes: null, error: null });
    expect(parseEpisodeSelection("   ")).toEqual({
      episodes: null,
      error: null,
    });
    expect(parseEpisodeSelection("40")).toEqual({
      episodes: [40],
      error: null,
    });
    expect(parseEpisodeSelection("0-3, 10, 6:9", 100)).toEqual({
      episodes: [0, 1, 2, 3, 6, 7, 8, 10],
      error: null,
    });
    expect(parseEpisodeSelection(":3 8:", 10)).toEqual({
      episodes: [0, 1, 2, 8, 9],
      error: null,
    });
    // Deduplicates overlapping ranges and sorts ascending.
    expect(parseEpisodeSelection("5-7, 6-8, 5")).toEqual({
      episodes: [5, 6, 7, 8],
      error: null,
    });
  });

  it("rejects invalid episode range expressions", () => {
    expect(parseEpisodeSelection("abc").error).not.toBeNull();
    expect(parseEpisodeSelection("-5").error).not.toBeNull();
    expect(parseEpisodeSelection("10-5").error).not.toBeNull();
    expect(parseEpisodeSelection("10:10").error).not.toBeNull();
    expect(parseEpisodeSelection("10:5").error).not.toBeNull();
    expect(parseEpisodeSelection("1-2-3").error).not.toBeNull();
    expect(parseEpisodeSelection("1:2:3").error).not.toBeNull();
    expect(parseEpisodeSelection("50", 20).error).not.toBeNull();
    expect(parseEpisodeSelection("0-20", 20).error).not.toBeNull();
    expect(parseEpisodeSelection("0:21", 20).error).not.toBeNull();
  });

  it("keeps the last subtask's null end and validates start_source", () => {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
    const parsed = parseDistributionJson(raw);
    const last = parsed.subtasks[parsed.subtasks.length - 1];
    for (const arm of last.participating_arms) {
      for (const ep of last.arms[arm].episodes) {
        expect(ep.end_frame).toBeNull();
        expect(ep.end_pose).toBeNull();
        expect(ep.start_source).toBe("start");
      }
    }
    expect(parsed.subtasks[0].arms.right.episodes[0].start_source).toBe(
      "grasp",
    );

    const bad = JSON.parse(raw);
    bad.subtasks[0].arms.right.episodes[0].start_source = "release";
    expect(() => parseDistributionJson(JSON.stringify(bad))).toThrow(
      /start_source/,
    );
    const negative = JSON.parse(raw);
    negative.subtasks[0].arms.right.episodes[0].end_frame = -1;
    expect(() => parseDistributionJson(JSON.stringify(negative))).toThrow(
      /end_frame/,
    );
  });

  it("keeps reading an end-effector skipped value that is not a list as empty, as before", () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
    raw.objects[0].skipped = {};
    raw.objects[1].skipped = "none";
    const parsed = parseDistributionJson(JSON.stringify(raw));
    expect(parsed.objects[0].skipped).toEqual([]);
    expect(parsed.objects[1].skipped).toEqual([]);
  });

  it("loads old files without object_layer and exposes only the tool layer", () => {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
    const parsed = parseDistributionJson(raw);

    expect(parsed.provenance.object_poses_sha256).toBeUndefined();
    expect(parsed.objects.every((o) => o.object_layer === undefined)).toBe(
      true,
    );
    expect(hasAnyObjectLayer(parsed.objects)).toBe(false);
    expect(defaultObjectLayer(parsed.objects)).toBe("tool");
    expect(resolveEffectiveObjectLayer(parsed.objects, null)).toBe("tool");
    expect(resolveEffectiveObjectLayer(parsed.objects, "object")).toBe("tool");

    const selectedTool = selectObjectLayer(parsed.objects[0], "tool");
    expect(selectedTool.resolvedLayer).toBe("tool");
    expect(selectedTool.fallbackToTool).toBe(false);
    expect(selectedTool.poses).toBe(parsed.objects[0].poses);
    expect(selectedTool.skipped).toBe(parsed.objects[0].skipped);
    expect(selectedTool.coverage).toBe(parsed.objects[0].coverage);
    expect(selectedTool.yawPeriodDeg).toBe(parsed.objects[0].yaw_symmetry_deg);
  });

  it("parses object_layer and object_poses_sha256, defaults to object layer, and handles mixed objects", () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
    raw.provenance.object_poses_sha256 = "a".repeat(64);
    raw.objects[0].yaw_symmetry_deg = 360.0;
    raw.objects[0].object_layer = {
      source: "head_mask",
      frame: 0,
      arm: "right",
      plane_z_m: -0.4254,
      yaw_period_deg: 180.0,
      poses: [
        {
          episode_index: 0,
          frame: 0,
          arm: "right",
          x_m: 0.96,
          y_m: 0.23,
          z_m: -0.4254,
          raw_yaw_deg: 114.7,
          folded_yaw_deg: 114.7,
          length_m: 0.075,
          width_m: 0.05,
        },
      ],
      skipped: [{ episode_index: 2, reason: "mask touches layout box border" }],
      coverage: {
        sample_count: 1,
        xy_bin_m: 0.05,
        yaw_bin_deg: 30.0,
        sparse_threshold: 2,
        num_yaw_bins: 6,
        ix_range: [19, 19],
        iy_range: [4, 4],
        bins: [
          {
            ix: 19,
            iy: 4,
            yaw_bin: 3,
            x_min_m: 0.95,
            x_max_m: 1.0,
            y_min_m: 0.2,
            y_max_m: 0.25,
            yaw_min_deg: 90.0,
            yaw_max_deg: 120.0,
            count: 1,
          },
        ],
      },
    };

    const parsed = parseDistributionJson(JSON.stringify(raw));
    expect(parsed.provenance.object_poses_sha256).toBe("a".repeat(64));
    expect(hasAnyObjectLayer(parsed.objects)).toBe(true);
    expect(defaultObjectLayer(parsed.objects)).toBe("object");
    expect(resolveEffectiveObjectLayer(parsed.objects, null)).toBe("object");
    expect(resolveEffectiveObjectLayer(parsed.objects, "tool")).toBe("tool");

    // Object with object_layer selects object_layer.* for "object" and existing fields for "tool".
    const withLayerObj = selectObjectLayer(parsed.objects[0], "object");
    expect(withLayerObj.resolvedLayer).toBe("object");
    expect(withLayerObj.fallbackToTool).toBe(false);
    expect(withLayerObj.poses).toEqual(parsed.objects[0].object_layer!.poses);
    expect(withLayerObj.skipped).toEqual([
      { episode_index: 2, reason: "mask touches layout box border" },
    ]);
    expect(withLayerObj.coverage).toBe(
      parsed.objects[0].object_layer!.coverage,
    );
    expect(withLayerObj.yawPeriodDeg).toBe(180);
    expect(withLayerObj.planeZM).toBeCloseTo(-0.4254, 10);
    expect(withLayerObj.source).toBe("head_mask");
    expect(withLayerObj.frame).toBe(0);

    const withLayerTool = selectObjectLayer(parsed.objects[0], "tool");
    expect(withLayerTool.resolvedLayer).toBe("tool");
    expect(withLayerTool.fallbackToTool).toBe(false);
    expect(withLayerTool.poses).toBe(parsed.objects[0].poses);
    expect(withLayerTool.coverage).toBe(parsed.objects[0].coverage);
    expect(withLayerTool.yawPeriodDeg).toBe(360);

    // Mixed file: second object lacks object_layer and falls back per object.
    expect(parsed.objects[1].object_layer).toBeUndefined();
    const fallbackObj = selectObjectLayer(parsed.objects[1], "object");
    expect(fallbackObj.resolvedLayer).toBe("tool");
    expect(fallbackObj.fallbackToTool).toBe(true);
    expect(fallbackObj.poses).toBe(parsed.objects[1].poses);
    expect(fallbackObj.yawPeriodDeg).toBe(parsed.objects[1].yaw_symmetry_deg);

    const fallbackTool = selectObjectLayer(parsed.objects[1], "tool");
    expect(fallbackTool.resolvedLayer).toBe("tool");
    expect(fallbackTool.fallbackToTool).toBe(false);
  });

  it("validates object_layer fields and provenance.object_poses_sha256", () => {
    const base = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));

    const badSha = structuredClone(base);
    badSha.provenance.object_poses_sha256 = 123;
    expect(() => parseDistributionJson(JSON.stringify(badSha))).toThrow(
      /object_poses_sha256/,
    );

    const badYawPeriod = structuredClone(base);
    badYawPeriod.objects[0].object_layer = {
      source: "head_mask",
      frame: 0,
      arm: "right",
      plane_z_m: -0.4,
      yaw_period_deg: 0,
      poses: [],
      skipped: [],
      coverage: base.objects[0].coverage,
    };
    expect(() => parseDistributionJson(JSON.stringify(badYawPeriod))).toThrow(
      /yaw_period_deg/,
    );

    const missingLength = structuredClone(base);
    missingLength.objects[0].object_layer = {
      source: "head_mask",
      frame: 0,
      arm: "right",
      plane_z_m: -0.4,
      yaw_period_deg: 180,
      poses: [
        {
          episode_index: 0,
          frame: 0,
          arm: "right",
          x_m: 0.9,
          y_m: 0.2,
          z_m: -0.4,
          raw_yaw_deg: 10,
          folded_yaw_deg: 10,
          width_m: 0.05,
        },
      ],
      skipped: [],
      coverage: base.objects[0].coverage,
    };
    expect(() => parseDistributionJson(JSON.stringify(missingLength))).toThrow(
      /length_m/,
    );
  });
});
