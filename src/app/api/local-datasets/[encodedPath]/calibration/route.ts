import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import {
  loadCalibrationState,
  saveCalibrationPoints,
} from "@/lib/calibration-store";
import type { CalibrationPointUpdate } from "@/types/calibration.types";

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

function parsePointUpdatesBody(body: unknown): CalibrationPointUpdate[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.updates)) return null;

  const updates: CalibrationPointUpdate[] = [];
  for (const raw of record.updates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()) return null;

    let pixel: [number, number] | null | undefined = undefined;
    if (item.pixel === null) {
      pixel = null;
    } else if (item.pixel !== undefined) {
      if (
        !Array.isArray(item.pixel) ||
        item.pixel.length !== 2 ||
        typeof item.pixel[0] !== "number" ||
        typeof item.pixel[1] !== "number" ||
        !Number.isFinite(item.pixel[0]) ||
        !Number.isFinite(item.pixel[1])
      ) {
        return null;
      }
      pixel = [item.pixel[0], item.pixel[1]];
    }

    let skipped: boolean | null | undefined = undefined;
    if (item.skipped === null) {
      skipped = null;
    } else if (item.skipped !== undefined) {
      if (typeof item.skipped !== "boolean") return null;
      skipped = item.skipped;
    }

    updates.push({
      id: item.id,
      ...(pixel !== undefined ? { pixel } : {}),
      ...(skipped !== undefined ? { skipped } : {}),
    });
  }

  return updates;
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
    const state = await loadCalibrationState(datasetDir);
    return Response.json(state);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to load calibration state",
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

  const updates = parsePointUpdatesBody(body);
  if (!updates) {
    return Response.json(
      {
        error:
          "Body must contain updates[] with { id, pixel?: [u,v] | null, skipped?: boolean | null }",
      },
      { status: 400 },
    );
  }

  try {
    const state = await saveCalibrationPoints(datasetDir, updates);
    return Response.json(state);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to save calibration points",
      },
      { status: 400 },
    );
  }
}
