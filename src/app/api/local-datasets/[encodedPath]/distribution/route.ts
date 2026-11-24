import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { loadDistributionState } from "@/lib/distribution-store";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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

  try {
    const state = await loadDistributionState(datasetDir);
    return Response.json(state);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to load distribution state",
      },
      { status: 500 },
    );
  }
}
