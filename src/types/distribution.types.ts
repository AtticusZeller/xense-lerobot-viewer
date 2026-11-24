import type { CalibrationHeadFile } from "@/types/calibration.types";

export type DistributionPositionPoint = "tool_point" | "tcp";

export interface DistributionAnnotatorCounts {
  agent: number;
  human: number;
  converted: number;
  total: number;
}

export interface DistributionProvenance {
  repo_id: string;
  revision: string;
  task_name: string;
  annotations_path: string | null;
  task_spec_path: string | null;
  position_point: DistributionPositionPoint;
  calib_path: string | null;
  calib_mtime: string | null;
  calibrated_arms: string[];
  fps: number;
  annotator_counts: DistributionAnnotatorCounts;
  dataset_total_episodes: number;
  episode_filter: number[] | null;
  annotated_episodes: number[];
  skipped_episodes: number[];
}

export interface DistributionCoverageConfig {
  xy_bin_m: number;
  yaw_bin_deg: number;
  sparse_threshold: number;
}

export interface DistributionFrameShareEntry {
  subtask: string;
  episodes: number;
  frames: number;
  share: number;
}

export interface DistributionFrameShares {
  total_frames: number;
  subtasks: DistributionFrameShareEntry[];
}

export interface DistributionEpisodeSubtask {
  subtask: string;
  start: number;
  end: number;
  frames: number;
  grasp: number | null;
  success: boolean;
  annotator: string;
}

export interface DistributionEpisodeEntry {
  episode_index: number;
  length: number;
  subtasks: DistributionEpisodeSubtask[];
}

export type DistributionRot6d = [
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface DistributionObjectPose {
  episode_index: number;
  frame: number;
  arm: string;
  x_m: number;
  y_m: number;
  z_m: number;
  raw_yaw_deg: number;
  folded_yaw_deg: number;
  rot6d: DistributionRot6d;
}

export interface DistributionObjectSkipped {
  episode_index: number;
  reason: string;
}

export interface DistributionCoverageBin {
  ix: number;
  iy: number;
  yaw_bin: number;
  x_min_m: number;
  x_max_m: number;
  y_min_m: number;
  y_max_m: number;
  yaw_min_deg: number;
  yaw_max_deg: number;
  count: number;
}

export interface DistributionObjectCoverage {
  sample_count: number;
  xy_bin_m: number;
  yaw_bin_deg: number;
  sparse_threshold: number;
  num_yaw_bins: number;
  ix_range: [number, number] | null;
  iy_range: [number, number] | null;
  bins: DistributionCoverageBin[];
}

export interface DistributionObjectEntry {
  name: string;
  subtask: string;
  event: "grasp" | "release";
  arm: string;
  yaw_symmetry_deg: number;
  median_z_m: number | null;
  poses: DistributionObjectPose[];
  skipped: DistributionObjectSkipped[];
  coverage: DistributionObjectCoverage;
}

export interface DistributionPose {
  x_m: number;
  y_m: number;
  z_m: number;
  yaw_deg: number;
  rot6d: DistributionRot6d;
}

export interface DistributionTrajectoryPoint {
  progress: number;
  x_m: number;
  y_m: number;
  z_m: number;
  yaw_deg: number;
}

export interface DistributionCoverageMetric {
  occupied_xy_cells: number;
  yaw_span_deg: number;
}

export interface DistributionSubtaskArmMetrics {
  episode_count: number;
  start_coverage: DistributionCoverageMetric;
  end_coverage: DistributionCoverageMetric;
  trajectory_dispersion_cm: number | null;
}

export interface DistributionSubtaskArmEpisode {
  episode_index: number;
  start_frame: number;
  end_frame: number;
  start_pose: DistributionPose;
  end_pose: DistributionPose;
  trajectory: DistributionTrajectoryPoint[];
}

export interface DistributionSubtaskArmData {
  metrics: DistributionSubtaskArmMetrics;
  episodes: DistributionSubtaskArmEpisode[];
}

export interface DistributionSubtaskEntry {
  name: string;
  prompt: string;
  participating_arms: string[];
  arms: Record<string, DistributionSubtaskArmData>;
}

export interface DistributionFile {
  version: number;
  provenance: DistributionProvenance;
  coverage_config: DistributionCoverageConfig;
  trajectory_samples: number;
  frame_shares: DistributionFrameShares;
  episodes: DistributionEpisodeEntry[];
  objects: DistributionObjectEntry[];
  subtasks: DistributionSubtaskEntry[];
}

export interface DistributionCliInfo {
  configured: boolean;
  projectDir: string | null;
  command: string;
}

export interface DistributionStatePayload {
  repoId: string;
  revision: string;
  distributionPath: string;
  exists: boolean;
  mtimeMs: number | null;
  fileError: string | null;
  distribution: DistributionFile | null;
  calibration: {
    exists: boolean;
    head: CalibrationHeadFile | null;
    error: string | null;
  };
  cli: DistributionCliInfo;
}

export interface DistributionRecomputeResult {
  ok: boolean;
  configured: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  state: DistributionStatePayload | null;
}
