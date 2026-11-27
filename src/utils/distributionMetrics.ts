import type {
  CalibrationIntrinsics,
  Matrix4RowMajor,
} from "@/types/calibration.types";
import type {
  DistributionAnnotatorCounts,
  DistributionCoverageConfig,
  DistributionFile,
  DistributionFrameShares,
  DistributionObjectEntry,
  DistributionObjectLayerKind,
  DistributionObjectPoseBase,
  DistributionObjectSkipped,
  DistributionSubtaskArmEpisode,
  DistributionSubtaskArmMetrics,
} from "@/types/distribution.types";
import { selectObjectLayer } from "@/utils/distributionData";

export interface RecomputedXyCell {
  ix: number;
  iy: number;
  x_min_m: number;
  x_max_m: number;
  y_min_m: number;
  y_max_m: number;
  count: number;
}

export interface RecomputedObjectSummary {
  resolvedLayer: DistributionObjectLayerKind;
  fallbackToTool: boolean;
  poses: DistributionObjectPoseBase[];
  skipped: DistributionObjectSkipped[];
  median_z_m: number | null;
  yaw_period_deg: number;
  xy_bin_m: number;
  yaw_bin_deg: number;
  sparse_threshold: number;
  num_yaw_bins: number;
  ix_range: [number, number] | null;
  iy_range: [number, number] | null;
  xyCells: RecomputedXyCell[];
  maxCellCount: number;
}

export interface PolarYawBin {
  binIndex: number;
  startDeg: number;
  endDeg: number;
  count: number;
}

export interface ProjectedBasePoint {
  u: number;
  v: number;
  depth: number;
}

export function wrapAngle360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function computeMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Exact formula from `docs/distribution.md`:
 * Distinct `(floor(x_m / xy_bin_m), floor(y_m / xy_bin_m))` pairs.
 */
export function computeOccupiedXyCells(
  poses: readonly { x_m: number; y_m: number }[],
  xyBinM: number,
): number {
  if (poses.length === 0 || xyBinM <= 0) return 0;
  const cells = new Set<string>();
  for (const pose of poses) {
    cells.add(
      `${Math.floor(pose.x_m / xyBinM)},${Math.floor(pose.y_m / xyBinM)}`,
    );
  }
  return cells.size;
}

/**
 * Exact circular span on S^1 from `docs/distribution.md`:
 * `0.0` if M <= 1; else `max(0.0, 360.0 - max(consecutive_gaps))`.
 */
export function computeCircularYawSpanDeg(yawsDeg: readonly number[]): number {
  const m = yawsDeg.length;
  if (m <= 1) return 0;
  const sorted = yawsDeg.map(wrapAngle360).sort((a, b) => a - b);
  let maxGap = sorted[0] + 360 - sorted[m - 1];
  for (let i = 0; i < m - 1; i += 1) {
    const gap = sorted[i + 1] - sorted[i];
    if (gap > maxGap) maxGap = gap;
  }
  return Math.max(0, 360 - maxGap);
}

/**
 * Exact trajectory dispersion in cm from `docs/distribution.md`:
 * `null` if M == 0; `0.0` if M == 1; else `(100 / K) * sum_k sqrt(mean_e ||P_{e,k} - mean_k||^2)` (`ddof=0`).
 */
export function computeTrajectoryDispersionCm(
  episodes: readonly DistributionSubtaskArmEpisode[],
): number | null {
  const m = episodes.length;
  if (m === 0) return null;
  if (m === 1) return 0;
  const kCount = episodes[0].trajectory.length;
  if (kCount === 0) return null;

  let sigmaSum = 0;
  for (let k = 0; k < kCount; k += 1) {
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let e = 0; e < m; e += 1) {
      const pt = episodes[e].trajectory[k];
      mx += pt.x_m;
      my += pt.y_m;
      mz += pt.z_m;
    }
    mx /= m;
    my /= m;
    mz /= m;

    let sqSum = 0;
    for (let e = 0; e < m; e += 1) {
      const pt = episodes[e].trajectory[k];
      const dx = pt.x_m - mx;
      const dy = pt.y_m - my;
      const dz = pt.z_m - mz;
      sqSum += dx * dx + dy * dy + dz * dz;
    }
    sigmaSum += Math.sqrt(sqSum / m);
  }

  return (100 / kCount) * sigmaSum;
}

/**
 * Recompute subtask-arm metrics strictly from stored per-episode `start_pose`,
 * `end_pose`, and `trajectory` arrays.
 */
export function recomputeSubtaskArmMetrics(
  episodes: readonly DistributionSubtaskArmEpisode[],
  xyBinM: number,
): DistributionSubtaskArmMetrics {
  const startPoses = episodes.map((ep) => ep.start_pose);
  const endPoses = episodes.flatMap((ep) => (ep.end_pose ? [ep.end_pose] : []));

  return {
    episode_count: episodes.length,
    start_coverage: {
      occupied_xy_cells: computeOccupiedXyCells(startPoses, xyBinM),
      yaw_span_deg: computeCircularYawSpanDeg(
        startPoses.map((pose) => pose.yaw_deg),
      ),
    },
    end_coverage: {
      occupied_xy_cells: computeOccupiedXyCells(endPoses, xyBinM),
      yaw_span_deg: computeCircularYawSpanDeg(
        endPoses.map((pose) => pose.yaw_deg),
      ),
    },
    trajectory_dispersion_cm: computeTrajectoryDispersionCm(episodes),
  };
}

export function recomputeFrameShares(
  distribution: DistributionFile,
  selectedEpisodes: ReadonlySet<number> | null,
): {
  frameShares: DistributionFrameShares;
  annotatorCounts: DistributionAnnotatorCounts;
  matchedEpisodes: number[];
} {
  const orderedSubtasks =
    distribution.frame_shares.subtasks.length > 0
      ? distribution.frame_shares.subtasks.map((s) => s.subtask)
      : distribution.subtasks.map((s) => s.name);

  const framesBySubtask = new Map<string, number>();
  const episodesBySubtask = new Map<string, Set<number>>();
  for (const name of orderedSubtasks) {
    framesBySubtask.set(name, 0);
    episodesBySubtask.set(name, new Set());
  }

  const annotatorCounts: DistributionAnnotatorCounts = {
    agent: 0,
    human: 0,
    converted: 0,
    total: 0,
  };
  const matchedEpisodes: number[] = [];
  let totalFrames = 0;

  for (const ep of distribution.episodes) {
    if (selectedEpisodes && !selectedEpisodes.has(ep.episode_index)) continue;
    matchedEpisodes.push(ep.episode_index);
    for (const row of ep.subtasks) {
      if (!framesBySubtask.has(row.subtask)) {
        framesBySubtask.set(row.subtask, 0);
        episodesBySubtask.set(row.subtask, new Set());
      }
      framesBySubtask.set(
        row.subtask,
        (framesBySubtask.get(row.subtask) ?? 0) + row.frames,
      );
      episodesBySubtask.get(row.subtask)!.add(ep.episode_index);
      totalFrames += row.frames;

      if (row.annotator === "agent") annotatorCounts.agent += 1;
      else if (row.annotator === "human") annotatorCounts.human += 1;
      else if (row.annotator === "converted") annotatorCounts.converted += 1;
      annotatorCounts.total += 1;
    }
  }

  const subtasks = [...framesBySubtask.entries()].map(([subtask, frames]) => ({
    subtask,
    episodes: episodesBySubtask.get(subtask)?.size ?? 0,
    frames,
    share: totalFrames > 0 ? frames / totalFrames : 0,
  }));

  return {
    frameShares: { total_frames: totalFrames, subtasks },
    annotatorCounts,
    matchedEpisodes,
  };
}

export function recomputeObjectCoverage(
  objectEntry: DistributionObjectEntry,
  config: DistributionCoverageConfig,
  selectedEpisodes: ReadonlySet<number> | null,
  layer: DistributionObjectLayerKind = "tool",
): RecomputedObjectSummary {
  const selected = selectObjectLayer(objectEntry, layer);
  const poses = selectedEpisodes
    ? selected.poses.filter((p) => selectedEpisodes.has(p.episode_index))
    : [...selected.poses];
  const skipped = selectedEpisodes
    ? selected.skipped.filter((s) => selectedEpisodes.has(s.episode_index))
    : [...selected.skipped];

  const xyBinM = config.xy_bin_m;
  const yawBinDeg = config.yaw_bin_deg;
  const numYawBins = Math.max(
    1,
    Math.ceil(selected.yawPeriodDeg / yawBinDeg - 1e-9),
  );

  if (poses.length === 0) {
    return {
      resolvedLayer: selected.resolvedLayer,
      fallbackToTool: selected.fallbackToTool,
      poses,
      skipped,
      median_z_m: null,
      yaw_period_deg: selected.yawPeriodDeg,
      xy_bin_m: xyBinM,
      yaw_bin_deg: yawBinDeg,
      sparse_threshold: config.sparse_threshold,
      num_yaw_bins: numYawBins,
      ix_range: null,
      iy_range: null,
      xyCells: [],
      maxCellCount: 0,
    };
  }

  const countByCell = new Map<string, number>();
  let ixMin = Infinity;
  let ixMax = -Infinity;
  let iyMin = Infinity;
  let iyMax = -Infinity;

  for (const pose of poses) {
    const ix = Math.floor(pose.x_m / xyBinM);
    const iy = Math.floor(pose.y_m / xyBinM);
    if (ix < ixMin) ixMin = ix;
    if (ix > ixMax) ixMax = ix;
    if (iy < iyMin) iyMin = iy;
    if (iy > iyMax) iyMax = iy;
    const key = `${ix},${iy}`;
    countByCell.set(key, (countByCell.get(key) ?? 0) + 1);
  }

  const xyCells: RecomputedXyCell[] = [];
  let maxCellCount = 0;
  for (let ix = ixMin; ix <= ixMax; ix += 1) {
    for (let iy = iyMin; iy <= iyMax; iy += 1) {
      const count = countByCell.get(`${ix},${iy}`) ?? 0;
      if (count > maxCellCount) maxCellCount = count;
      xyCells.push({
        ix,
        iy,
        x_min_m: ix * xyBinM,
        x_max_m: (ix + 1) * xyBinM,
        y_min_m: iy * xyBinM,
        y_max_m: (iy + 1) * xyBinM,
        count,
      });
    }
  }

  return {
    resolvedLayer: selected.resolvedLayer,
    fallbackToTool: selected.fallbackToTool,
    poses,
    skipped,
    median_z_m: computeMedian(poses.map((p) => p.z_m)),
    yaw_period_deg: selected.yawPeriodDeg,
    xy_bin_m: xyBinM,
    yaw_bin_deg: yawBinDeg,
    sparse_threshold: config.sparse_threshold,
    num_yaw_bins: numYawBins,
    ix_range: [ixMin, ixMax],
    iy_range: [iyMin, iyMax],
    xyCells,
    maxCellCount,
  };
}

export interface YawGlyph {
  /** Stroke directions from the point, radians CCW from +X. */
  anglesRad: number[];
  arrowhead: boolean;
}

/**
 * How to draw one folded yaw. A 360° period has a head: one stroke with an
 * arrowhead. A shorter period has none, so the yaw is drawn as its
 * `360 / period` equivalent directions without a head (180° is a line through
 * the point). Otherwise 10° and 170° under a 180° period, which are 20° apart,
 * render as arrows 160° apart.
 */
export function yawGlyph(foldedYawDeg: number, periodDeg: number): YawGlyph {
  const rad = (foldedYawDeg * Math.PI) / 180;
  const folds = Math.round(360 / periodDeg);
  if (!(folds > 1)) return { anglesRad: [rad], arrowhead: true };
  return {
    anglesRad: Array.from(
      { length: folds },
      (_, k) => rad + (2 * Math.PI * k) / folds,
    ),
    arrowhead: false,
  };
}

export function computeYawPolarHistogram(
  yawsDeg: readonly number[],
  binDeg = 30,
): PolarYawBin[] {
  const numBins = Math.max(1, Math.round(360 / Math.max(1, binDeg)));
  const step = 360 / numBins;
  const counts = new Array<number>(numBins).fill(0);

  for (const yaw of yawsDeg) {
    if (!Number.isFinite(yaw)) continue;
    const wrapped = wrapAngle360(yaw);
    const idx = Math.min(numBins - 1, Math.floor(wrapped / step));
    counts[idx] += 1;
  }

  return counts.map((count, binIndex) => ({
    binIndex,
    startDeg: binIndex * step,
    endDeg: (binIndex + 1) * step,
    count,
  }));
}

/**
 * Project a 3D point already expressed at the calibrated tool point in the arm
 * base frame onto head-camera pixels using `T_cam_base` and pinhole intrinsics.
 * Does NOT apply `tool_offset` because `distribution.json` poses with
 * `position_point === "tool_point"` are already at `p_tcp + R_tcp @ tool_offset`.
 */
export function projectBasePointToPixel(
  pointBase: readonly [number, number, number],
  tCamBase: Matrix4RowMajor,
  intrinsics: Pick<CalibrationIntrinsics, "fx" | "fy" | "cx" | "cy">,
): ProjectedBasePoint | null {
  const [px, py, pz] = pointBase;
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
    return null;
  }
  const x =
    tCamBase[0][0] * px +
    tCamBase[0][1] * py +
    tCamBase[0][2] * pz +
    tCamBase[0][3];
  const y =
    tCamBase[1][0] * px +
    tCamBase[1][1] * py +
    tCamBase[1][2] * pz +
    tCamBase[1][3];
  const z =
    tCamBase[2][0] * px +
    tCamBase[2][1] * py +
    tCamBase[2][2] * pz +
    tCamBase[2][3];
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    z <= 1e-6
  ) {
    return null;
  }
  const u = intrinsics.fx * (x / z) + intrinsics.cx;
  const v = intrinsics.fy * (y / z) + intrinsics.cy;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return { u, v, depth: z };
}
