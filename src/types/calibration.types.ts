export type CalibrationTcpPose = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type CalibrationPixel = [number, number];

export type Matrix4RowMajor = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

export interface CalibrationFrameEntry {
  id: string;
  arm: string;
  episode_index: number;
  frame_index: number;
  tcp: CalibrationTcpPose;
  speed_mps?: number;
  [key: string]: unknown;
}

export interface CalibrationPointEntry extends CalibrationFrameEntry {
  pixel?: CalibrationPixel;
  skipped?: boolean;
}

export interface CalibrationFramesFile {
  version: number;
  repo_id: string;
  revision: string;
  camera: string;
  image_size: [number, number];
  frames: CalibrationFrameEntry[];
  [key: string]: unknown;
}

export interface CalibrationPointsFile {
  version: number;
  repo_id: string;
  revision: string;
  camera: string;
  image_size: [number, number];
  frames: CalibrationPointEntry[];
  [key: string]: unknown;
}

export interface CalibrationIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  distortion_model?: string;
  distortion: number[];
}

export interface CalibrationIntrinsicsFile extends CalibrationIntrinsics {
  version: number;
  camera: string;
  device?: string;
  image_size: [number, number];
}

export interface CalibrationResidual {
  id: string;
  du: number;
  dv: number;
}

export interface CalibrationArmResult {
  T_cam_base: Matrix4RowMajor;
  tool_offset: [number, number, number];
  n_points: number;
  rms_px: number;
  loo_rms_px: number;
  residuals: CalibrationResidual[];
}

export interface CalibrationHeadFile {
  version: number;
  repo_id: string;
  revision: string;
  camera: string;
  image_size: [number, number];
  intrinsics: CalibrationIntrinsics;
  arms: Record<string, CalibrationArmResult>;
}

export interface CalibrationPointUpdate {
  id: string;
  pixel?: CalibrationPixel | null;
  skipped?: boolean | null;
}

export interface CalibrationCliInfo {
  configured: boolean;
  projectDir: string | null;
  commands: {
    initFrames: string;
    appendFrames: string;
    calibrate: string;
  };
}

export interface CalibrationArtifactPathSummary {
  framesPath: string;
  pointsPath: string;
  headPath: string;
  intrinsicsPath: string;
}

export interface CalibrationFileIdentityMismatch {
  framesRepoId: string;
  framesRevision: string;
  pointsRepoId: string;
  pointsRevision: string;
}

export interface CalibrationMergeNotice {
  droppedFrameMismatchCount: number;
  droppedFrameMismatchIds: string[];
  fileIdentityMismatch: CalibrationFileIdentityMismatch | null;
  droppedByIdentityMismatchCount: number;
}

export interface CalibrationStatePayload {
  repoId: string;
  revision: string;
  paths: CalibrationArtifactPathSummary;
  framesExists: boolean;
  pointsExists: boolean;
  headExists: boolean;
  intrinsicsExists: boolean;
  framesFileError: string | null;
  pointsFileError: string | null;
  headFileError: string | null;
  intrinsicsFileError: string | null;
  camera: string;
  imageSize: [number, number];
  frames: CalibrationPointEntry[];
  mergeNotice: CalibrationMergeNotice;
  head: CalibrationHeadFile | null;
  intrinsics: CalibrationIntrinsicsFile | null;
  cli: CalibrationCliInfo;
}

export interface CalibrationEpisodeVideoInfo {
  filename: string;
  url: string;
  isSegmented: boolean;
  segmentStart?: number;
  segmentEnd?: number;
  segmentDuration?: number;
}

export interface CalibrationEpisodeMediaPayload {
  episodeIndex: number;
  fps: number;
  episodeLength: number;
  camera: string;
  imageSize: [number, number];
  video: CalibrationEpisodeVideoInfo | null;
  armsTcp?: Record<string, Array<CalibrationTcpPose | null>>;
}

export interface CalibrationRunResult {
  ok: boolean;
  configured: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  state: CalibrationStatePayload | null;
}
