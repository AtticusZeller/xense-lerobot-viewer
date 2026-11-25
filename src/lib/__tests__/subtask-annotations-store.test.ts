import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectDatasetRevision,
  loadEpisodeSubtaskState,
  resolveSubtaskArtifactPaths,
  saveEpisodeSubtaskRows,
} from "../subtask-annotations-store";
import { markEpisodeRowsReviewed } from "@/utils/subtaskCsv";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xense-subtask-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("subtask-annotations-store", () => {
  it("detects unique 40-char commit sha from .cache/huggingface/trees, otherwise local", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(root, "Xense", "egg_carton");
    const treesDir = path.join(datasetDir, ".cache", "huggingface", "trees");
    await fs.mkdir(treesDir, { recursive: true });

    expect(await detectDatasetRevision(datasetDir)).toBe("local");

    const sha = "4b03b879c274e11040d2ad882b56172354d0cb9d";
    await fs.writeFile(path.join(treesDir, `${sha}.json`), "{}", "utf-8");
    expect(await detectDatasetRevision(datasetDir)).toBe(sha);

    // Non-40-char json files are ignored, matching lerobot-check.
    await fs.writeFile(path.join(treesDir, "short.json"), "{}", "utf-8");
    expect(await detectDatasetRevision(datasetDir)).toBe(sha);

    // Multiple 40-char tree files fall back to local.
    const sha2 = "0000000000000000000000000000000000000001";
    await fs.writeFile(path.join(treesDir, `${sha2}.json`), "{}", "utf-8");
    expect(await detectDatasetRevision(datasetDir)).toBe("local");
  });

  it("resolves shared .xense-viewer paths for CSV, task spec, and report HTML", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(
      root,
      "Xense",
      "bi_elite_cs66_rt_egg_carton_to_tray_1016_fixed",
    );
    const sha = "4b03b879c274e11040d2ad882b56172354d0cb9d";
    await fs.mkdir(path.join(datasetDir, ".cache", "huggingface", "trees"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(datasetDir, ".cache", "huggingface", "trees", `${sha}.json`),
      "{}",
      "utf-8",
    );

    const paths = await resolveSubtaskArtifactPaths(datasetDir, {
      localDatasetRoot: root,
    });

    expect(paths.repoId).toBe(
      "Xense/bi_elite_cs66_rt_egg_carton_to_tray_1016_fixed",
    );
    expect(paths.revision).toBe(sha);
    expect(paths.csvPath).toBe(
      path.join(
        root,
        ".xense-viewer",
        "subtasks",
        `Xense__bi_elite_cs66_rt_egg_carton_to_tray_1016_fixed@${sha}.csv`,
      ),
    );
    expect(paths.taskSpecPath).toBe(
      path.join(
        root,
        ".xense-viewer",
        "subtasks",
        "Xense__bi_elite_cs66_rt_egg_carton_to_tray_1016_fixed.task_spec.yaml",
      ),
    );
  });

  it("saves a reviewed episode atomically, updates reviewProgress, and preserves other episodes byte-for-byte", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(root, "Xense", "pack_box");
    const subtasksDir = path.join(root, ".xense-viewer", "subtasks");
    await fs.mkdir(datasetDir, { recursive: true });
    await fs.mkdir(subtasksDir, { recursive: true });

    const initialCsv = [
      "repo_id,revision,episode_index,subtask,start,end,contact,grasp,success,annotator,note",
      "Xense/pack_box,local,0,pick_insert,0,120,40,60,true,agent,auto note",
      "Xense/pack_box,local,0,place_phone,120,250,150,170,true,agent,",
      'Xense/pack_box,local,1,pick_insert,0,100,20,30,true,agent,"quoted, ""untouched"""',
      "",
    ].join("\n");
    const csvPath = path.join(subtasksDir, "Xense__pack_box@local.csv");
    await fs.writeFile(csvPath, initialCsv, "utf-8");

    const before = await loadEpisodeSubtaskState(datasetDir, 0, {
      localDatasetRoot: root,
    });
    expect(before.reviewProgress).toEqual({
      annotatedEpisodes: [0, 1],
      reviewedEpisodes: [],
    });

    const reviewedRows = markEpisodeRowsReviewed(before.rows);
    const saved = await saveEpisodeSubtaskRows(datasetDir, 0, reviewedRows, {
      localDatasetRoot: root,
    });

    expect(saved.changedRowCount).toBe(2);
    expect(saved.payload.reviewProgress).toEqual({
      annotatedEpisodes: [0, 1],
      reviewedEpisodes: [0],
    });
    expect(saved.payload.rows.map((r) => r.annotator)).toEqual([
      "human",
      "human",
    ]);

    const afterCsv = await fs.readFile(csvPath, "utf-8");
    const beforeLines = initialCsv.split("\n");
    const afterLines = afterCsv.split("\n");
    expect(afterLines[0]).toBe(beforeLines[0]);
    expect(afterLines[1]).toBe(
      "Xense/pack_box,local,0,pick_insert,0,120,40,60,true,human,auto note",
    );
    expect(afterLines[2]).toBe(
      "Xense/pack_box,local,0,place_phone,120,250,150,170,true,human,",
    );
    expect(afterLines[3]).toBe(beforeLines[3]);
    expect(afterLines[4]).toBe(beforeLines[4]);

    const files = await fs.readdir(subtasksDir);
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});
