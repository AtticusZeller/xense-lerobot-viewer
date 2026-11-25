import { describe, expect, it } from "bun:test";
import type { SubtaskAnnotationRow } from "@/types/subtask-annotation.types";
import {
  isEpisodeRowsReviewed,
  markEpisodeRowsReviewed,
  mergeEpisodeIntoCsv,
  parseSubtaskCsv,
  resolveDraftAnnotators,
  serializeSubtaskCsv,
  serializeSubtaskRows,
  summarizeSubtaskReviewProgress,
} from "../subtaskCsv";

const SAMPLE_CSV = [
  "repo_id,revision,episode_index,subtask,start,end,contact,grasp,success,annotator,note",
  "Xense/egg_carton,4b03b879c274e11040d2ad882b56172354d0cb9d,0,open_carton,0,900,,120,true,converted,",
  'Xense/egg_carton,4b03b879c274e11040d2ad882b56172354d0cb9d,0,place_eggs,900,2779,940,960,true,agent,"note with, comma and ""quotes"""',
  "Xense/egg_carton,4b03b879c274e11040d2ad882b56172354d0cb9d,1,open_carton,0,420,,,false,converted,lid stuck",
  "Xense/egg_carton,4b03b879c274e11040d2ad882b56172354d0cb9d,1,place_eggs,420,1800,450,470,true,converted,",
  "",
].join("\n");

describe("subtaskCsv", () => {
  it("round-trips CSV parse -> serialize byte-identically when nothing changes", () => {
    const parsed = parseSubtaskCsv(SAMPLE_CSV);
    expect(parsed.records).toHaveLength(4);
    expect(parsed.records[1].row.note).toBe('note with, comma and "quotes"');
    expect(parsed.records[0].row.contact).toBeNull();
    expect(parsed.records[0].row.grasp).toBe(120);
    expect(parsed.records[2].row.success).toBe(false);

    expect(serializeSubtaskCsv(parsed)).toBe(SAMPLE_CSV);
    expect(serializeSubtaskRows(parsed.records.map((r) => r.row))).toBe(
      SAMPLE_CSV,
    );
  });

  it("preserves CRLF and missing trailing newline on untouched round-trip", () => {
    const crlfNoTrail = SAMPLE_CSV.trimEnd().replace(/\n/g, "\r\n");
    const parsed = parseSubtaskCsv(crlfNoTrail);
    expect(serializeSubtaskCsv(parsed)).toBe(crlfNoTrail);
  });

  it("produces byte-identical CSV when merging an unchanged episode", () => {
    const parsed = parseSubtaskCsv(SAMPLE_CSV);
    const ep0Rows = parsed.records
      .filter((r) => r.row.episode_index === 0)
      .map((r) => r.row);

    const merged = mergeEpisodeIntoCsv(SAMPLE_CSV, 0, ep0Rows, {
      repoId: "Xense/egg_carton",
      revision: "4b03b879c274e11040d2ad882b56172354d0cb9d",
    });

    expect(merged.changedRowCount).toBe(0);
    expect(merged.csvText).toBe(SAMPLE_CSV);
  });

  it("marks only changed rows as annotator=human and keeps all other rows byte-identical", () => {
    const threeStageCsv = [
      "repo_id,revision,episode_index,subtask,start,end,contact,grasp,success,annotator,note",
      "Xense/task,local,0,stage_a,0,100,,,true,agent,",
      "Xense/task,local,0,stage_b,100,200,120,130,true,agent,",
      "Xense/task,local,0,stage_c,200,300,210,220,true,converted,untouched row",
      "Xense/task,local,1,stage_a,0,150,,,true,converted,",
      "",
    ].join("\n");

    const parsed = parseSubtaskCsv(threeStageCsv);
    const ep0 = parsed.records
      .filter((r) => r.row.episode_index === 0)
      .map((r) => ({ ...r.row }));

    // Move boundary between stage_a and stage_b from 100 -> 110; leave stage_c untouched.
    ep0[0].end = 110;
    ep0[1].start = 110;

    const merged = mergeEpisodeIntoCsv(threeStageCsv, 0, ep0, {
      repoId: "Xense/task",
      revision: "local",
    });

    expect(merged.changedRowCount).toBe(2);
    const beforeLines = threeStageCsv.split("\n");
    const afterLines = merged.csvText.split("\n");

    expect(afterLines[0]).toBe(beforeLines[0]);
    expect(afterLines[1]).toBe(
      "Xense/task,local,0,stage_a,0,110,,,true,human,",
    );
    expect(afterLines[2]).toBe(
      "Xense/task,local,0,stage_b,110,200,120,130,true,human,",
    );
    // stage_c and episode 1 remain byte-for-byte identical.
    expect(afterLines[3]).toBe(beforeLines[3]);
    expect(afterLines[4]).toBe(beforeLines[4]);
    expect(afterLines[5]).toBe(beforeLines[5]);
  });

  it("rewrites only the toggled row when changing success or note", () => {
    const parsed = parseSubtaskCsv(SAMPLE_CSV);
    const ep0 = parsed.records
      .filter((r) => r.row.episode_index === 0)
      .map((r) => ({ ...r.row }));
    ep0[0].success = false;

    const merged = mergeEpisodeIntoCsv(SAMPLE_CSV, 0, ep0, {
      repoId: "Xense/egg_carton",
      revision: "4b03b879c274e11040d2ad882b56172354d0cb9d",
    });

    expect(merged.changedRowCount).toBe(1);
    const beforeLines = SAMPLE_CSV.split("\n");
    const afterLines = merged.csvText.split("\n");
    expect(afterLines[1]).toBe(
      "Xense/egg_carton,4b03b879c274e11040d2ad882b56172354d0cb9d,0,open_carton,0,900,,120,false,human,",
    );
    expect(afterLines[2]).toBe(beforeLines[2]);
    expect(afterLines[3]).toBe(beforeLines[3]);
    expect(afterLines[4]).toBe(beforeLines[4]);
  });

  it("inserts a brand-new episode in sorted episode_index order without disturbing other lines", () => {
    const baseCsv = [
      "repo_id,revision,episode_index,subtask,start,end,contact,grasp,success,annotator,note",
      "Xense/task,local,0,open_carton,0,100,,,true,converted,",
      "Xense/task,local,5,open_carton,0,120,,,true,converted,",
      "",
    ].join("\n");

    const ep2Rows: SubtaskAnnotationRow[] = [
      {
        repo_id: "Xense/task",
        revision: "local",
        episode_index: 2,
        subtask: "open_carton",
        start: 0,
        end: 80,
        contact: 20,
        grasp: 30,
        success: true,
        annotator: "converted",
        note: "",
      },
    ];

    const merged = mergeEpisodeIntoCsv(baseCsv, 2, ep2Rows, {
      repoId: "Xense/task",
      revision: "local",
    });

    expect(merged.changedRowCount).toBe(1);
    expect(merged.csvText).toBe(
      [
        "repo_id,revision,episode_index,subtask,start,end,contact,grasp,success,annotator,note",
        "Xense/task,local,0,open_carton,0,100,,,true,converted,",
        "Xense/task,local,2,open_carton,0,80,20,30,true,human,",
        "Xense/task,local,5,open_carton,0,120,,,true,converted,",
        "",
      ].join("\n"),
    );
  });

  it("creates a new canonical CSV file when none exists yet", () => {
    const ep0Rows: SubtaskAnnotationRow[] = [
      {
        repo_id: "Xense/task",
        revision: "local",
        episode_index: 0,
        subtask: "open_carton",
        start: 0,
        end: 100,
        contact: null,
        grasp: 45,
        success: true,
        annotator: "agent",
        note: "",
      },
    ];

    const merged = mergeEpisodeIntoCsv(null, 0, ep0Rows, {
      repoId: "Xense/task",
      revision: "local",
    });

    expect(merged.changedRowCount).toBe(1);
    expect(merged.updatedRows[0].annotator).toBe("human");
    expect(merged.csvText).toBe(
      [
        "repo_id,revision,episode_index,subtask,start,end,contact,grasp,success,annotator,note",
        "Xense/task,local,0,open_carton,0,100,,45,true,human,",
        "",
      ].join("\n"),
    );
  });

  it("previews draft annotator transitions accurately", () => {
    const parsed = parseSubtaskCsv(SAMPLE_CSV);
    const prev = parsed.records
      .filter((r) => r.row.episode_index === 0)
      .map((r) => r.row);
    const draft = prev.map((r) => ({ ...r }));
    draft[1].grasp = 970;

    const preview = resolveDraftAnnotators(prev, draft);
    expect(preview.changedIndices.has(0)).toBe(false);
    expect(preview.changedIndices.has(1)).toBe(true);
    expect(preview.rows[0].annotator).toBe("converted");
    expect(preview.rows[1].annotator).toBe("human");
    expect(preview.previousAnnotators).toEqual(["converted", "agent"]);
  });

  it("marks all rows of the current episode reviewed (annotator=human) while leaving other columns and other episodes byte-for-byte identical", () => {
    const parsed = parseSubtaskCsv(SAMPLE_CSV);
    const ep0 = parsed.records
      .filter((r) => r.row.episode_index === 0)
      .map((r) => ({ ...r.row }));

    expect(isEpisodeRowsReviewed(ep0)).toBe(false);

    // Mark episode 0 reviewed in draft (without modifying any boundary/column)
    const reviewedDraft = markEpisodeRowsReviewed(ep0);
    expect(isEpisodeRowsReviewed(reviewedDraft)).toBe(true);

    // Draft preview marks both non-human rows dirty and tracks previous annotators for UI preview
    const preview = resolveDraftAnnotators(ep0, reviewedDraft);
    expect([...preview.changedIndices]).toEqual([0, 1]);
    expect(preview.rows.map((r) => r.annotator)).toEqual(["human", "human"]);
    expect(preview.previousAnnotators).toEqual(["converted", "agent"]);

    // Reverting draft back to persisted rows before save clears all dirty changes cleanly
    const revertedPreview = resolveDraftAnnotators(ep0, ep0);
    expect(revertedPreview.changedIndices.size).toBe(0);
    expect(revertedPreview.rows.map((r) => r.annotator)).toEqual([
      "converted",
      "agent",
    ]);

    // Saving reviewed draft rewrites episode 0 rows with annotator=human only; episode 1 stays byte-identical
    const merged = mergeEpisodeIntoCsv(SAMPLE_CSV, 0, preview.rows, {
      repoId: "Xense/egg_carton",
      revision: "4b03b879c274e11040d2ad882b56172354d0cb9d",
    });

    expect(merged.changedRowCount).toBe(2);
    const beforeLines = SAMPLE_CSV.split("\n");
    const afterLines = merged.csvText.split("\n");
    expect(afterLines[0]).toBe(beforeLines[0]);
    expect(afterLines[1]).toBe(
      "Xense/egg_carton,4b03b879c274e11040d2ad882b56172354d0cb9d,0,open_carton,0,900,,120,true,human,",
    );
    expect(afterLines[2]).toBe(
      'Xense/egg_carton,4b03b879c274e11040d2ad882b56172354d0cb9d,0,place_eggs,900,2779,940,960,true,human,"note with, comma and ""quotes"""',
    );
    // Episode 1 rows and trailing newline remain byte-for-byte identical
    expect(afterLines[3]).toBe(beforeLines[3]);
    expect(afterLines[4]).toBe(beforeLines[4]);
    expect(afterLines[5]).toBe(beforeLines[5]);

    // Progress summary reflects episode 0 reviewed, episode 1 still unreviewed
    const afterParsed = parseSubtaskCsv(merged.csvText);
    expect(
      summarizeSubtaskReviewProgress(afterParsed.records.map((r) => r.row)),
    ).toEqual({
      annotatedEpisodes: [0, 1],
      reviewedEpisodes: [0],
    });

    // Re-saving an already reviewed episode produces 0 changes and byte-identical CSV
    const reMerged = mergeEpisodeIntoCsv(
      merged.csvText,
      0,
      merged.updatedRows,
      {
        repoId: "Xense/egg_carton",
        revision: "4b03b879c274e11040d2ad882b56172354d0cb9d",
      },
    );
    expect(reMerged.changedRowCount).toBe(0);
    expect(reMerged.csvText).toBe(merged.csvText);
  });
});
