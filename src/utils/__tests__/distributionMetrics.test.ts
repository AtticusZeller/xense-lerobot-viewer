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
});
