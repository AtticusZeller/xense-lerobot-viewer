import fs from "node:fs/promises";
import path from "node:path";
import { resolveCalibrationArtifactPaths } from "@/lib/calibration-store";
import { buildDistributionCommand } from "@/lib/lerobot-check-runner";
import { isInsideRoot } from "@/lib/local-dataset-paths";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  detectDatasetRevision,
  inferDatasetOrgAndName,
} from "@/lib/subtask-annotations-store";
import type { CalibrationHeadFile } from "@/types/calibration.types";
import type {
  DistributionFile,
  DistributionStatePayload,
} from "@/types/distribution.types";
import { parseCalibrationHeadJson } from "@/utils/calibrationData";
import { parseDistributionJson } from "@/utils/distributionData";

const VIEWER_STORE_DIR = ".xense-viewer";
const DISTRIBUTION_DIR = "distribution";

export interface DistributionArtifactPaths {
  viewerRoot: string;
  org: string;
  name: string;
  repoId: string;
  revision: string;
  distributionPath: string;
}

function assertSafeFilenameToken(value: string, label: string): void {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(
      `Invalid ${label} for distribution artifact path: ${value}`,
    );
  }
}

export async function resolveDistributionArtifactPaths(
  datasetDir: string,
  options: { localDatasetRoot?: string } = {},
): Promise<DistributionArtifactPaths> {
  const localRoot = path.resolve(
    options.localDatasetRoot ?? resolveLocalDatasetRoot(),
  );
  const viewerRoot = path.join(localRoot, VIEWER_STORE_DIR);
  const { org, name, repoId } = inferDatasetOrgAndName(datasetDir, localRoot);
  const revision = await detectDatasetRevision(datasetDir);

  assertSafeFilenameToken(org, "org");
  assertSafeFilenameToken(name, "dataset name");
  assertSafeFilenameToken(revision, "revision");

  const distributionPath = path.join(
    viewerRoot,
    DISTRIBUTION_DIR,
    `${org}__${name}@${revision}.json`,
  );
  if (!isInsideRoot(viewerRoot, distributionPath)) {
    throw new Error(
      `Artifact path escaped ${VIEWER_STORE_DIR}: ${distributionPath}`,
    );
  }

  return {
    viewerRoot,
    org,
    name,
    repoId,
    revision,
    distributionPath,
  };
}

async function readFileWithStat(
  filePath: string,
): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const [stat, text] = await Promise.all([
      fs.stat(filePath),
      fs.readFile(filePath, "utf-8"),
    ]);
    if (!stat.isFile()) return null;
    return { text, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadDistributionState(
  datasetDir: string,
  options: {
    localDatasetRoot?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<DistributionStatePayload> {
  const [paths, calibPaths] = await Promise.all([
    resolveDistributionArtifactPaths(datasetDir, options),
    resolveCalibrationArtifactPaths(datasetDir, options),
  ]);

  const [distRaw, headRaw] = await Promise.all([
    readFileWithStat(paths.distributionPath),
    readFileWithStat(calibPaths.headPath),
  ]);

  let distribution: DistributionFile | null = null;
  let fileError: string | null = null;
  if (distRaw) {
    try {
      distribution = parseDistributionJson(distRaw.text);
    } catch (err) {
      fileError = err instanceof Error ? err.message : String(err);
    }
  }

  let head: CalibrationHeadFile | null = null;
  let headError: string | null = null;
  if (headRaw) {
    try {
      head = parseCalibrationHeadJson(headRaw.text);
    } catch (err) {
      headError = err instanceof Error ? err.message : String(err);
    }
  }

  const cli = buildDistributionCommand(datasetDir, paths.repoId, options.env);

  return {
    repoId: paths.repoId,
    revision: paths.revision,
    distributionPath: paths.distributionPath,
    exists: distRaw !== null,
    mtimeMs: distRaw ? distRaw.mtimeMs : null,
    fileError,
    distribution,
    calibration: {
      exists: headRaw !== null,
      head,
      error: headError,
    },
    cli,
  };
}
