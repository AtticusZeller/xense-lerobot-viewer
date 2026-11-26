import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { resolveCollectionArtifactPaths } from "@/lib/collection-store";
import type { CollectionPlan } from "@/types/collection.types";
import example from "@/utils/__tests__/fixtures/collection-plan.example.json";
import { parseCollectionPlan } from "@/utils/collectionData";
import { encodeLocalDatasetPath } from "@/utils/datasetRoute";
import { GET, POST } from "../route";

let root: string;
let encodedPath: string;
let planPath: string;
let plan: CollectionPlan;
const previousRoot = process.env.LOCAL_DATASET_ROOT;
const previousCheck = process.env.LEROBOT_CHECK_DIR;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "collection-plan-route-"));
  process.env.LOCAL_DATASET_ROOT = root;
  delete process.env.LEROBOT_CHECK_DIR;
  const dataset = path.join(root, "org", "demo");
  await fs.mkdir(path.join(dataset, "meta"), { recursive: true });
  await fs.writeFile(path.join(dataset, "meta", "info.json"), "{}");
  encodedPath = encodeLocalDatasetPath(dataset);
  const paths = await resolveCollectionArtifactPaths(dataset);
  planPath = paths.planPath;
  const head = JSON.stringify({
    version: 1,
    repo_id: example.repo_id,
    revision: example.revision,
    camera: example.camera,
    image_size: example.image_size,
    intrinsics: {
      version: 1,
      camera: example.camera,
      image_size: example.image_size,
      fx: 600,
      fy: 600,
      cx: 320,
      cy: 240,
      distortion: [0, 0, 0, 0, 0],
    },
    arms: {},
  });
  await fs.mkdir(path.dirname(paths.headPath), { recursive: true });
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(paths.headPath, head);
  plan = parseCollectionPlan(JSON.stringify(example));
  plan.calibration_sha256 = createHash("sha256").update(head).digest("hex");
});

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  if (previousCheck === undefined) delete process.env.LEROBOT_CHECK_DIR;
  else process.env.LEROBOT_CHECK_DIR = previousCheck;
  await fs.rm(root, { recursive: true, force: true });
});

function post(payload: unknown) {
  return POST(
    new NextRequest("http://localhost/plan", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ encodedPath }) },
  );
}

function get(generation: number) {
  return GET(
    new NextRequest(
      `http://localhost/plan?planId=${plan.plan_id}&generation=${generation}`,
    ),
    { params: Promise.resolve({ encodedPath }) },
  );
}

describe("collection plan endpoint", () => {
  it("exports the exact bytes for the reviewed generation, including current progress", async () => {
    const progress = structuredClone(plan);
    progress.rounds[0].status = "collected";
    progress.rounds[0].episode_index = 100;
    const raw = JSON.stringify(progress, null, 2) + "\n";
    await fs.writeFile(planPath, raw);
    const exported = await get(plan.generation);
    expect(exported.status).toBe(200);
    expect(await exported.text()).toBe(raw);
    expect((await get(plan.generation + 1)).status).toBe(409);
    await fs.writeFile(
      planPath,
      JSON.stringify({ ...progress, calibration_sha256: "b".repeat(64) }),
    );
    expect((await get(plan.generation)).status).toBe(409);
  });

  it("validates edit identity and exposes safe standalone CLI commands", async () => {
    expect((await post({ action: "replace", roundId: 2 })).status).toBe(400);
    expect(
      (
        await post({
          action: "delete",
          roundId: 2.1,
          planId: plan.plan_id,
          generation: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          action: "generate",
          roundCount: 501,
          objectsPerRound: 3,
          planId: null,
          generation: null,
        })
      ).status,
    ).toBe(400);
    for (const [action, subcommand] of [
      ["replace", "--replace-round 2"],
      ["delete", "--round-id 2"],
    ]) {
      const response = await post({
        action,
        roundId: 2,
        planId: plan.plan_id,
        generation: 1,
      });
      expect(response.status).toBe(503);
      const result = await response.json();
      expect(result.command).toContain(subcommand);
      expect(result.command).toContain(
        `--expect-plan-id ${plan.plan_id} --expect-generation 1`,
      );
    }
    const first = await post({
      action: "generate",
      roundCount: 8,
      objectsPerRound: 3,
      planId: null,
      generation: null,
    });
    expect(first.status).toBe(503);
    expect((await first.json()).command).toContain(
      "--rounds 8 --objects-per-round 3 --expect-missing",
    );
  });
});
