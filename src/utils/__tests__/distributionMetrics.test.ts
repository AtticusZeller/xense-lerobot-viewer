import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Matrix4RowMajor } from "@/types/calibration.types";
import { parseDistributionJson } from "../distributionData";
import {
  computeCircularYawSpanDeg,
  computeYawPolarHistogram,
  projectBasePointToPixel,
  recomputeFrameShares,
  recomputeObjectCoverage,
  recomputeSubtaskArmMetrics,
  yawGlyph,
} from "../distributionMetrics";

const FIXTURE_PATH = path.join(
  import.meta.dir,
  "fixtures",
  "distribution.example.json",
);

describe("distributionMetrics", () => {
  it("recomputes frame shares, object coverage, and subtask-arm metrics matching distribution.example.json exactly", () => {
    const dist = parseDistributionJson(fs.readFileSync(FIXTURE_PATH, "utf-8"));
    const allEps = new Set(dist.provenance.annotated_episodes);

    const { frameShares, annotatorCounts } = recomputeFrameShares(dist, allEps);
    expect(frameShares.total_frames).toBe(dist.frame_shares.total_frames);
    expect(annotatorCounts).toEqual(dist.provenance.annotator_counts);
    dist.frame_shares.subtasks.forEach((expected, i) => {
      expect(frameShares.subtasks[i].subtask).toBe(expected.subtask);
      expect(frameShares.subtasks[i].episodes).toBe(expected.episodes);
      expect(frameShares.subtasks[i].frames).toBe(expected.frames);
      expect(frameShares.subtasks[i].share).toBeCloseTo(expected.share, 12);
    });

    for (const obj of dist.objects) {
      const recomputed = recomputeObjectCoverage(
        obj,
        dist.coverage_config,
        allEps,
      );
      expect(recomputed.poses.length).toBe(obj.coverage.sample_count);
      expect(recomputed.ix_range).toEqual(obj.coverage.ix_range);
      expect(recomputed.iy_range).toEqual(obj.coverage.iy_range);
      if (obj.median_z_m === null) {
        expect(recomputed.median_z_m).toBeNull();
      } else {
        expect(recomputed.median_z_m!).toBeCloseTo(obj.median_z_m, 12);
      }
    }

    for (const subtask of dist.subtasks) {
      for (const armName of subtask.participating_arms) {
        const armData = subtask.arms[armName];
        const recomputed = recomputeSubtaskArmMetrics(
          armData.episodes,
          dist.coverage_config.xy_bin_m,
        );
        expect(recomputed.episode_count).toBe(armData.metrics.episode_count);
        expect(recomputed.start_coverage.occupied_xy_cells).toBe(
          armData.metrics.start_coverage.occupied_xy_cells,
        );
        expect(recomputed.start_coverage.yaw_span_deg).toBeCloseTo(
          armData.metrics.start_coverage.yaw_span_deg,
          12,
        );
        expect(recomputed.end_coverage.occupied_xy_cells).toBe(
          armData.metrics.end_coverage.occupied_xy_cells,
        );
        expect(recomputed.end_coverage.yaw_span_deg).toBeCloseTo(
          armData.metrics.end_coverage.yaw_span_deg,
          12,
        );
        expect(recomputed.trajectory_dispersion_cm!).toBeCloseTo(
          armData.metrics.trajectory_dispersion_cm!,
          12,
        );
      }
    }
  });

  it("handles circular yaw span wrap-around and single/empty subsets", () => {
    expect(computeCircularYawSpanDeg([])).toBe(0);
    expect(computeCircularYawSpanDeg([45])).toBe(0);
    expect(computeCircularYawSpanDeg([-170, 170])).toBeCloseTo(20, 10);
    expect(computeCircularYawSpanDeg([0, 120, 240])).toBeCloseTo(240, 10);

    const hist = computeYawPolarHistogram([5, 15, 355], 30);
    expect(hist).toHaveLength(12);
    expect(hist[0].count).toBe(2);
    expect(hist[11].count).toBe(1);
  });

  it("projects calibrated tool points through T_cam_base without reapplying tool_offset", () => {
    const tCamBase: Matrix4RowMajor = [
      [1, 0, 0, 0.05],
      [0, 0, -1, 0.48],
      [0, 1, 0, 1.0],
      [0, 0, 0, 1.0],
    ];
    const intrinsics = { fx: 600, fy: 600, cx: 320, cy: 240 };
    // Point already at p_tool_base = [0.15, 0.0, 0.28] -> X_cam = [0.20, 0.20, 1.00] -> (440, 360).
    const proj = projectBasePointToPixel(
      [0.15, 0.0, 0.28],
      tCamBase,
      intrinsics,
    );
    expect(proj).not.toBeNull();
    expect(proj!.u).toBeCloseTo(440, 10);
    expect(proj!.v).toBeCloseTo(360, 10);
    expect(proj!.depth).toBeCloseTo(1.0, 10);
  });

  it("recomputes object coverage per layer using yaw_period_deg, object poses, skipped filtering, and mixed fallback", () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
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
        bins: [],
      },
    };
    const dist = parseDistributionJson(JSON.stringify(raw));
    const allEps = new Set([0, 2]);

    const objSummary = recomputeObjectCoverage(
      dist.objects[0],
      dist.coverage_config,
      allEps,
      "object",
    );
    expect(objSummary.resolvedLayer).toBe("object");
    expect(objSummary.fallbackToTool).toBe(false);
    expect(objSummary.poses).toHaveLength(1);
    expect(objSummary.poses[0].x_m).toBeCloseTo(0.96, 10);
    expect(objSummary.skipped).toEqual([
      { episode_index: 2, reason: "mask touches layout box border" },
    ]);
    expect(objSummary.yaw_period_deg).toBe(180);
    expect(objSummary.num_yaw_bins).toBe(6);
    expect(objSummary.ix_range).toEqual([19, 19]);
    expect(objSummary.iy_range).toEqual([4, 4]);
    expect(objSummary.median_z_m!).toBeCloseTo(-0.4254, 10);

    // Filtering out episode 2 also filters the skipped list to the selection.
    const ep0Only = recomputeObjectCoverage(
      dist.objects[0],
      dist.coverage_config,
      new Set([0]),
      "object",
    );
    expect(ep0Only.poses).toHaveLength(1);
    expect(ep0Only.skipped).toEqual([]);

    // Switching to tool layer returns end-effector poses and 360-deg yaw bins.
    const toolSummary = recomputeObjectCoverage(
      dist.objects[0],
      dist.coverage_config,
      allEps,
      "tool",
    );
    expect(toolSummary.resolvedLayer).toBe("tool");
    expect(toolSummary.fallbackToTool).toBe(false);
    expect(toolSummary.poses).toHaveLength(2);
    expect(toolSummary.skipped).toEqual([]);
    expect(toolSummary.yaw_period_deg).toBe(360);
    expect(toolSummary.num_yaw_bins).toBe(12);
    expect(toolSummary.ix_range).toEqual([19, 20]);
    expect(toolSummary.iy_range).toEqual([1, 2]);

    // Object without object_layer falls back cleanly to tool layer.
    const fallbackSummary = recomputeObjectCoverage(
      dist.objects[1],
      dist.coverage_config,
      allEps,
      "object",
    );
    expect(fallbackSummary.resolvedLayer).toBe("tool");
    expect(fallbackSummary.fallbackToTool).toBe(true);
    expect(fallbackSummary.poses).toHaveLength(2);
    expect(fallbackSummary.yaw_period_deg).toBe(180);
  });

  it("draws a full-period yaw as one arrow and a shorter period as its headless equivalent directions", () => {
    const deg = (r: number) => (r * 180) / Math.PI;
    const full = yawGlyph(30, 360);
    expect(full.arrowhead).toBe(true);
    expect(full.anglesRad.map((r) => Math.round(deg(r)))).toEqual([30]);

    const axis = yawGlyph(30, 180);
    expect(axis.arrowhead).toBe(false);
    expect(axis.anglesRad.map(deg).map((d) => Math.round(d))).toEqual([
      30, 210,
    ]);

    const cross = yawGlyph(10, 90);
    expect(cross.arrowhead).toBe(false);
    expect(cross.anglesRad.map(deg).map((d) => Math.round(d))).toEqual([
      10, 100, 190, 280,
    ]);
  });
});
