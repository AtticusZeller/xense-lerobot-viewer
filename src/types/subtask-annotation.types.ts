export type SubtaskAnnotator = "agent" | "human" | "converted";

export const VALID_SUBTASK_ANNOTATORS: readonly SubtaskAnnotator[] = [
  "agent",
  "human",
  "converted",
];

export interface SubtaskAnnotationRow {
  repo_id: string;
  revision: string;
  episode_index: number;
  subtask: string;
  start: number;
  end: number;
  contact: number | null;
  grasp: number | null;
  success: boolean;
  annotator: SubtaskAnnotator;
  note: string;
}

export interface TaskSpecSubtask {
  name: string;
  prompt: string;
  cameras?: string[];
}

export interface TaskSpec {
  name: string;
  subtasks: TaskSpecSubtask[];
}

export type SubtaskValidationRule =
  | "empty_episode"
  | "invalid_annotator"
  | "unknown_subtask"
  | "out_of_range"
  | "invalid_interval"
  | "contact_out_of_range"
  | "grasp_out_of_range"
  | "contact_after_grasp"
  | "missing_frames"
  | "overlap"
  | "wrong_subtask_order";

export interface SubtaskValidationIssue {
  rule: SubtaskValidationRule;
  rowIndex?: number;
  subtask?: string;
  message: string;
}

export interface SubtaskEpisodePayload {
  repoId: string;
  revision: string;
  episodeIndex: number;
  episodeLength: number;
  csvPath: string;
  csvExists: boolean;
  taskSpecPath: string;
  taskSpec: TaskSpec | null;
  taskSpecError: string | null;
  rows: SubtaskAnnotationRow[];
}

export interface SubtaskSaveResponse extends SubtaskEpisodePayload {
  changedRowCount: number;
}

export interface DistributionReportStatus {
  repoId: string;
  revision: string;
  exists: boolean;
  reportPath: string;
  reportUrl: string;
  mtimeMs: number | null;
  sizeBytes: number | null;
  suggestedCommand: string;
}
