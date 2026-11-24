import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import {
  loadCollectionState,
  resolveCollectionArtifactPaths,
} from "@/lib/collection-store";
import { getActiveSuggestRun, runSuggestCli } from "@/lib/lerobot-check-runner";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveExistingDatasetDir(
  encodedPath: string,
): Promise<string | null> {
  const dir = resolveDatasetRoot(encodedPath);
  if (!dir) return null;
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = await resolveExistingDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  let body: { count?: unknown; testPerTier?: unknown; seed?: unknown } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) {
      body = JSON.parse(raw) as typeof body;
    }
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const count =
    body.count === undefined || body.count === null ? 10 : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    return Response.json(
      { error: "count must be an integer between 1 and 500" },
      { status: 400 },
    );
  }

  const testPerTier =
    body.testPerTier === undefined || body.testPerTier === null
      ? 3
      : Number(body.testPerTier);
  if (!Number.isInteger(testPerTier) || testPerTier < 0 || testPerTier > 100) {
    return Response.json(
      { error: "testPerTier must be an integer between 0 and 100" },
      { status: 400 },
    );
  }

  let seed: number | undefined;
  if (body.seed !== undefined && body.seed !== null) {
    const parsedSeed = Number(body.seed);
    if (!Number.isInteger(parsedSeed)) {
      return Response.json(
        { error: "seed must be an integer" },
        { status: 400 },
      );
    }
    seed = parsedSeed;
  }

  if (getActiveSuggestRun(datasetDir)) {
    return Response.json(
      { error: "lerobot-check suggest is already running for this dataset" },
      { status: 409 },
    );
  }

  try {
    const paths = await resolveCollectionArtifactPaths(datasetDir);
    const exec = await runSuggestCli({
      datasetDir,
      repoId: paths.repoId,
      count,
      testPerTier,
      seed,
    });
    const state = await loadCollectionState(datasetDir);

    if (!exec.configured) {
      return Response.json({ ...exec, state }, { status: 503 });
    }
    if (!exec.ok) {
      return Response.json({ ...exec, state }, { status: 502 });
    }
    return Response.json({ ...exec, state });
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to run lerobot-check suggest",
      },
      { status: 500 },
    );
  }
}
