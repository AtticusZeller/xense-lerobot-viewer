import type { DistributionPositionPoint } from "@/types/distribution.types";

export type TargetPolygonVertex = [number, number];

export interface TargetPolygonFile {
  version: 1;
  camera: string;
  image_size: [number, number];
  polygon: TargetPolygonVertex[];
}

export type SuggestionTier = "empty" | "sparse" | "dense" | "edge";

export interface SuggestionPointItem {
  object: string;
  arm: string;
  index: number;
  x_m: number;
  y_m: number;
  z_m: number;
  yaw_deg: number;
  ix: number;
  iy: number;
  yaw_bin: number;
  cell_count: number;
  tier: SuggestionTier;
  pixel: [number, number] | null;
  arrow_end_pixel: [number, number] | null;
}

export interface SuggestionObjectGeometry {
  object: string;
  arm: string;
  z_plane_m: number;
  yaw_symmetry_deg: number;
  polygon_base_xy_m: [number, number][];
  polygon_pixel: [number, number][] | null;
}

export interface SuggestionsProvenance {
  repo_id: string;
  revision: string;
  task_name: string;
  position_point: DistributionPositionPoint;
  distribution_path: string | null;
  targets_path: string | null;
  calib_path: string | null;
  region_source: string;
  seed: number;
  count_per_object: number;
  test_per_tier: number;
  arrow_length_m: number;
  note: string;
}

export interface SuggestionsFile {
  version: number;
  provenance: SuggestionsProvenance;
  objects: SuggestionObjectGeometry[];
  omitted_objects: string[];
  placements: SuggestionPointItem[];
  test_points: SuggestionPointItem[];
}

export type CollectionTargetKind = "placement" | "test_point";

export type CollectionMaskTarget = Pick<
  SuggestionPointItem,
  "object" | "index" | "pixel" | "arrow_end_pixel"
> & {
  outline: TargetPolygonVertex[] | null;
  reason: string | null;
} & (
    | { kind: "placement"; tier?: never }
    | { kind: "test_point"; tier: Exclude<SuggestionTier, "sparse"> }
  );

export interface CollectionMaskBundle {
  version: 1;
  repo_id: string;
  revision: string;
  camera: string;
  image_size: [number, number];
  calibration_sha256: string;
  suggestions_sha256: string;
  sources: Record<string, unknown>;
  targets: CollectionMaskTarget[];
}

export type CollectionPlanTarget = Extract<
  CollectionMaskTarget,
  { kind: "placement" }
> &
  Pick<SuggestionPointItem, "arm" | "x_m" | "y_m" | "z_m" | "yaw_deg"> & {
    pixel: TargetPolygonVertex;
    arrow_end_pixel: TargetPolygonVertex;
    yaw_symmetry_deg: number;
    outline_plane_z_m: number | null;
  };

export interface CollectionPlanRound {
  id: number;
  mask_bundle_sha256: string;
  targets: CollectionPlanTarget[];
  status: "pending" | "collected" | "skipped";
  episode_index: number | null;
}

export interface CollectionPlan {
  format: "lerobot-collection-plan";
  version: 1;
  plan_id: string;
  generation: number;
  next_round_id: number;
  repo_id: string;
  revision: string;
  source_episode_count: number;
  camera: string;
  image_size: [number, number];
  camera_serial: string | null;
  calibration_sha256: string;
  mask_bundle_sha256: string;
  settings: {
    round_count: number;
    objects_per_round: number;
    seed: number;
    min_revisit_distance_m: number;
    region_source: string;
  };
  excluded_objects: Record<string, string>;
  rounds: CollectionPlanRound[];
}

export type CollectionPlanAction =
  | { action: "generate"; roundCount: number; objectsPerRound: number }
  | { action: "replace" | "delete"; roundId: number };

export interface CollectionPlanSnapshot {
  plan_id: string;
  generation: number;
}

export interface CollectionArtifactPathSummary {
  targetsPath: string;
  suggestionsPath: string;
  distributionPath: string;
  headPath: string;
}

export interface CollectionStatePayload {
  repoId: string;
  revision: string;
  paths: CollectionArtifactPathSummary;
  camera: string;
  imageSize: [number, number];
  targetsExists: boolean;
  targets: TargetPolygonFile | null;
  targetsError: string | null;
  suggestionsExists: boolean;
  suggestions: SuggestionsFile | null;
  suggestionsError: string | null;
  masks: CollectionMaskBundle | null;
  masksError: "invalid" | "stale" | "imageMismatch" | null;
  plan: CollectionPlan | null;
  planError: "invalid" | "stale" | "imageMismatch" | null;
  calibration: {
    exists: boolean;
    hasNonZeroDistortion: boolean;
    error: string | null;
  };
  distribution: {
    exists: boolean;
    positionPoint: DistributionPositionPoint | null;
    annotatedEpisodes: number[];
    objects: string[];
    error: string | null;
  };
  cli: {
    configured: boolean;
    projectDir: string | null;
    suggestCommand: string;
    distributionCommand: string;
  };
}

export interface CollectionSuggestResult {
  ok: boolean;
  configured: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  state: CollectionStatePayload | null;
}
