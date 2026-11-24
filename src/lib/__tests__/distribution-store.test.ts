import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadDistributionState,
  resolveDistributionArtifactPaths,
} from "../distribution-store";
import { buildDistributionCommand } from "../lerobot-check-runner";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xense-dist-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const FIXTURE_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "utils",
  "__tests__",
  "fixtures",
  "distribution.example.json",
);

describe("distribution-store", () => {
  it("reports missing and malformed distribution.json cleanly and loads valid files", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(root, "Synthetic", "demo");
    await fs.mkdir(datasetDir, { recursive: true });

    const missing = await loadDistributionState(datasetDir, {
      localDatasetRoot: root,
      env: {},
    });
    expect(missing.exists).toBe(false);
    expect(missing.distribution).toBeNull();
    expect(missing.cli.configured).toBe(false);
    expect(missing.cli.command).toContain("lerobot-check distribution");
    expect(missing.cli.command).toContain("--repo-id Synthetic/demo");

    const paths = await resolveDistributionArtifactPaths(datasetDir, {
      localDatasetRoot: root,
    });
    await fs.mkdir(path.dirname(paths.distributionPath), { recursive: true });
    await fs.writeFile(paths.distributionPath, "{broken", "utf-8");

    const malformed = await loadDistributionState(datasetDir, {
      localDatasetRoot: root,
      env: {},
    });
    expect(malformed.exists).toBe(true);
    expect(malformed.distribution).toBeNull();
    expect(malformed.fileError).toContain("Malformed distribution.json");

    const fixtureText = await fs.readFile(FIXTURE_PATH, "utf-8");
    await fs.writeFile(paths.distributionPath, fixtureText, "utf-8");

    const loaded = await loadDistributionState(datasetDir, {
      localDatasetRoot: root,
      env: { LEROBOT_CHECK_DIR: "/opt/lerobot-check" },
    });
    expect(loaded.exists).toBe(true);
    expect(loaded.fileError).toBeNull();
    expect(loaded.distribution?.provenance.repo_id).toBe("Synthetic/demo");
    expect(loaded.cli.configured).toBe(true);
    expect(loaded.cli.command).toContain(
      "uv run --project /opt/lerobot-check lerobot-check distribution",
    );
  });

  it("builds distribution CLI command with exact --dataset-root and --repo-id flags", () => {
    const cmd = buildDistributionCommand("/data/Xense/demo", "Xense/demo", {
      LEROBOT_CHECK_DIR: "/opt/lerobot-check",
    });
    expect(cmd.configured).toBe(true);
    expect(cmd.command).toBe(
      "uv run --project /opt/lerobot-check lerobot-check distribution --dataset-root /data/Xense/demo --repo-id Xense/demo",
    );
  });
});
