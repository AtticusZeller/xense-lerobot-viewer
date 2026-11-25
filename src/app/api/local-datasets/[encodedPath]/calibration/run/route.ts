import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import {
  loadCalibrationState,
  resolveCalibrationArtifactPaths,
} from "@/lib/calibration-store";
import {
  getActiveCalibrationRun,
  runCalibrationCli,
  type CalibrationCliAction,
} from "@/lib/lerobot-check-runner";

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

const ARM_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = await resolveExistingDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  let body: { action?: unknown; append?: unknown; arms?: unknown };
  try {
    body = (await request.json()) as {
      action?: unknown;
      append?: unknown;
      arms?: unknown;
    };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action !== "calib-frames" && body.action !== "calibrate") {
    return Response.json(
      { error: 'action must be "calib-frames" or "calibrate"' },
      { status: 400 },
    );
  }
  const action: CalibrationCliAction = body.action;

  let append: number | undefined;
  if (body.append !== undefined && body.append !== null) {
    if (
      typeof body.append !== "number" ||
      !Number.isInteger(body.append) ||
      body.append <= 0 ||
      body.append > 200
    ) {
      return Response.json(
        { error: "append must be an integer between 1 and 200" },
        { status: 400 },
      );
    }
    append = body.append;
  }

  let arms: string[] | undefined;
  if (body.arms !== undefined && body.arms !== null) {
    if (action !== "calib-frames" || append === undefined) {
      return Response.json(
        { error: "arms is only allowed together with calib-frames and append" },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.arms) || body.arms.length === 0) {
      return Response.json(
        { error: "arms must be a non-empty array of arm names" },
        { status: 400 },
      );
    }
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of body.arms) {
      if (typeof item !== "string" || !ARM_NAME_PATTERN.test(item)) {
        return Response.json(
          {
            error:
              "each arm name must be a non-empty string matching /^[A-Za-z0-9_-]+$/",
          },
          { status: 400 },
        );
      }
      if (!seen.has(item)) {
        seen.add(item);
        deduped.push(item);
      }
    }
    arms = deduped;
  }

  if (getActiveCalibrationRun(datasetDir)) {
    return Response.json(
      {
        error: "A calibration CLI command is already running for this dataset",
      },
      { status: 409 },
    );
  }

  try {
    const paths = await resolveCalibrationArtifactPaths(datasetDir);
    const exec = await runCalibrationCli(action, {
      datasetDir,
      repoId: paths.repoId,
      append,
      arms,
    });
    const state = await loadCalibrationState(datasetDir);

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
            : "Failed to run calibration command",
      },
      { status: 500 },
    );
  }
}
