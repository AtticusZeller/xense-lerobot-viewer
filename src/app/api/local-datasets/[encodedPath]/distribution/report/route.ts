import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import { readDistributionReportHtml } from "@/lib/subtask-annotations-store";

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

  const report = await readDistributionReportHtml(datasetDir);
  if (!report) {
    return Response.json(
      { error: "Distribution report not found" },
      { status: 404 },
    );
  }

  return new Response(report.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
