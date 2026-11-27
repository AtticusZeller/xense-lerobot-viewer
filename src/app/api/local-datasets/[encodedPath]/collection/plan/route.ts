import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  loadCollectionPlanFile,
  resolveCollectionArtifactPaths,
} from "@/lib/collection-store";
import { runCollectionPlanCli } from "@/lib/lerobot-check-runner";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import type {
  CollectionPlanAction,
  CollectionPlanSnapshot,
} from "@/types/collection.types";
import { isPlanId, isPlanInteger } from "@/utils/collectionData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ encodedPath: string }> };

async function datasetDirFor(ctx: Context): Promise<string | null> {
  const datasetDir = resolveDatasetRoot((await ctx.params).encodedPath);
  if (!datasetDir) return null;
  const info = await fs
    .stat(path.join(datasetDir, "meta", "info.json"))
    .catch(() => null);
  return info?.isFile() ? datasetDir : null;
}

function parseAction(body: unknown): {
  edit: CollectionPlanAction;
  snapshot: CollectionPlanSnapshot | null;
} {
  if (!body || typeof body !== "object")
    throw new Error("Invalid plan request");
  const { action, roundCount, objectsPerRound, roundId, planId, generation } =
    body as Record<string, unknown>;
  const snapshot =
    isPlanId(planId) && isPlanInteger(generation)
      ? { plan_id: planId, generation }
      : null;
  const expectsMissing = planId === null && generation === null;
  if (
    action === "generate" &&
    (snapshot || expectsMissing) &&
    isPlanInteger(roundCount) &&
    roundCount <= 500 &&
    isPlanInteger(objectsPerRound)
  ) {
    return { edit: { action, roundCount, objectsPerRound }, snapshot };
  }
  if (
    (action === "replace" || action === "delete") &&
    snapshot &&
    isPlanInteger(roundId)
  ) {
    return { edit: { action, roundId }, snapshot };
  }
  throw new Error("Invalid action, plan generation or round count");
}

export async function GET(
  request: NextRequest,
  ctx: Context,
): Promise<Response> {
  const datasetDir = await datasetDirFor(ctx);
  if (!datasetDir)
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  try {
    const paths = await resolveCollectionArtifactPaths(datasetDir);
    const { raw, plan, error } = await loadCollectionPlanFile(paths);
    if (error)
      return Response.json(
        { error: `Collection plan is ${error}` },
        { status: 409 },
      );
    if (!raw || !plan)
      return Response.json(
        { error: "Collection plan not found" },
        { status: 404 },
      );
    const params = request.nextUrl.searchParams;
    if (
      params.get("planId") !== plan.plan_id ||
      params.get("generation") !== String(plan.generation)
    ) {
      return Response.json(
        {
          error:
            "Collection plan changed; refresh and review the new generation",
        },
        { status: 409 },
      );
    }
    return new Response(raw, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  ctx: Context,
): Promise<Response> {
  const datasetDir = await datasetDirFor(ctx);
  if (!datasetDir)
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  let input: ReturnType<typeof parseAction>;
  try {
    input = parseAction(await request.json());
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 400 });
  }
  try {
    const paths = await resolveCollectionArtifactPaths(datasetDir);
    const result = await runCollectionPlanCli({
      datasetDir,
      repoId: paths.repoId,
      viewerRoot: paths.viewerRoot,
      planPath: paths.planPath,
      ...input,
    });
    const status = result.ok
      ? 200
      : !result.configured
        ? 503
        : result.exitCode === 3
          ? 409
          : 422;
    return Response.json(result, { status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
