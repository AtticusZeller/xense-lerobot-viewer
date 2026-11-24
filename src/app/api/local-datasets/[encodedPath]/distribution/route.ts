import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import { getDistributionReportStatus } from "@/lib/subtask-annotations-store";

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
    const status = await getDistributionReportStatus(datasetDir, encodedPath);
    return Response.json(status);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to check distribution report",
      },
      { status: 500 },
    );
  }
}
