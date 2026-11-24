import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import {
  loadEpisodeSubtaskState,
  saveEpisodeSubtaskRows,
  SubtaskValidationError,
} from "@/lib/subtask-annotations-store";
import {
  VALID_SUBTASK_ANNOTATORS,
  type SubtaskAnnotationRow,
  type SubtaskAnnotator,
} from "@/types/subtask-annotation.types";

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

function parseOptionalIntField(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return undefined;
}

function parsePutBody(body: unknown): {
  episodeIndex: number;
  rows: SubtaskAnnotationRow[];
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const episodeIndex = record.episodeIndex;
  if (
    typeof episodeIndex !== "number" ||
    !Number.isInteger(episodeIndex) ||
    episodeIndex < 0
  ) {
    return null;
  }
  if (!Array.isArray(record.rows)) return null;

  const rows: SubtaskAnnotationRow[] = [];
  for (const raw of record.rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.subtask !== "string") return null;
    if (typeof item.start !== "number" || !Number.isInteger(item.start))
      return null;
    if (typeof item.end !== "number" || !Number.isInteger(item.end))
      return null;
    const contact = parseOptionalIntField(item.contact);
    const grasp = parseOptionalIntField(item.grasp);
    if (contact === undefined || grasp === undefined) return null;
    if (typeof item.success !== "boolean") return null;

    const rawAnnotator =
      typeof item.annotator === "string" ? item.annotator : "human";
    if (
      !(VALID_SUBTASK_ANNOTATORS as readonly string[]).includes(rawAnnotator)
    ) {
      return null;
    }

    rows.push({
      repo_id: typeof item.repo_id === "string" ? item.repo_id : "",
      revision: typeof item.revision === "string" ? item.revision : "",
      episode_index: episodeIndex,
      subtask: item.subtask,
      start: item.start,
      end: item.end,
      contact,
      grasp,
      success: item.success,
      annotator: rawAnnotator as SubtaskAnnotator,
      note: typeof item.note === "string" ? item.note : "",
    });
  }

  return { episodeIndex, rows };
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

  const datasetDir = await resolveExistingDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  try {
    const payload = await loadEpisodeSubtaskState(datasetDir, episode);
    return Response.json(payload);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to load subtask annotations",
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

  const parsed = parsePutBody(body);
  if (!parsed) {
    return Response.json(
      {
        error:
          "Body must contain non-negative integer episodeIndex and valid rows[]",
      },
      { status: 400 },
    );
  }

  try {
    const result = await saveEpisodeSubtaskRows(
      datasetDir,
      parsed.episodeIndex,
      parsed.rows,
    );
    return Response.json({
      ...result.payload,
      changedRowCount: result.changedRowCount,
    });
  } catch (err) {
    if (err instanceof SubtaskValidationError) {
      return Response.json(
        { error: err.message, issues: err.issues },
        { status: 400 },
      );
    }
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to save subtask annotations",
      },
      { status: 500 },
    );
  }
}
