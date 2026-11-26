import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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
import suggestions from "@/utils/__tests__/fixtures/suggestions.example.json";

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

  it("serves only a complete mask bundle for the exact calibration and suggestions", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(root, "Synthetic", "demo");
    await fs.mkdir(datasetDir, { recursive: true });
    const options = { localDatasetRoot: root, env: {} };
    const paths = await resolveCollectionArtifactPaths(datasetDir, options);
    const camera = "observation.images.head";
    const image_size = [640, 480];
    const head = JSON.stringify({
      version: 1,
      repo_id: paths.repoId,
      revision: paths.revision,
      camera,
      image_size,
      intrinsics: {
        version: 1,
        camera,
        image_size,
        fx: 600,
        fy: 600,
        cx: 320,
        cy: 240,
        distortion: [0, 0, 0, 0, 0],
      },
      arms: {},
    });
    const suggestionText = JSON.stringify({
      ...suggestions,
      provenance: {
        ...suggestions.provenance,
        repo_id: paths.repoId,
        revision: paths.revision,
      },
    });
    for (const [file, content] of [
      [paths.headPath, head],
      [paths.suggestionsPath, suggestionText],
    ]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
    const digest = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const targets = [
      ...suggestions.placements.map((item) => ({ ...item, kind: "placement" })),
      ...suggestions.test_points.map((item) => ({
        ...item,
        kind: "test_point",
      })),
    ].map(({ kind, object, index, tier, pixel, arrow_end_pixel }, i) => ({
      kind,
      object,
      index,
      tier,
      pixel,
      arrow_end_pixel,
      outline:
        i === 0
          ? [
              [311, 200],
              [330, 207],
              [316, 219],
            ]
          : null,
      reason: i === 0 ? null : "No reviewed outline",
    }));
    const bundle = {
      version: 1,
      repo_id: paths.repoId,
      revision: paths.revision,
      camera,
      image_size,
      calibration_sha256: digest(head),
      suggestions_sha256: digest(suggestionText),
      sources: {},
      targets,
    };
    expect(
      (await loadCollectionState(datasetDir, options)).masksError,
    ).toBeNull();
    await fs.mkdir(path.dirname(paths.masksPath), { recursive: true });
    await fs.writeFile(paths.masksPath, JSON.stringify(bundle));
    expect((await loadCollectionState(datasetDir, options)).masks).toEqual(
      bundle,
    );
    await fs.writeFile(
      paths.masksPath,
      JSON.stringify({ ...bundle, image_size: [660, 480] }),
    );
    expect((await loadCollectionState(datasetDir, options)).masksError).toBe(
      "imageMismatch",
    );
    await fs.writeFile(
      paths.masksPath,
      JSON.stringify({ ...bundle, targets: targets.slice(1) }),
    );
    expect((await loadCollectionState(datasetDir, options)).masksError).toBe(
      "invalid",
    );
    await fs.writeFile(paths.masksPath, JSON.stringify(bundle));
    await fs.appendFile(paths.suggestionsPath, "\n");
    const stale = await loadCollectionState(datasetDir, options);
    expect(stale.masks).toBeNull();
    expect(stale.masksError).toBe("stale");
    expect(stale.suggestions?.placements).toHaveLength(
      suggestions.placements.length,
    );
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
