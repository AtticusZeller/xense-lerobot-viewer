import {
  VALID_SUBTASK_ANNOTATORS,
  type SubtaskAnnotationRow,
  type SubtaskValidationIssue,
  type TaskSpec,
} from "@/types/subtask-annotation.types";

/**
 * Distinct dark-surface segment colours. Orange (`orange-400/500`) is omitted
 * because CLAUDE.md reserves it for flagged-episode UI.
 */
export const SUBTASK_COLORS = [
  "#38bdf8", // sky-400
  "#a78bfa", // violet-400
  "#34d399", // emerald-400
  "#f472b6", // pink-400
  "#fbbf24", // amber-400
  "#2dd4bf", // teal-400
  "#818cf8", // indigo-400
  "#fb7185", // rose-400
] as const;

export function colorForSubtask(
  subtaskName: string,
  taskSpec: TaskSpec | null,
  fallbackIndex = 0,
): string {
  if (taskSpec) {
    const idx = taskSpec.subtasks.findIndex((s) => s.name === subtaskName);
    if (idx !== -1) {
      return SUBTASK_COLORS[idx % SUBTASK_COLORS.length];
    }
  }
  return SUBTASK_COLORS[Math.abs(fallbackIndex) % SUBTASK_COLORS.length];
}

export function timeToFrame(
  timeSeconds: number,
  fps: number,
  episodeLength: number,
): number {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(fps) || fps <= 0) {
    return 0;
  }
  const maxFrame = Math.max(0, episodeLength - 1);
  return Math.max(0, Math.min(maxFrame, Math.round(timeSeconds * fps)));
}

export function frameToTime(frame: number, fps: number): number {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0) {
    return 0;
  }
  return Math.max(0, frame) / fps;
}

export function activeSubtaskIndexAt(
  rows: readonly SubtaskAnnotationRow[],
  frame: number,
): number {
  for (let i = 0; i < rows.length; i += 1) {
    if (frame >= rows[i].start && frame < rows[i].end) {
      return i;
    }
  }
  return -1;
}

/**
 * Move `rows[rowIndex].start` to `frame` while moving the previous row's `end`
 * to match so adjacent boundaries stay contiguous.
 */
export function moveRowStart(
  rows: readonly SubtaskAnnotationRow[],
  rowIndex: number,
  frame: number,
): SubtaskAnnotationRow[] {
  if (rowIndex < 0 || rowIndex >= rows.length || !Number.isInteger(frame)) {
    return rows.slice();
  }
  return rows.map((row, idx) => {
    if (idx === rowIndex) {
      return { ...row, start: frame };
    }
    if (rowIndex > 0 && idx === rowIndex - 1) {
      return { ...row, end: frame };
    }
    return row;
  });
}

/**
 * Move `rows[rowIndex].end` to `frame` while moving the next row's `start`
 * to match so adjacent boundaries stay contiguous.
 */
export function moveRowEnd(
  rows: readonly SubtaskAnnotationRow[],
  rowIndex: number,
  frame: number,
): SubtaskAnnotationRow[] {
  if (rowIndex < 0 || rowIndex >= rows.length || !Number.isInteger(frame)) {
    return rows.slice();
  }
  return rows.map((row, idx) => {
    if (idx === rowIndex) {
      return { ...row, end: frame };
    }
    if (rowIndex < rows.length - 1 && idx === rowIndex + 1) {
      return { ...row, start: frame };
    }
    return row;
  });
}

/**
 * Insert a new boundary at `frame` by splitting whichever segment strictly
 * contains `frame` (`start < frame < end`). Picks the adjacent subtask from
 * `taskSpec` when available so the episode stays a contiguous slice.
 */
export function addBoundaryAtFrame(
  rows: readonly SubtaskAnnotationRow[],
  frame: number,
  taskSpec: TaskSpec | null,
  defaults: { repoId: string; revision: string; episodeIndex: number },
): SubtaskAnnotationRow[] {
  if (!Number.isInteger(frame)) return rows.slice();
  const targetIdx = rows.findIndex(
    (row) => frame > row.start && frame < row.end,
  );
  if (targetIdx === -1) return rows.slice();

  const target = rows[targetIdx];
  const specNames = taskSpec?.subtasks.map((s) => s.name) ?? [];
  const specIdx = specNames.indexOf(target.subtask);

  let leftSubtask = target.subtask;
  let rightSubtask = target.subtask;

  if (specIdx !== -1) {
    const nextSpecName =
      specIdx + 1 < specNames.length ? specNames[specIdx + 1] : null;
    const prevSpecName = specIdx - 1 >= 0 ? specNames[specIdx - 1] : null;
    const usedNames = new Set(rows.map((r) => r.subtask));

    if (nextSpecName && !usedNames.has(nextSpecName)) {
      rightSubtask = nextSpecName;
    } else if (prevSpecName && !usedNames.has(prevSpecName)) {
      leftSubtask = prevSpecName;
      rightSubtask = target.subtask;
    } else if (nextSpecName) {
      rightSubtask = nextSpecName;
    }
  }

  const leftRow: SubtaskAnnotationRow = {
    repo_id: target.repo_id || defaults.repoId,
    revision: target.revision || defaults.revision,
    episode_index: defaults.episodeIndex,
    subtask: leftSubtask,
    start: target.start,
    end: frame,
    contact:
      target.contact !== null && target.contact < frame ? target.contact : null,
    grasp: target.grasp !== null && target.grasp < frame ? target.grasp : null,
    success: target.success,
    annotator: "human",
    note: target.note,
  };

  const rightRow: SubtaskAnnotationRow = {
    repo_id: target.repo_id || defaults.repoId,
    revision: target.revision || defaults.revision,
    episode_index: defaults.episodeIndex,
    subtask: rightSubtask,
    start: frame,
    end: target.end,
    contact:
      target.contact !== null && target.contact >= frame
        ? target.contact
        : null,
    grasp: target.grasp !== null && target.grasp >= frame ? target.grasp : null,
    success: true,
    annotator: "human",
    note: "",
  };

  return [
    ...rows.slice(0, targetIdx),
    leftRow,
    rightRow,
    ...rows.slice(targetIdx + 1),
  ];
}

/**
 * Remove the boundary between `leftIndex` and `leftIndex + 1`, merging the
 * right row's frame span into the left row so coverage stays contiguous.
 */
export function removeBoundaryBetween(
  rows: readonly SubtaskAnnotationRow[],
  leftIndex: number,
): SubtaskAnnotationRow[] {
  if (leftIndex < 0 || leftIndex >= rows.length - 1) {
    return rows.slice();
  }
  const left = rows[leftIndex];
  const right = rows[leftIndex + 1];
  const merged: SubtaskAnnotationRow = {
    ...left,
    end: right.end,
    annotator: "human",
  };
  return [...rows.slice(0, leftIndex), merged, ...rows.slice(leftIndex + 2)];
}

/**
 * Remove `rowIndex` and absorb its frame span into an adjacent row so
 * `[0, episodeLength)` remains contiguous.
 */
export function removeRowAndAbsorb(
  rows: readonly SubtaskAnnotationRow[],
  rowIndex: number,
): SubtaskAnnotationRow[] {
  if (rows.length <= 1 || rowIndex < 0 || rowIndex >= rows.length) {
    return rows.slice();
  }
  if (rowIndex > 0) {
    return removeBoundaryBetween(rows, rowIndex - 1);
  }
  const first = rows[0];
  const second = rows[1];
  return [
    {
      ...second,
      start: first.start,
      annotator: "human",
    },
    ...rows.slice(2),
  ];
}

export function createRowsFromTaskSpec(
  taskSpec: TaskSpec,
  options: {
    repoId: string;
    revision: string;
    episodeIndex: number;
    episodeLength: number;
    startSubtaskIndex?: number;
    endSubtaskIndex?: number;
  },
): SubtaskAnnotationRow[] {
  const { repoId, revision, episodeIndex, episodeLength } = options;
  if (episodeLength <= 0 || taskSpec.subtasks.length === 0) return [];

  const startIdx = Math.max(0, options.startSubtaskIndex ?? 0);
  const endIdx = Math.min(
    taskSpec.subtasks.length - 1,
    options.endSubtaskIndex ?? taskSpec.subtasks.length - 1,
  );
  if (startIdx > endIdx) return [];

  const slice = taskSpec.subtasks.slice(startIdx, endIdx + 1);
  const count = Math.min(slice.length, episodeLength);
  const selected = slice.slice(0, count);

  return selected.map((spec, i) => {
    const start = Math.floor((i * episodeLength) / count);
    const end =
      i === count - 1
        ? episodeLength
        : Math.floor(((i + 1) * episodeLength) / count);
    return {
      repo_id: repoId,
      revision,
      episode_index: episodeIndex,
      subtask: spec.name,
      start,
      end,
      contact: null,
      grasp: null,
      success: true,
      annotator: "human",
      note: "",
    };
  });
}

/**
 * Lightweight pre-save validation matching `lerobot-check/validate.py` episode rules.
 */
export function validateEpisodeSubtasks(
  rows: readonly SubtaskAnnotationRow[],
  episodeLength: number,
  taskSpec: TaskSpec | null,
): SubtaskValidationIssue[] {
  const issues: SubtaskValidationIssue[] = [];

  if (rows.length === 0) {
    issues.push({
      rule: "empty_episode",
      message: "Episode has no subtask rows.",
    });
    return issues;
  }

  const specIndex = new Map<string, number>();
  if (taskSpec) {
    taskSpec.subtasks.forEach((s, idx) => specIndex.set(s.name, idx));
  }

  const indexed = rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .sort((a, b) => a.row.start - b.row.start || a.row.end - b.row.end);

  let allSubtasksKnown = taskSpec !== null;

  for (const { row, rowIndex } of indexed) {
    if (
      !(VALID_SUBTASK_ANNOTATORS as readonly string[]).includes(row.annotator)
    ) {
      issues.push({
        rule: "invalid_annotator",
        rowIndex,
        subtask: row.subtask,
        message: `Row '${row.subtask}' has invalid annotator '${row.annotator}'.`,
      });
    }

    if (taskSpec && !specIndex.has(row.subtask)) {
      allSubtasksKnown = false;
      issues.push({
        rule: "unknown_subtask",
        rowIndex,
        subtask: row.subtask,
        message: `Subtask '${row.subtask}' is not defined in task spec.`,
      });
    }

    if (!row.subtask.trim()) {
      allSubtasksKnown = false;
      issues.push({
        rule: "unknown_subtask",
        rowIndex,
        message: `Row ${rowIndex + 1} has an empty subtask name.`,
      });
    }

    if (!Number.isInteger(row.start) || !Number.isInteger(row.end)) {
      issues.push({
        rule: "invalid_interval",
        rowIndex,
        subtask: row.subtask,
        message: `Subtask '${row.subtask}' start/end must be integers.`,
      });
      continue;
    }

    if (row.start < 0) {
      issues.push({
        rule: "out_of_range",
        rowIndex,
        subtask: row.subtask,
        message: `Subtask '${row.subtask}' has negative start frame ${row.start}.`,
      });
    }

    if (
      episodeLength > 0 &&
      (row.end > episodeLength || row.start >= episodeLength)
    ) {
      issues.push({
        rule: "out_of_range",
        rowIndex,
        subtask: row.subtask,
        message: `Subtask '${row.subtask}' interval [${row.start}, ${row.end}) exceeds episode length ${episodeLength}.`,
      });
    }

    if (row.start >= row.end) {
      issues.push({
        rule: "invalid_interval",
        rowIndex,
        subtask: row.subtask,
        message: `Subtask '${row.subtask}' interval [${row.start}, ${row.end}) must satisfy start < end.`,
      });
    }

    if (
      row.contact !== null &&
      (!Number.isInteger(row.contact) ||
        row.contact < row.start ||
        row.contact >= row.end)
    ) {
      issues.push({
        rule: "contact_out_of_range",
        rowIndex,
        subtask: row.subtask,
        message: `Subtask '${row.subtask}' contact=${row.contact} is outside [${row.start}, ${row.end}).`,
      });
    }

    if (
      row.grasp !== null &&
      (!Number.isInteger(row.grasp) ||
        row.grasp < row.start ||
        row.grasp >= row.end)
    ) {
      issues.push({
        rule: "grasp_out_of_range",
        rowIndex,
        subtask: row.subtask,
        message: `Subtask '${row.subtask}' grasp=${row.grasp} is outside [${row.start}, ${row.end}).`,
      });
    }

    if (row.contact !== null && row.grasp !== null && row.contact > row.grasp) {
      issues.push({
        rule: "contact_after_grasp",
        rowIndex,
        subtask: row.subtask,
        message: `Subtask '${row.subtask}' has contact=${row.contact} > grasp=${row.grasp}.`,
      });
    }
  }

  if (indexed[0].row.start > 0) {
    issues.push({
      rule: "missing_frames",
      rowIndex: indexed[0].rowIndex,
      subtask: indexed[0].row.subtask,
      message: `Episode does not start at frame 0; frames [0, ${indexed[0].row.start}) are uncovered.`,
    });
  }

  for (let i = 0; i < indexed.length - 1; i += 1) {
    const prev = indexed[i].row;
    const curr = indexed[i + 1].row;
    if (curr.start > prev.end) {
      issues.push({
        rule: "missing_frames",
        rowIndex: indexed[i + 1].rowIndex,
        subtask: curr.subtask,
        message: `Gap between '${prev.subtask}' (end=${prev.end}) and '${curr.subtask}' (start=${curr.start}).`,
      });
    } else if (curr.start < prev.end) {
      issues.push({
        rule: "overlap",
        rowIndex: indexed[i + 1].rowIndex,
        subtask: curr.subtask,
        message: `Overlap between '${prev.subtask}' [${prev.start}, ${prev.end}) and '${curr.subtask}' [${curr.start}, ${curr.end}).`,
      });
    }
  }

  const last = indexed[indexed.length - 1];
  if (episodeLength > 0 && last.row.end < episodeLength) {
    issues.push({
      rule: "missing_frames",
      rowIndex: last.rowIndex,
      subtask: last.row.subtask,
      message: `Episode ends at ${last.row.end} < length ${episodeLength}; frames [${last.row.end}, ${episodeLength}) are uncovered.`,
    });
  }

  if (taskSpec && allSubtasksKnown) {
    for (let i = 0; i < indexed.length - 1; i += 1) {
      const prev = indexed[i].row;
      const curr = indexed[i + 1].row;
      const prevIdx = specIndex.get(prev.subtask)!;
      const currIdx = specIndex.get(curr.subtask)!;
      if (currIdx !== prevIdx + 1) {
        issues.push({
          rule: "wrong_subtask_order",
          rowIndex: indexed[i + 1].rowIndex,
          subtask: curr.subtask,
          message: `Subtask '${curr.subtask}' cannot follow '${prev.subtask}'; subtasks must follow task spec order as a contiguous slice.`,
        });
      }
    }
  }

  return issues;
}
