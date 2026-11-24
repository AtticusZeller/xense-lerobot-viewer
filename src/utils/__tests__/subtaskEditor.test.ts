import { describe, expect, it } from "bun:test";
import type {
  SubtaskAnnotationRow,
  TaskSpec,
} from "@/types/subtask-annotation.types";
import {
  addBoundaryAtFrame,
  createRowsFromTaskSpec,
  frameToTime,
  moveRowEnd,
  moveRowStart,
  removeBoundaryBetween,
  removeRowAndAbsorb,
  timeToFrame,
  validateEpisodeSubtasks,
} from "../subtaskEditor";

const SPEC: TaskSpec = {
  name: "three_stage",
  subtasks: [
    { name: "open_carton", prompt: "Open the egg carton." },
    { name: "place_eggs", prompt: "Place the eggs." },
    { name: "close_carton", prompt: "Close the egg carton." },
  ],
};

function makeRow(
  overrides: Partial<SubtaskAnnotationRow> = {},
): SubtaskAnnotationRow {
  return {
    repo_id: "Xense/test",
    revision: "local",
    episode_index: 0,
    subtask: "open_carton",
    start: 0,
    end: 100,
    contact: null,
    grasp: null,
    success: true,
    annotator: "converted",
    note: "",
    ...overrides,
  };
}

describe("subtaskEditor boundary linkage", () => {
  it("moveRowEnd moves the next row's start to keep contiguity", () => {
    const rows = [
      makeRow({ subtask: "open_carton", start: 0, end: 100 }),
      makeRow({ subtask: "place_eggs", start: 100, end: 250 }),
      makeRow({ subtask: "close_carton", start: 250, end: 400 }),
    ];

    const updated = moveRowEnd(rows, 0, 125);
    expect(updated[0].end).toBe(125);
    expect(updated[1].start).toBe(125);
    expect(updated[2].start).toBe(250);
    expect(validateEpisodeSubtasks(updated, 400, SPEC)).toEqual([]);
  });

  it("moveRowStart moves the previous row's end to keep contiguity", () => {
    const rows = [
      makeRow({ subtask: "open_carton", start: 0, end: 100 }),
      makeRow({ subtask: "place_eggs", start: 100, end: 250 }),
    ];

    const updated = moveRowStart(rows, 1, 88);
    expect(updated[0].end).toBe(88);
    expect(updated[1].start).toBe(88);
    expect(validateEpisodeSubtasks(updated, 250, SPEC)).toEqual([]);
  });

  it("addBoundaryAtFrame splits a row contiguously and picks the next spec subtask", () => {
    const rows = [
      makeRow({ subtask: "open_carton", start: 0, end: 300, grasp: 50 }),
    ];

    const split = addBoundaryAtFrame(rows, 120, SPEC, {
      repoId: "Xense/test",
      revision: "local",
      episodeIndex: 0,
    });

    expect(split).toHaveLength(2);
    expect(split[0]).toMatchObject({
      subtask: "open_carton",
      start: 0,
      end: 120,
      grasp: 50,
    });
    expect(split[1]).toMatchObject({
      subtask: "place_eggs",
      start: 120,
      end: 300,
      grasp: null,
    });
    expect(validateEpisodeSubtasks(split, 300, SPEC)).toEqual([]);
  });

  it("removeBoundaryBetween and removeRowAndAbsorb preserve full [0, length) coverage", () => {
    const rows = [
      makeRow({ subtask: "open_carton", start: 0, end: 100 }),
      makeRow({ subtask: "place_eggs", start: 100, end: 250 }),
      makeRow({ subtask: "close_carton", start: 250, end: 400 }),
    ];

    const mergedTail = removeBoundaryBetween(rows, 1);
    expect(mergedTail.map((r) => [r.subtask, r.start, r.end])).toEqual([
      ["open_carton", 0, 100],
      ["place_eggs", 100, 400],
    ]);
    expect(validateEpisodeSubtasks(mergedTail, 400, SPEC)).toEqual([]);

    const droppedFirst = removeRowAndAbsorb(rows, 0);
    expect(droppedFirst.map((r) => [r.subtask, r.start, r.end])).toEqual([
      ["place_eggs", 0, 250],
      ["close_carton", 250, 400],
    ]);
    expect(validateEpisodeSubtasks(droppedFirst, 400, SPEC)).toEqual([]);
  });

  it("createRowsFromTaskSpec creates valid full and single-stage slices", () => {
    const full = createRowsFromTaskSpec(SPEC, {
      repoId: "Xense/test",
      revision: "local",
      episodeIndex: 4,
      episodeLength: 301,
    });
    expect(full.map((r) => [r.subtask, r.start, r.end])).toEqual([
      ["open_carton", 0, 100],
      ["place_eggs", 100, 200],
      ["close_carton", 200, 301],
    ]);
    expect(validateEpisodeSubtasks(full, 301, SPEC)).toEqual([]);

    const single = createRowsFromTaskSpec(SPEC, {
      repoId: "Xense/test",
      revision: "local",
      episodeIndex: 5,
      episodeLength: 200,
      startSubtaskIndex: 1,
      endSubtaskIndex: 1,
    });
    expect(single.map((r) => [r.subtask, r.start, r.end])).toEqual([
      ["place_eggs", 0, 200],
    ]);
    expect(validateEpisodeSubtasks(single, 200, SPEC)).toEqual([]);
  });
});

describe("validateEpisodeSubtasks lightweight checks", () => {
  it("accepts a valid multi-stage episode and a valid single-stage supplement episode", () => {
    const multi = [
      makeRow({
        subtask: "open_carton",
        start: 0,
        end: 100,
        contact: 40,
        grasp: 55,
      }),
      makeRow({
        subtask: "place_eggs",
        start: 100,
        end: 300,
        contact: 120,
        grasp: 120,
      }),
    ];
    expect(validateEpisodeSubtasks(multi, 300, SPEC)).toEqual([]);

    const supplement = [
      makeRow({ subtask: "place_eggs", start: 0, end: 180, grasp: 40 }),
    ];
    expect(validateEpisodeSubtasks(supplement, 180, SPEC)).toEqual([]);
  });

  it("catches missing leading/middle/trailing frames and overlap", () => {
    const gap = [
      makeRow({ subtask: "open_carton", start: 5, end: 100 }),
      makeRow({ subtask: "place_eggs", start: 110, end: 280 }),
    ];
    const gapRules = validateEpisodeSubtasks(gap, 300, SPEC).map((i) => i.rule);
    expect(gapRules.filter((r) => r === "missing_frames")).toHaveLength(3);

    const overlap = [
      makeRow({ subtask: "open_carton", start: 0, end: 120 }),
      makeRow({ subtask: "place_eggs", start: 100, end: 300 }),
    ];
    expect(
      validateEpisodeSubtasks(overlap, 300, SPEC).map((i) => i.rule),
    ).toContain("overlap");
  });

  it("catches invalid interval, out_of_range, contact/grasp bounds, and contact > grasp", () => {
    const bad = [
      makeRow({
        subtask: "open_carton",
        start: 0,
        end: 100,
        contact: 80,
        grasp: 70,
      }),
      makeRow({
        subtask: "place_eggs",
        start: 100,
        end: 310,
        contact: 95,
        grasp: 310,
      }),
    ];
    const rules = validateEpisodeSubtasks(bad, 300, SPEC).map((i) => i.rule);
    expect(rules).toContain("contact_after_grasp");
    expect(rules).toContain("out_of_range");
    expect(rules).toContain("contact_out_of_range");
    expect(rules).toContain("grasp_out_of_range");

    const zeroLen = [
      makeRow({ subtask: "open_carton", start: 0, end: 0 }),
      makeRow({ subtask: "place_eggs", start: 0, end: 300 }),
    ];
    expect(
      validateEpisodeSubtasks(zeroLen, 300, SPEC).map((i) => i.rule),
    ).toContain("invalid_interval");
  });

  it("catches unknown subtask and wrong subtask order (reversed or skipped)", () => {
    const unknown = [makeRow({ subtask: "mystery", start: 0, end: 100 })];
    expect(
      validateEpisodeSubtasks(unknown, 100, SPEC).map((i) => i.rule),
    ).toContain("unknown_subtask");

    const reversed = [
      makeRow({ subtask: "place_eggs", start: 0, end: 100 }),
      makeRow({ subtask: "open_carton", start: 100, end: 200 }),
    ];
    expect(
      validateEpisodeSubtasks(reversed, 200, SPEC).map((i) => i.rule),
    ).toContain("wrong_subtask_order");

    const skipped = [
      makeRow({ subtask: "open_carton", start: 0, end: 100 }),
      makeRow({ subtask: "close_carton", start: 100, end: 200 }),
    ];
    expect(
      validateEpisodeSubtasks(skipped, 200, SPEC).map((i) => i.rule),
    ).toContain("wrong_subtask_order");
  });
});

describe("frame/time conversion", () => {
  it("round-trips integer frame indices accurately at 30 fps", () => {
    for (const f of [0, 1, 29, 30, 899, 900, 901, 2778]) {
      expect(timeToFrame(frameToTime(f, 30), 30, 2779)).toBe(f);
    }
  });
});
