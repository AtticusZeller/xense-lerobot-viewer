import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadCalibrationEpisodeMedia,
  loadCalibrationState,
  resolveCalibrationArtifactPaths,
  saveCalibrationPoints,
} from "../calibration-store";
import { buildCalibrationCliInvocation } from "../lerobot-check-runner";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xense-calib-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const SAMPLE_TCP = [0.2, -0.1, 0.3, 1, 0, 0, 0, 1, 0];

describe("calibration-store", () => {
  it("handles missing and malformed files gracefully without throwing", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(root, "Xense", "pack_iphone_box_1119");
    await fs.mkdir(datasetDir, { recursive: true });

    const missing = await loadCalibrationState(datasetDir, {
      localDatasetRoot: root,
      env: {},
    });
    expect(missing.framesExists).toBe(false);
    expect(missing.pointsExists).toBe(false);
    expect(missing.headExists).toBe(false);
    expect(missing.intrinsicsExists).toBe(false);
    expect(missing.frames).toEqual([]);
    expect(missing.cli.configured).toBe(false);
    expect(missing.cli.commands.appendFrames).toContain("calib-frames");
    expect(missing.cli.commands.appendFrames).toContain("--append 5");
    expect(missing.cli.commands.calibrate).toContain("calibrate");

    // Write malformed head.json and intrinsics.json; loader surfaces per-file errors cleanly.
    const paths = await resolveCalibrationArtifactPaths(datasetDir, {
      localDatasetRoot: root,
    });
    await fs.mkdir(paths.calibDir, { recursive: true });
    await fs.writeFile(paths.headPath, "{broken", "utf-8");
    await fs.writeFile(paths.intrinsicsPath, "[]", "utf-8");

    const withErrors = await loadCalibrationState(datasetDir, {
      localDatasetRoot: root,
      env: {},
    });
    expect(withErrors.headExists).toBe(true);
    expect(withErrors.head).toBeNull();
    expect(withErrors.headFileError).toContain("Malformed head.json");
    expect(withErrors.intrinsicsExists).toBe(true);
    expect(withErrors.intrinsics).toBeNull();
    expect(withErrors.intrinsicsFileError).toContain(
      "root must be a JSON object",
    );
  });

  it("writes points.json atomically, merges appended frames.json by id, and never modifies read-only files", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(root, "Xense", "pack_iphone_box_1119");
    await fs.mkdir(datasetDir, { recursive: true });

    const paths = await resolveCalibrationArtifactPaths(datasetDir, {
      localDatasetRoot: root,
    });
    await fs.mkdir(paths.calibDir, { recursive: true });

    const framesV1 = JSON.stringify(
      {
        version: 1,
        repo_id: "Xense/pack_iphone_box_1119",
        revision: "local",
        camera: "observation.images.head",
        image_size: [640, 480],
        frames: [
          {
            id: "left-000",
            arm: "left",
            episode_index: 0,
            frame_index: 30,
            tcp: SAMPLE_TCP,
          },
          {
            id: "right-000",
            arm: "right",
            episode_index: 1,
            frame_index: 60,
            tcp: SAMPLE_TCP,
          },
        ],
      },
      null,
      2,
    );
    await fs.writeFile(paths.framesPath, framesV1, "utf-8");

    const saved1 = await saveCalibrationPoints(
      datasetDir,
      [{ id: "left-000", pixel: [305.5, 220.0] }],
      { localDatasetRoot: root, env: {} },
    );
    expect(saved1.pointsExists).toBe(true);
    expect(saved1.frames[0].pixel).toEqual([305.5, 220.0]);
    expect(saved1.frames[1].pixel).toBeUndefined();

    // frames.json must remain byte-identical.
    expect(await fs.readFile(paths.framesPath, "utf-8")).toBe(framesV1);

    // Append a new frame to frames.json, then save an update for right-000 only.
    const framesV2 = JSON.stringify(
      {
        version: 1,
        repo_id: "Xense/pack_iphone_box_1119",
        revision: "local",
        camera: "observation.images.head",
        image_size: [640, 480],
        frames: [
          {
            id: "left-000",
            arm: "left",
            episode_index: 0,
            frame_index: 30,
            tcp: SAMPLE_TCP,
          },
          {
            id: "right-000",
            arm: "right",
            episode_index: 1,
            frame_index: 60,
            tcp: SAMPLE_TCP,
          },
          {
            id: "left-001",
            arm: "left",
            episode_index: 2,
            frame_index: 90,
            tcp: SAMPLE_TCP,
          },
        ],
      },
      null,
      2,
    );
    await fs.writeFile(paths.framesPath, framesV2, "utf-8");

    const saved2 = await saveCalibrationPoints(
      datasetDir,
      [{ id: "right-000", skipped: true }],
      { localDatasetRoot: root, env: {} },
    );
    expect(saved2.frames.map((f) => f.id)).toEqual([
      "left-000",
      "right-000",
      "left-001",
    ]);
    // Untouched left-000 pixel preserved, right-000 skipped, new left-001 present.
    expect(saved2.frames[0].pixel).toEqual([305.5, 220.0]);
    expect(saved2.frames[1].skipped).toBe(true);
    expect(saved2.frames[2].pixel).toBeUndefined();
    expect(saved2.frames[2].skipped).toBeUndefined();

    // Verify no leftover temp files in calib directory.
    const files = await fs.readdir(paths.calibDir);
    expect(files.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("surfaces mergeNotice when frames.json is regenerated with different frames or revision", async () => {
    const root = await makeTempDir();
    const datasetDir = path.join(root, "Xense", "pack_iphone_box_1119");
    await fs.mkdir(datasetDir, { recursive: true });
    const paths = await resolveCalibrationArtifactPaths(datasetDir, {
      localDatasetRoot: root,
    });
    await fs.mkdir(paths.calibDir, { recursive: true });

    await fs.writeFile(
      paths.pointsPath,
      JSON.stringify({
        version: 1,
        repo_id: "Xense/pack_iphone_box_1119",
        revision: "rev-a",
        camera: "observation.images.head",
        image_size: [640, 480],
        frames: [
          {
            id: "left-000",
            arm: "left",
            episode_index: 12,
            frame_index: 340,
            tcp: SAMPLE_TCP,
            pixel: [100, 200],
          },
        ],
      }),
      "utf-8",
    );

    // Same revision, regenerated frame under left-000 -> drop stale click and surface notice.
    await fs.writeFile(
      paths.framesPath,
      JSON.stringify({
        version: 1,
        repo_id: "Xense/pack_iphone_box_1119",
        revision: "rev-a",
        camera: "observation.images.head",
        image_size: [640, 480],
        frames: [
          {
            id: "left-000",
            arm: "left",
            episode_index: 77,
            frame_index: 9,
            tcp: SAMPLE_TCP,
          },
        ],
      }),
      "utf-8",
    );

    const frameMismatchState = await loadCalibrationState(datasetDir, {
      localDatasetRoot: root,
      env: {},
    });
    expect(frameMismatchState.frames[0].pixel).toBeUndefined();
    expect(frameMismatchState.mergeNotice.droppedFrameMismatchCount).toBe(1);
    expect(frameMismatchState.mergeNotice.droppedFrameMismatchIds).toEqual([
      "left-000",
    ]);

    // Different revision -> refuse to merge annotations and surface identity mismatch notice.
    await fs.writeFile(
      paths.framesPath,
      JSON.stringify({
        version: 1,
        repo_id: "Xense/pack_iphone_box_1119",
        revision: "rev-b",
        camera: "observation.images.head",
        image_size: [640, 480],
        frames: [
          {
            id: "left-000",
            arm: "left",
            episode_index: 12,
            frame_index: 340,
            tcp: SAMPLE_TCP,
          },
        ],
      }),
      "utf-8",
    );

    const revMismatchState = await loadCalibrationState(datasetDir, {
      localDatasetRoot: root,
      env: {},
    });
    expect(revMismatchState.frames[0].pixel).toBeUndefined();
    expect(revMismatchState.mergeNotice.fileIdentityMismatch).toEqual({
      framesRepoId: "Xense/pack_iphone_box_1119",
      framesRevision: "rev-b",
      pointsRepoId: "Xense/pack_iphone_box_1119",
      pointsRevision: "rev-a",
    });
    expect(revMismatchState.mergeNotice.droppedByIdentityMismatchCount).toBe(1);
  });

  it("builds uv run --project invocation when LEROBOT_CHECK_DIR is set", () => {
    const configured = buildCalibrationCliInvocation("calib-frames", {
      datasetDir: "/data/Xense/demo",
      repoId: "Xense/demo",
      append: 5,
      env: { LEROBOT_CHECK_DIR: "/opt/lerobot-check" },
    });
    expect(configured.configured).toBe(true);
    expect(configured.bin).toBe("uv");
    expect(configured.args).toEqual([
      "run",
      "--project",
      "/opt/lerobot-check",
      "lerobot-check",
      "calib-frames",
      "--dataset-root",
      "/data/Xense/demo",
      "--repo-id",
      "Xense/demo",
      "--append",
      "5",
    ]);

    const unconfigured = buildCalibrationCliInvocation("calibrate", {
      datasetDir: "/data/Xense/demo",
      repoId: "Xense/demo",
      env: {},
    });
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.displayCommand).toContain("lerobot-check calibrate");
  });

  it("reads episode TCP from a v3 data file that does not start at global index 0", async () => {
    const datasetDir = path.join(
      import.meta.dir,
      "fixtures",
      "v3-two-data-files",
    );
    const media = await loadCalibrationEpisodeMedia(datasetDir, "enc", 1, {
      includeTcp: true,
    });
    expect(media?.episodeLength).toBe(3);
    const left = media?.armsTcp?.left ?? [];
    expect(left).toHaveLength(3);
    expect(left.map((pose) => pose?.[0])).toEqual([10, 11, 12]);

    const first = await loadCalibrationEpisodeMedia(datasetDir, "enc", 0, {
      includeTcp: true,
    });
    expect(first?.armsTcp?.left.map((pose) => pose?.[0])).toEqual([0, 1, 2]);
  });
});
