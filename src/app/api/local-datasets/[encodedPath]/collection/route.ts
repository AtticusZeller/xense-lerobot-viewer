import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import {
  deleteTargetPolygon,
  loadCollectionState,
  saveTargetPolygon,
} from "@/lib/collection-store";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import type { TargetPolygonFile } from "@/types/collection.types";
import { parseTargetPolygonJson } from "@/utils/collectionData";

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
  _request: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = await resolveExistingDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  try {
    const state = await loadCollectionState(datasetDir);
    return Response.json(state);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to load collection state",
      },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = await resolveExistingDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let validated: TargetPolygonFile;
  try {
    validated = parseTargetPolygonJson(
      JSON.stringify({
        version: 1,
        ...(body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {}),
      }),
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid polygon payload" },
      { status: 400 },
    );
  }

  try {
    const state = await saveTargetPolygon(datasetDir, validated);
    return Response.json(state);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to save target polygon",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = await resolveExistingDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  try {
    const state = await deleteTargetPolygon(datasetDir);
    return Response.json(state);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to delete target polygon",
      },
      { status: 500 },
    );
  }
}
