import fs from "node:fs/promises";
import path from "node:path";
import { isInsideRoot } from "@/lib/local-dataset-paths";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { locateEpisodeRows } from "@/lib/parquet-server";
import type {
  SubtaskAnnotationRow,
  SubtaskEpisodePayload,
  SubtaskValidationIssue,
  TaskSpec,
} from "@/types/subtask-annotation.types";
import { mergeEpisodeIntoCsv, parseSubtaskCsv } from "@/utils/subtaskCsv";
import { validateEpisodeSubtasks } from "@/utils/subtaskEditor";
import { parseTaskSpecYaml } from "@/utils/taskSpecYaml";

const VIEWER_STORE_DIR = ".xense-viewer";
const SUBTASKS_DIR = "subtasks";

export interface SubtaskArtifactPaths {
  viewerRoot: string;
  org: string;
  name: string;
  repoId: string;
  revision: string;
  csvPath: string;
  taskSpecPath: string;
}

export class SubtaskValidationError extends Error {
  readonly issues: SubtaskValidationIssue[];

  constructor(issues: SubtaskValidationIssue[]) {
    super(issues[0]?.message ?? "Subtask validation failed");
    this.name = "SubtaskValidationError";
    this.issues = issues;
  }
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
    throw new Error(`Invalid ${label} for viewer artifact path: ${value}`);
  }
}

export async function detectDatasetRevision(
  datasetDir: string,
): Promise<string> {
  const treesDir = path.join(datasetDir, ".cache", "huggingface", "trees");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(treesDir, { withFileTypes: true });
  } catch {
    return "local";
  }

  const stems = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .filter((stem) => stem.length === 40)
    .sort();

  return stems.length === 1 ? stems[0] : "local";
}

export function inferDatasetOrgAndName(
  datasetDir: string,
  localDatasetRoot: string,
): { org: string; name: string; repoId: string } {
  const resolvedRoot = path.resolve(localDatasetRoot);
  const resolvedDataset = path.resolve(datasetDir);

  if (isInsideRoot(resolvedRoot, resolvedDataset)) {
    const segments = path
      .relative(resolvedRoot, resolvedDataset)
      .split(path.sep)
      .filter(Boolean);
    if (segments.length >= 2) {
      const org = segments[0];
      const name = segments[segments.length - 1];
      return { org, name, repoId: `${org}/${name}` };
    }
  }

  const name = path.basename(resolvedDataset);
  const org = path.basename(path.dirname(resolvedDataset)) || "local";
  return { org, name, repoId: `${org}/${name}` };
}

export async function resolveSubtaskArtifactPaths(
  datasetDir: string,
  options: { localDatasetRoot?: string } = {},
): Promise<SubtaskArtifactPaths> {
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
  const versionedKey = `${key}@${revision}`;
  const csvPath = path.join(viewerRoot, SUBTASKS_DIR, `${versionedKey}.csv`);
  const taskSpecPath = path.join(
    viewerRoot,
    SUBTASKS_DIR,
    `${key}.task_spec.yaml`,
  );

  for (const target of [csvPath, taskSpecPath]) {
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
    csvPath,
    taskSpecPath,
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

async function readTaskSpecFile(
  taskSpecPath: string,
): Promise<{ taskSpec: TaskSpec | null; error: string | null }> {
  const raw = await readFileIfExists(taskSpecPath);
  if (raw === null) return { taskSpec: null, error: null };
  try {
    return { taskSpec: parseTaskSpecYaml(raw), error: null };
  } catch (err) {
    return {
      taskSpec: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readEpisodeLength(
  datasetDir: string,
  episodeIndex: number,
): Promise<number> {
  const locator = await locateEpisodeRows(datasetDir, episodeIndex);
  if (!locator) return 0;
  return Math.max(0, locator.toIndex - locator.fromIndex);
}

export async function loadEpisodeSubtaskState(
  datasetDir: string,
  episodeIndex: number,
  options: { localDatasetRoot?: string } = {},
): Promise<SubtaskEpisodePayload> {
  const paths = await resolveSubtaskArtifactPaths(datasetDir, options);
  const [episodeLength, specResult, csvText] = await Promise.all([
    readEpisodeLength(datasetDir, episodeIndex),
    readTaskSpecFile(paths.taskSpecPath),
    readFileIfExists(paths.csvPath),
  ]);

  let rows: SubtaskAnnotationRow[] = [];
  if (csvText !== null && csvText.trim()) {
    const parsed = parseSubtaskCsv(csvText);
    rows = parsed.records
      .filter((rec) => rec.row.episode_index === episodeIndex)
      .map((rec) => rec.row)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  return {
    repoId: paths.repoId,
    revision: paths.revision,
    episodeIndex,
    episodeLength,
    csvPath: paths.csvPath,
    csvExists: csvText !== null,
    taskSpecPath: paths.taskSpecPath,
    taskSpec: specResult.taskSpec,
    taskSpecError: specResult.error,
    rows,
  };
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

export async function saveEpisodeSubtaskRows(
  datasetDir: string,
  episodeIndex: number,
  rows: readonly SubtaskAnnotationRow[],
  options: { localDatasetRoot?: string } = {},
): Promise<{ payload: SubtaskEpisodePayload; changedRowCount: number }> {
  const paths = await resolveSubtaskArtifactPaths(datasetDir, options);
  const [episodeLength, specResult, existingCsvText] = await Promise.all([
    readEpisodeLength(datasetDir, episodeIndex),
    readTaskSpecFile(paths.taskSpecPath),
    readFileIfExists(paths.csvPath),
  ]);

  const sortedRows = rows
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const issues = validateEpisodeSubtasks(
    sortedRows,
    episodeLength,
    specResult.taskSpec,
  );
  if (issues.length > 0) {
    throw new SubtaskValidationError(issues);
  }

  const { csvText, updatedRows, changedRowCount } = mergeEpisodeIntoCsv(
    existingCsvText,
    episodeIndex,
    sortedRows,
    { repoId: paths.repoId, revision: paths.revision },
  );

  await writeFileAtomic(paths.csvPath, csvText);

  return {
    changedRowCount,
    payload: {
      repoId: paths.repoId,
      revision: paths.revision,
      episodeIndex,
      episodeLength,
      csvPath: paths.csvPath,
      csvExists: true,
      taskSpecPath: paths.taskSpecPath,
      taskSpec: specResult.taskSpec,
      taskSpecError: specResult.error,
      rows: updatedRows,
    },
  };
}
