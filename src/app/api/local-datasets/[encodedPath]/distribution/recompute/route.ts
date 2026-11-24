import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import {
  loadDistributionState,
  resolveDistributionArtifactPaths,
} from "@/lib/distribution-store";
import {
  getActiveDistributionRun,
  runDistributionCli,
} from "@/lib/lerobot-check-runner";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = resolveDatasetRoot(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }
  try {
    if (!(await fs.stat(datasetDir)).isDirectory()) {
      return Response.json({ error: "Dataset not found" }, { status: 404 });
    }
  } catch {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  if (getActiveDistributionRun(datasetDir)) {
    return Response.json(
      { error: "Distribution recompute is already running for this dataset" },
      { status: 409 },
    );
  }

  try {
    const paths = await resolveDistributionArtifactPaths(datasetDir);
    const exec = await runDistributionCli({
      datasetDir,
      repoId: paths.repoId,
    });
    const state = await loadDistributionState(datasetDir);

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
            : "Failed to recompute distribution",
      },
      { status: 500 },
    );
  }
}
