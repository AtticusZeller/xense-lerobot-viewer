import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deleteTargetPolygon,
  loadCollectionState,
  resolveCollectionArtifactPaths,
  saveTargetPolygon,
} from "../collection-store";
import { buildSuggestCommand } from "../lerobot-check-runner";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xense-collect-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("collection-store", () => {
  it("saves, loads, and deletes targets.json atomically and builds suggest CLI command", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(root, "Xense", "pack_iphone_box_1119");
    await fs.mkdir(datasetDir, { recursive: true });

    const initial = await loadCollectionState(datasetDir, {
      localDatasetRoot: root,
      env: {},
    });
    expect(initial.targetsExists).toBe(false);
    expect(initial.suggestionsExists).toBe(false);
    expect(initial.calibration.exists).toBe(false);
    expect(initial.distribution.exists).toBe(false);
    expect(initial.cli.configured).toBe(false);
    expect(initial.cli.suggestCommand).toContain("lerobot-check suggest");

    const saved = await saveTargetPolygon(
      datasetDir,
      {
        version: 1,
        camera: "observation.images.head",
        image_size: [640, 480],
        polygon: [
          [150, 180],
          [490, 180],
          [510, 380],
          [130, 380],
        ],
      },
      {
        localDatasetRoot: root,
        env: { LEROBOT_CHECK_DIR: "/opt/lerobot-check" },
      },
    );
    expect(saved.targetsExists).toBe(true);
    expect(saved.targets?.polygon).toHaveLength(4);
    expect(saved.cli.configured).toBe(true);
    expect(saved.cli.suggestCommand).toContain(
      "uv run --project /opt/lerobot-check lerobot-check suggest",
    );

    const paths = await resolveCollectionArtifactPaths(datasetDir, {
      localDatasetRoot: root,
    });
    const dirFiles = await fs.readdir(path.dirname(paths.targetsPath));
    expect(dirFiles.filter((f) => f.includes(".tmp-"))).toEqual([]);

    const afterDelete = await deleteTargetPolygon(datasetDir, {
      localDatasetRoot: root,
      env: {},
    });
    expect(afterDelete.targetsExists).toBe(false);
    expect(afterDelete.targets).toBeNull();
  });

  it("builds suggest CLI invocation with -n, --test-per-tier, and optional --seed", () => {
    const cmd = buildSuggestCommand("/data/Xense/demo", "Xense/demo", {
      count: 10,
      testPerTier: 3,
      seed: 42,
      env: { LEROBOT_CHECK_DIR: "/opt/lerobot-check" },
    });
    expect(cmd.command).toBe(
      "uv run --project /opt/lerobot-check lerobot-check suggest --dataset-root /data/Xense/demo --repo-id Xense/demo -n 10 --test-per-tier 3 --seed 42",
    );
  });
});
