import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import { POST } from "../route";

let tempRoot: string;
let datasetDir: string;
let encoded: string;
let savedLerobotCheckDir: string | undefined;
let savedLocalDatasetRoot: string | undefined;

beforeAll(async () => {
  savedLerobotCheckDir = process.env.LEROBOT_CHECK_DIR;
  savedLocalDatasetRoot = process.env.LOCAL_DATASET_ROOT;
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calib-run-route-"));
  datasetDir = path.join(tempRoot, "Xense", "demo_ds");
  await fs.mkdir(datasetDir, { recursive: true });
  process.env.LOCAL_DATASET_ROOT = tempRoot;
  delete process.env.LEROBOT_CHECK_DIR;
  encoded = encodeLocalDatasetPath(datasetDir);
});

afterAll(async () => {
  if (savedLerobotCheckDir === undefined) {
    delete process.env.LEROBOT_CHECK_DIR;
  } else {
    process.env.LEROBOT_CHECK_DIR = savedLerobotCheckDir;
  }
  if (savedLocalDatasetRoot === undefined) {
    delete process.env.LOCAL_DATASET_ROOT;
  } else {
    process.env.LOCAL_DATASET_ROOT = savedLocalDatasetRoot;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function postJson(payload: unknown) {
  const req = new NextRequest("http://localhost/api/calib/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return POST(req, { params: Promise.resolve({ encodedPath: encoded }) });
}

describe("POST /api/local-datasets/[encodedPath]/calibration/run", () => {
  it("rejects arms when append is omitted or action is calibrate", async () => {
    const noAppend = await postJson({
      action: "calib-frames",
      arms: ["left"],
    });
    expect(noAppend.status).toBe(400);

    const onCalibrate = await postJson({
      action: "calibrate",
      append: 1,
      arms: ["left"],
    });
    expect(onCalibrate.status).toBe(400);
  });

  it("rejects empty arms list, non-array arms, and invalid arm names", async () => {
    const empty = await postJson({
      action: "calib-frames",
      append: 1,
      arms: [],
    });
    expect(empty.status).toBe(400);

    const nonArray = await postJson({
      action: "calib-frames",
      append: 1,
      arms: "left",
    });
    expect(nonArray.status).toBe(400);

    for (const bad of [
      ["left arm"],
      ["left;rm"],
      [""],
      ["left/right"],
      [123],
    ]) {
      const res = await postJson({
        action: "calib-frames",
        append: 1,
        arms: bad,
      });
      expect(res.status).toBe(400);
    }
  });

  it("accepts deduplicated valid arms with append and includes --arms in the CLI command", async () => {
    const res = await postJson({
      action: "calib-frames",
      append: 1,
      arms: ["left", "left", "right_arm-2"],
    });
    // LEROBOT_CHECK_DIR is unset in this test, so runner returns 503 with exact display command.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { configured: boolean; command: string };
    expect(body.configured).toBe(false);
    expect(body.command).toContain("--append 1 --arms left,right_arm-2");
  });
});
