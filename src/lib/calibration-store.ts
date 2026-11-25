import fs from "node:fs/promises";
import path from "node:path";
import { parquetReadObjects } from "hyparquet/src/node.js";
import { isInsideRoot, resolveInsideDataset } from "@/lib/local-dataset-paths";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { buildCalibrationCommands } from "@/lib/lerobot-check-runner";
import {
  listV3EpisodeMetadataFiles,
  locateEpisodeRows,
  openParquet,
  readParquetRowsRaw,
} from "@/lib/parquet-server";
import {
  detectDatasetRevision,
  inferDatasetOrgAndName,
} from "@/lib/subtask-annotations-store";
import type {
  CalibrationEpisodeMediaPayload,
  CalibrationEpisodeVideoInfo,
  CalibrationFramesFile,
  CalibrationHeadFile,
  CalibrationIntrinsicsFile,
  CalibrationPointsFile,
  CalibrationPointUpdate,
  CalibrationStatePayload,
  CalibrationTcpPose,
} from "@/types/calibration.types";
import {
  EMPTY_CALIBRATION_MERGE_NOTICE,
  mergeCalibrationPointsWithNotice,
  parseCalibrationFramesJson,
  parseCalibrationHeadJson,
  parseCalibrationIntrinsicsJson,
  parseCalibrationPointsJson,
  serializeCalibrationPoints,
} from "@/utils/calibrationData";
import {
  extractArmTcpIndices,
  readTcpFromStateVector,
} from "@/utils/calibrationMath";
import { formatStringWithVars } from "@/utils/parquetUtils";
import {
  buildV3DataPath,
  buildV3VideoPath,
  formatEpisodeChunk,
  formatEpisodeIndex,
} from "@/utils/stringFormatting";
import { bigIntToNumber } from "@/utils/typeGuards";

const VIEWER_STORE_DIR = ".xense-viewer";
const CALIB_DIR = "calib";
const DEFAULT_CAMERA = "observation.images.head";
const DEFAULT_IMAGE_SIZE: [number, number] = [640, 480];
const V2_DEFAULT_VIDEO_PATH =
  "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4";

export interface CalibrationArtifactPaths {
  viewerRoot: string;
  calibDir: string;
  org: string;
  name: string;
  repoId: string;
  revision: string;
  framesPath: string;
  pointsPath: string;
  headPath: string;
  intrinsicsPath: string;
}

interface DatasetInfoFile {
  codebase_version?: string;
  fps?: number;
  chunks_size?: number;
  video_path?: string | null;
  features?: Record<
    string,
    {
      dtype?: string;
      shape?: number[];
      names?: string[] | null;
    }
  >;
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
    throw new Error(`Invalid ${label} for calibration artifact path: ${value}`);
  }
}

export async function resolveCalibrationArtifactPaths(
  datasetDir: string,
  options: { localDatasetRoot?: string } = {},
): Promise<CalibrationArtifactPaths> {
  const localRoot = path.resolve(
    options.localDatasetRoot ?? resolveLocalDatasetRoot(),
  );
  const viewerRoot = path.join(localRoot, VIEWER_STORE_DIR);
  const calibDir = path.join(viewerRoot, CALIB_DIR);
  const { org, name, repoId } = inferDatasetOrgAndName(datasetDir, localRoot);
  const revision = await detectDatasetRevision(datasetDir);

  assertSafeFilenameToken(org, "org");
  assertSafeFilenameToken(name, "dataset name");

  const prefix = `${org}__${name}`;
  const framesPath = path.join(calibDir, `${prefix}.frames.json`);
  const pointsPath = path.join(calibDir, `${prefix}.points.json`);
  const headPath = path.join(calibDir, `${prefix}.head.json`);
  const intrinsicsPath = path.join(calibDir, `${prefix}.intrinsics.json`);

  for (const target of [framesPath, pointsPath, headPath, intrinsicsPath]) {
    if (!isInsideRoot(viewerRoot, target)) {
      throw new Error(`Artifact path escaped ${VIEWER_STORE_DIR}: ${target}`);
    }
  }

  return {
    viewerRoot,
    calibDir,
    org,
    name,
    repoId,
    revision,
    framesPath,
    pointsPath,
    headPath,
    intrinsicsPath,
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

export async function loadCalibrationState(
  datasetDir: string,
  options: {
    localDatasetRoot?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<CalibrationStatePayload> {
  const paths = await resolveCalibrationArtifactPaths(datasetDir, options);
  const [framesRaw, pointsRaw, headRaw, intrinsicsRaw] = await Promise.all([
    readFileIfExists(paths.framesPath),
    readFileIfExists(paths.pointsPath),
    readFileIfExists(paths.headPath),
    readFileIfExists(paths.intrinsicsPath),
  ]);

  const parsedFrames = tryParse<CalibrationFramesFile>(
    framesRaw,
    parseCalibrationFramesJson,
  );
  const parsedPoints = tryParse<CalibrationPointsFile>(
    pointsRaw,
    parseCalibrationPointsJson,
  );
  const parsedHead = tryParse<CalibrationHeadFile>(
    headRaw,
    parseCalibrationHeadJson,
  );
  const parsedIntrinsics = tryParse<CalibrationIntrinsicsFile>(
    intrinsicsRaw,
    parseCalibrationIntrinsicsJson,
  );

  const mergeResult =
    parsedFrames.value || parsedPoints.value
      ? mergeCalibrationPointsWithNotice(parsedFrames.value, parsedPoints.value)
      : null;
  const merged = mergeResult?.file ?? null;
  const mergeNotice = mergeResult?.notice ?? EMPTY_CALIBRATION_MERGE_NOTICE;

  const camera =
    merged?.camera ??
    parsedHead.value?.camera ??
    parsedIntrinsics.value?.camera ??
    DEFAULT_CAMERA;

  const imageSize: [number, number] =
    merged?.image_size ??
    parsedHead.value?.image_size ??
    parsedIntrinsics.value?.image_size ??
    DEFAULT_IMAGE_SIZE;

  const cli = buildCalibrationCommands(datasetDir, paths.repoId, options.env);

  return {
    repoId: paths.repoId,
    revision: paths.revision,
    paths: {
      framesPath: paths.framesPath,
      pointsPath: paths.pointsPath,
      headPath: paths.headPath,
      intrinsicsPath: paths.intrinsicsPath,
    },
    framesExists: framesRaw !== null,
    pointsExists: pointsRaw !== null,
    headExists: headRaw !== null,
    intrinsicsExists: intrinsicsRaw !== null,
    framesFileError: parsedFrames.error,
    pointsFileError: parsedPoints.error,
    headFileError: parsedHead.error,
    intrinsicsFileError: parsedIntrinsics.error,
    camera,
    imageSize,
    frames: merged?.frames ?? [],
    mergeNotice,
    head: parsedHead.value,
    intrinsics: parsedIntrinsics.value,
    cli,
  };
}

export async function saveCalibrationPoints(
  datasetDir: string,
  updates: readonly CalibrationPointUpdate[],
  options: {
    localDatasetRoot?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<CalibrationStatePayload> {
  const paths = await resolveCalibrationArtifactPaths(datasetDir, options);
  const [framesRaw, pointsRaw] = await Promise.all([
    readFileIfExists(paths.framesPath),
    readFileIfExists(paths.pointsPath),
  ]);

  const framesFile =
    framesRaw !== null ? parseCalibrationFramesJson(framesRaw) : null;
  const existingPointsFile =
    pointsRaw !== null ? parseCalibrationPointsJson(pointsRaw) : null;

  if (!framesFile && !existingPointsFile) {
    throw new Error(
      `Cannot save points.json because neither ${paths.framesPath} nor ${paths.pointsPath} exists`,
    );
  }

  const { file: merged } = mergeCalibrationPointsWithNotice(
    framesFile,
    existingPointsFile,
    updates,
  );
  // Only points.json is written by the viewer; frames.json, head.json, and
  // intrinsics.json remain strictly read-only.
  await writeFileAtomic(paths.pointsPath, serializeCalibrationPoints(merged));

  return loadCalibrationState(datasetDir, options);
}

async function readDatasetInfoJson(
  datasetDir: string,
): Promise<DatasetInfoFile | null> {
  const infoPath = resolveInsideDataset(datasetDir, "meta/info.json");
  if (!infoPath) return null;
  try {
    return JSON.parse(await fs.readFile(infoPath, "utf-8")) as DatasetInfoFile;
  } catch {
    return null;
  }
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") return bigIntToNumber(value, fallback);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

async function statFileOrNull(
  absolutePath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    return { size: Number(stat.size), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function extractImageSizeFromInfo(
  info: DatasetInfoFile | null,
  cameraKey: string,
): [number, number] {
  const shape = info?.features?.[cameraKey]?.shape;
  if (Array.isArray(shape) && shape.length >= 2) {
    const height = Number(shape[0]);
    const width = Number(shape[1]);
    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return [width, height];
    }
  }
  return DEFAULT_IMAGE_SIZE;
}

async function readEpisodeArmsTcp(
  datasetDir: string,
  dataRelPath: string,
  fromIndex: number,
  toIndex: number,
  stateFeatureNames: readonly string[],
): Promise<Record<string, Array<CalibrationTcpPose | null>>> {
  const armIndices = extractArmTcpIndices(stateFeatureNames);
  const armNames = Object.keys(armIndices);
  if (armNames.length === 0) return {};

  const absDataPath = resolveInsideDataset(datasetDir, dataRelPath);
  if (!absDataPath) return {};
  const stat = await statFileOrNull(absDataPath);
  if (!stat) return {};

  const handle = await openParquet(
    absDataPath,
    dataRelPath,
    stat.size,
    stat.mtimeMs,
  );
  // `dataset_from_index` is a dataset-global row index, but a v3 data file
  // holds only a slice of the dataset; its first `index` value is the offset.
  const firstRow = await readParquetRowsRaw(handle, 0, 1, ["index"]);
  const fileStartIndex = toFiniteNumber(firstRow[0]?.["index"], 0);
  const localFrom = Math.max(0, fromIndex - fileStartIndex);
  const rowCount = Math.max(0, toIndex - fromIndex);
  const rows = await readParquetRowsRaw(handle, localFrom, rowCount, [
    "observation.state",
  ]);

  const result: Record<string, Array<CalibrationTcpPose | null>> = {};
  for (const arm of armNames) {
    result[arm] = new Array<CalibrationTcpPose | null>(rows.length);
  }
  for (let i = 0; i < rows.length; i += 1) {
    const state = rows[i]?.["observation.state"];
    for (const arm of armNames) {
      result[arm][i] = readTcpFromStateVector(state, armIndices[arm]);
    }
  }
  return result;
}

export async function loadCalibrationEpisodeMedia(
  datasetDir: string,
  encodedPath: string,
  episodeIndex: number,
  options: {
    camera?: string;
    includeTcp?: boolean;
  } = {},
): Promise<CalibrationEpisodeMediaPayload | null> {
  const info = await readDatasetInfoJson(datasetDir);
  if (!info) return null;

  const cameraKey = options.camera?.trim() || DEFAULT_CAMERA;
  const fps =
    typeof info.fps === "number" && Number.isFinite(info.fps) && info.fps > 0
      ? info.fps
      : 30;
  const imageSize = extractImageSizeFromInfo(info, cameraKey);
  const stateNames = Array.isArray(info.features?.["observation.state"]?.names)
    ? (info.features?.["observation.state"]?.names as string[])
    : [];

  if (info.codebase_version?.startsWith("v2")) {
    const locator = await locateEpisodeRows(datasetDir, episodeIndex);
    if (!locator) return null;
    const chunksSize =
      typeof info.chunks_size === "number" && info.chunks_size > 0
        ? info.chunks_size
        : 1000;
    const videoRelPath = formatStringWithVars(
      info.video_path || V2_DEFAULT_VIDEO_PATH,
      {
        episode_chunk: formatEpisodeChunk(
          Math.floor(episodeIndex / chunksSize),
        ),
        episode_index: formatEpisodeIndex(episodeIndex),
        video_key: cameraKey,
      },
    );
    const absVideoPath = resolveInsideDataset(datasetDir, videoRelPath);
    const videoExists = absVideoPath
      ? (await statFileOrNull(absVideoPath)) !== null
      : false;
    const video: CalibrationEpisodeVideoInfo | null = videoExists
      ? {
          filename: cameraKey,
          url: `/api/local-datasets/${encodedPath}/${videoRelPath}`,
          isSegmented: false,
        }
      : null;

    const armsTcp = options.includeTcp
      ? await readEpisodeArmsTcp(
          datasetDir,
          locator.relPath,
          locator.fromIndex,
          locator.toIndex,
          stateNames,
        )
      : undefined;

    return {
      episodeIndex,
      fps,
      episodeLength: Math.max(0, locator.toIndex - locator.fromIndex),
      camera: cameraKey,
      imageSize,
      video,
      ...(armsTcp !== undefined ? { armsTcp } : {}),
    };
  }

  // v3.0: walk episode metadata shards to get both per-camera segment bounds
  // and data parquet coordinates in one pass.
  const metadataPaths = await listV3EpisodeMetadataFiles(datasetDir);
  for (const relPath of metadataPaths) {
    const absolutePath = resolveInsideDataset(datasetDir, relPath);
    if (!absolutePath) continue;
    const stat = await statFileOrNull(absolutePath);
    if (!stat) continue;

    const handle = await openParquet(
      absolutePath,
      relPath,
      stat.size,
      stat.mtimeMs,
    );
    const rows = (await parquetReadObjects({
      file: handle.file,
      metadata: handle.metadata,
    })) as Record<string, unknown>[];

    for (const row of rows) {
      if (bigIntToNumber(row["episode_index"], -1) !== episodeIndex) continue;

      const fromIndex = bigIntToNumber(row["dataset_from_index"], 0);
      const toIndex = bigIntToNumber(row["dataset_to_index"], 0);
      const episodeLength = bigIntToNumber(
        row["length"],
        Math.max(0, toIndex - fromIndex),
      );
      const dataRelPath = buildV3DataPath(
        bigIntToNumber(row["data/chunk_index"], 0),
        bigIntToNumber(row["data/file_index"], 0),
      );

      const chunkKey = `videos/${cameraKey}/chunk_index`;
      const fileKey = `videos/${cameraKey}/file_index`;
      const fromTsKey = `videos/${cameraKey}/from_timestamp`;
      const toTsKey = `videos/${cameraKey}/to_timestamp`;

      let video: CalibrationEpisodeVideoInfo | null = null;
      if (chunkKey in row || fileKey in row || fromTsKey in row) {
        const videoChunk = bigIntToNumber(row[chunkKey], 0);
        const videoFile = bigIntToNumber(row[fileKey], 0);
        const segmentStart = toFiniteNumber(row[fromTsKey], 0);
        const segmentEnd = toFiniteNumber(
          row[toTsKey],
          segmentStart + episodeLength / fps,
        );
        const videoRelPath = buildV3VideoPath(cameraKey, videoChunk, videoFile);
        video = {
          filename: cameraKey,
          url: `/api/local-datasets/${encodedPath}/${videoRelPath}`,
          isSegmented: true,
          segmentStart,
          segmentEnd,
          segmentDuration: Math.max(0, segmentEnd - segmentStart),
        };
      }

      const armsTcp = options.includeTcp
        ? await readEpisodeArmsTcp(
            datasetDir,
            dataRelPath,
            fromIndex,
            toIndex,
            stateNames,
          )
        : undefined;

      return {
        episodeIndex,
        fps,
        episodeLength,
        camera: cameraKey,
        imageSize,
        video,
        ...(armsTcp !== undefined ? { armsTcp } : {}),
      };
    }
  }

  return null;
}
