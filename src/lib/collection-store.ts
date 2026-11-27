import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCalibrationArtifactPaths } from "@/lib/calibration-store";
import { resolveDistributionArtifactPaths } from "@/lib/distribution-store";
import {
  buildDistributionCommand,
  buildSuggestCommand,
} from "@/lib/lerobot-check-runner";
import { isInsideRoot } from "@/lib/local-dataset-paths";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  detectDatasetRevision,
  inferDatasetOrgAndName,
} from "@/lib/subtask-annotations-store";
import type { CalibrationHeadFile } from "@/types/calibration.types";
import type {
  CollectionPlan,
  CollectionStatePayload,
  SuggestionsFile,
  TargetPolygonFile,
} from "@/types/collection.types";
import type { DistributionFile } from "@/types/distribution.types";
import { parseCalibrationHeadJson } from "@/utils/calibrationData";
import { hasNonZeroDistortion } from "@/utils/calibrationMath";
import {
  collectionTargetKey,
  parseCollectionMasks,
  parseCollectionPlan,
  parseSuggestionsJson,
  parseTargetPolygonJson,
  serializeTargetPolygon,
} from "@/utils/collectionData";
import { parseDistributionJson } from "@/utils/distributionData";

const VIEWER_STORE_DIR = ".xense-viewer";
const TARGETS_DIR = "targets";
const SUGGESTIONS_DIR = "suggestions";
const DEFAULT_CAMERA = "observation.images.head";
const DEFAULT_IMAGE_SIZE: [number, number] = [640, 480];

export interface CollectionArtifactPaths {
  viewerRoot: string;
  org: string;
  name: string;
  repoId: string;
  revision: string;
  targetsPath: string;
  suggestionsPath: string;
  masksPath: string;
  planPath: string;
  distributionPath: string;
  headPath: string;
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
    throw new Error(`Invalid ${label} for collection artifact path: ${value}`);
  }
}

export async function resolveCollectionArtifactPaths(
  datasetDir: string,
  options: { localDatasetRoot?: string } = {},
): Promise<CollectionArtifactPaths> {
  const localRoot = path.resolve(
    options.localDatasetRoot ?? resolveLocalDatasetRoot(),
  );
  const viewerRoot = path.join(localRoot, VIEWER_STORE_DIR);
  const { org, name, repoId } = inferDatasetOrgAndName(datasetDir, localRoot);
  const revision = await detectDatasetRevision(datasetDir);

  assertSafeFilenameToken(org, "org");
  assertSafeFilenameToken(name, "dataset name");
  assertSafeFilenameToken(revision, "revision");

  const key = `${org}__${name}`;
  const targetsPath = path.join(viewerRoot, TARGETS_DIR, `${key}.json`);
  const suggestionsPath = path.join(
    viewerRoot,
    SUGGESTIONS_DIR,
    `${key}@${revision}.json`,
  );

  const masksPath = path.join(viewerRoot, "masks", `${key}@${revision}.json`);
  const planPath = path.join(viewerRoot, "plans", `${key}@${revision}.json`);

  const [distPaths, calibPaths] = await Promise.all([
    resolveDistributionArtifactPaths(datasetDir, options),
    resolveCalibrationArtifactPaths(datasetDir, options),
  ]);

  for (const target of [targetsPath, suggestionsPath, masksPath, planPath]) {
    if (!isInsideRoot(viewerRoot, target)) {
      throw new Error(`Artifact path escaped ${VIEWER_STORE_DIR}: ${target}`);
    }
  }

  return {
    viewerRoot,
    org,
    name,
    repoId,
    revision,
    targetsPath,
    suggestionsPath,
    masksPath,
    planPath,
    distributionPath: distPaths.distributionPath,
    headPath: calibPaths.headPath,
  };
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeFileAtomic(
  targetPath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

function tryParse<T>(
  raw: string | null,
  parser: (text: string) => T,
): { value: T | null; error: string | null } {
  if (raw === null) return { value: null, error: null };
  try {
    return { value: parser(raw), error: null };
  } catch (err) {
    return {
      value: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type PlanResult = {
  raw: string | null;
  plan: CollectionPlan | null;
  error: CollectionStatePayload["planError"];
};

function checkPlanFile(
  paths: CollectionArtifactPaths,
  raw: string | null,
  headRaw: string | null,
  head: CalibrationHeadFile | null,
): PlanResult {
  if (!raw) return { raw, plan: null, error: raw === null ? null : "invalid" };
  const parsed = tryParse(raw, parseCollectionPlan).value;
  if (!parsed) return { raw, plan: null, error: "invalid" };
  if (
    parsed.repo_id !== paths.repoId ||
    parsed.revision !== paths.revision ||
    !head ||
    !headRaw ||
    parsed.calibration_sha256 !==
      createHash("sha256").update(headRaw).digest("hex")
  )
    return { raw, plan: null, error: "stale" };
  if (
    parsed.camera !== head.camera ||
    parsed.image_size.some((n, i) => n !== head.image_size[i])
  ) {
    return { raw, plan: null, error: "imageMismatch" };
  }
  return { raw, plan: parsed, error: null };
}

export async function loadCollectionPlanFile(
  paths: CollectionArtifactPaths,
): Promise<PlanResult> {
  const [raw, headRaw] = await Promise.all([
    readFileIfExists(paths.planPath),
    readFileIfExists(paths.headPath),
  ]);
  return checkPlanFile(
    paths,
    raw,
    headRaw,
    tryParse(headRaw, parseCalibrationHeadJson).value,
  );
}

export async function loadCollectionState(
  datasetDir: string,
  options: {
    localDatasetRoot?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<CollectionStatePayload> {
  const paths = await resolveCollectionArtifactPaths(datasetDir, options);
  const [targetsRaw, suggestionsRaw, distRaw, headRaw, masksRaw, planRaw] =
    await Promise.all([
      readFileIfExists(paths.targetsPath),
      readFileIfExists(paths.suggestionsPath),
      readFileIfExists(paths.distributionPath),
      readFileIfExists(paths.headPath),
      readFileIfExists(paths.masksPath),
      readFileIfExists(paths.planPath),
    ]);

  const parsedTargets = tryParse<TargetPolygonFile>(
    targetsRaw,
    parseTargetPolygonJson,
  );
  const parsedSuggestions = tryParse<SuggestionsFile>(
    suggestionsRaw,
    parseSuggestionsJson,
  );
  const parsedDist = tryParse<DistributionFile>(distRaw, parseDistributionJson);
  const parsedHead = tryParse<CalibrationHeadFile>(
    headRaw,
    parseCalibrationHeadJson,
  );

  const camera =
    parsedTargets.value?.camera ?? parsedHead.value?.camera ?? DEFAULT_CAMERA;
  const imageSize: [number, number] =
    parsedTargets.value?.image_size ??
    parsedHead.value?.image_size ??
    DEFAULT_IMAGE_SIZE;

  const parsedMasks = tryParse(masksRaw, parseCollectionMasks);
  const masks = parsedMasks.value;
  const suggestions = parsedSuggestions.value;
  const digest = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  let masksError: CollectionStatePayload["masksError"] = parsedMasks.error
    ? "invalid"
    : null;
  if (masks) {
    if (
      !suggestions ||
      !suggestionsRaw ||
      !parsedHead.value ||
      !headRaw ||
      masks.repo_id !== paths.repoId ||
      masks.revision !== paths.revision ||
      masks.calibration_sha256 !== digest(headRaw) ||
      masks.suggestions_sha256 !== digest(suggestionsRaw)
    )
      masksError = "stale";
    else if (
      masks.camera !== camera ||
      masks.camera !== parsedHead.value.camera ||
      masks.image_size.some(
        (n, i) => n !== imageSize[i] || n !== parsedHead.value?.image_size[i],
      )
    ) {
      masksError = "imageMismatch";
    } else {
      const keys = new Set([
        ...suggestions.placements.map((item) =>
          collectionTargetKey("placement", item),
        ),
        ...suggestions.test_points.map((item) =>
          collectionTargetKey("test_point", item),
        ),
      ]);
      if (
        keys.size !== masks.targets.length ||
        masks.targets.some(
          (target) => !keys.has(collectionTargetKey(target.kind, target)),
        )
      ) {
        masksError = "invalid";
      }
    }
  }

  const planFile = checkPlanFile(paths, planRaw, headRaw, parsedHead.value);
  const suggestCli = buildSuggestCommand(datasetDir, paths.repoId, {
    count: 10,
    testPerTier: 3,
    env: options.env,
  });
  const distCli = buildDistributionCommand(
    datasetDir,
    paths.repoId,
    options.env,
  );

  return {
    repoId: paths.repoId,
    revision: paths.revision,
    paths: {
      targetsPath: paths.targetsPath,
      suggestionsPath: paths.suggestionsPath,
      distributionPath: paths.distributionPath,
      headPath: paths.headPath,
    },
    camera,
    imageSize,
    targetsExists: targetsRaw !== null,
    targets: parsedTargets.value,
    targetsError: parsedTargets.error,
    suggestionsExists: suggestionsRaw !== null,
    suggestions: parsedSuggestions.value,
    suggestionsError: parsedSuggestions.error,
    masks: masksError ? null : masks,
    masksError,
    plan: planFile.plan,
    planError: planFile.error,
    calibration: {
      exists: headRaw !== null && parsedHead.value !== null,
      hasNonZeroDistortion: hasNonZeroDistortion(parsedHead.value?.intrinsics),
      error: parsedHead.error,
    },
    distribution: {
      exists: distRaw !== null && parsedDist.value !== null,
      positionPoint: parsedDist.value?.provenance.position_point ?? null,
      annotatedEpisodes: parsedDist.value?.provenance.annotated_episodes ?? [],
      objects: parsedDist.value?.objects.map(({ name }) => name) ?? [],
      error: parsedDist.error,
    },
    cli: {
      configured: suggestCli.configured,
      projectDir: suggestCli.projectDir,
      suggestCommand: suggestCli.command,
      distributionCommand: distCli.command,
    },
  };
}

export async function saveTargetPolygon(
  datasetDir: string,
  file: TargetPolygonFile,
  options: {
    localDatasetRoot?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<CollectionStatePayload> {
  const paths = await resolveCollectionArtifactPaths(datasetDir, options);
  const serialized = serializeTargetPolygon(file);
  // Validate round-trip before writing atomically so malformed polygons never hit disk.
  parseTargetPolygonJson(serialized);
  await writeFileAtomic(paths.targetsPath, serialized);
  return loadCollectionState(datasetDir, options);
}

export async function deleteTargetPolygon(
  datasetDir: string,
  options: {
    localDatasetRoot?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<CollectionStatePayload> {
  const paths = await resolveCollectionArtifactPaths(datasetDir, options);
  try {
    await fs.unlink(paths.targetsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  return loadCollectionState(datasetDir, options);
}
