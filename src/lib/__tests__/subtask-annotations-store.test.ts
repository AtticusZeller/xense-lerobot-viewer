import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectDatasetRevision,
  resolveSubtaskArtifactPaths,
} from "../subtask-annotations-store";

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
});
