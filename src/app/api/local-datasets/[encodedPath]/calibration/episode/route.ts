import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import { loadCalibrationEpisodeMedia } from "@/lib/calibration-store";

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

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const episode = Number(request.nextUrl.searchParams.get("episode"));
  if (!Number.isInteger(episode) || episode < 0) {
    return Response.json(
      { error: "episode must be a non-negative integer" },
      { status: 400 },
    );
  }

  const camera =
    request.nextUrl.searchParams.get("camera") || "observation.images.head";
  const includeTcp = request.nextUrl.searchParams.get("includeTcp") === "1";

  const datasetDir = await resolveExistingDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  try {
    const media = await loadCalibrationEpisodeMedia(
      datasetDir,
      encodedPath,
      episode,
      { camera, includeTcp },
    );
    if (!media) {
      return Response.json(
        { error: `Episode ${episode} not found` },
        { status: 404 },
      );
    }
    return Response.json(media);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to load episode calibration media",
      },
      { status: 500 },
    );
  }
}
