import type {
  CalibrationArmResult,
  CalibrationFrameEntry,
  CalibrationFramesFile,
  CalibrationHeadFile,
  CalibrationIntrinsics,
  CalibrationIntrinsicsFile,
  CalibrationPixel,
  CalibrationPointEntry,
  CalibrationPointsFile,
  CalibrationPointUpdate,
  CalibrationResidual,
  CalibrationTcpPose,
  Matrix4RowMajor,
} from "@/types/calibration.types";

export interface ArmCalibrationProgress {
  arm: string;
  total: number;
  clicked: number;
  skipped: number;
  remaining: number;
}

export interface CalibrationProgressSummary {
  total: number;
  clicked: number;
  skipped: number;
  remaining: number;
  byArm: ArmCalibrationProgress[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: expected finite number`);
  }
  return value;
}

function assertNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: expected non-negative integer`);
  }
  return value;
}

function parseImageSize(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`Invalid ${label}: expected [width, height]`);
  }
  const width = assertFiniteNumber(value[0], `${label}[0]`);
  const height = assertFiniteNumber(value[1], `${label}[1]`);
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid ${label}: dimensions must be positive`);
  }
  return [width, height];
}

function parseTcpPose(value: unknown, label: string): CalibrationTcpPose {
  if (!Array.isArray(value) || value.length !== 9) {
    throw new Error(`Invalid ${label}: expected 9-element TCP array`);
  }
  return value.map((item, idx) =>
    assertFiniteNumber(item, `${label}[${idx}]`),
  ) as CalibrationTcpPose;
}

function parsePixel(value: unknown, label: string): CalibrationPixel {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`Invalid ${label}: expected [u, v]`);
  }
  return [
    assertFiniteNumber(value[0], `${label}[0]`),
    assertFiniteNumber(value[1], `${label}[1]`),
  ];
}

function parseFrameEntry(
  raw: unknown,
  index: number,
  allowAnnotations: boolean,
): CalibrationPointEntry {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid frames[${index}]: expected object`);
  }
  const id = raw.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`Invalid frames[${index}].id: expected non-empty string`);
  }
  const arm = raw.arm;
  if (typeof arm !== "string" || !arm.trim()) {
    throw new Error(`Invalid frames[${index}].arm: expected non-empty string`);
  }

  const episodeIndex = assertNonNegativeInt(
    raw.episode_index,
    `frames[${index}].episode_index`,
  );
  const frameIndex = assertNonNegativeInt(
    raw.frame_index,
    `frames[${index}].frame_index`,
  );
  const tcp = parseTcpPose(raw.tcp, `frames[${index}].tcp`);

  const entry: CalibrationPointEntry = {
    ...raw,
    id,
    arm,
    episode_index: episodeIndex,
    frame_index: frameIndex,
    tcp,
  };

  if (allowAnnotations) {
    if (raw.pixel !== undefined) {
      entry.pixel = parsePixel(raw.pixel, `frames[${index}].pixel`);
    }
    if (raw.skipped !== undefined) {
      if (typeof raw.skipped !== "boolean") {
        throw new Error(`Invalid frames[${index}].skipped: expected boolean`);
      }
      if (raw.skipped) {
        entry.skipped = true;
      } else {
        delete entry.skipped;
      }
    }
  } else {
    delete entry.pixel;
    delete entry.skipped;
  }

  return entry;
}

function parseFramesContainer(
  rawText: string,
  allowAnnotations: boolean,
  fileLabel: string,
): CalibrationPointsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Malformed ${fileLabel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid ${fileLabel}: root must be a JSON object`);
  }

  const version = assertNonNegativeInt(parsed.version, `${fileLabel}.version`);
  const repoId = typeof parsed.repo_id === "string" ? parsed.repo_id : "";
  const revision = typeof parsed.revision === "string" ? parsed.revision : "";
  const camera =
    typeof parsed.camera === "string" && parsed.camera.trim()
      ? parsed.camera
      : "observation.images.head";
  const imageSize = parseImageSize(
    parsed.image_size,
    `${fileLabel}.image_size`,
  );

  if (!Array.isArray(parsed.frames)) {
    throw new Error(`Invalid ${fileLabel}.frames: expected array`);
  }
  const seen = new Set<string>();
  const frames = parsed.frames.map((item, idx) => {
    const entry = parseFrameEntry(item, idx, allowAnnotations);
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate frame id "${entry.id}" in ${fileLabel}`);
    }
    seen.add(entry.id);
    return entry;
  });

  return {
    ...parsed,
    version,
    repo_id: repoId,
    revision,
    camera,
    image_size: imageSize,
    frames,
  };
}

export function parseCalibrationFramesJson(
  rawText: string,
): CalibrationFramesFile {
  return parseFramesContainer(rawText, false, "frames.json");
}

export function parseCalibrationPointsJson(
  rawText: string,
): CalibrationPointsFile {
  return parseFramesContainer(rawText, true, "points.json");
}

function parseIntrinsicsObject(
  raw: unknown,
  label: string,
): CalibrationIntrinsics {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  const fx = assertFiniteNumber(raw.fx, `${label}.fx`);
  const fy = assertFiniteNumber(raw.fy, `${label}.fy`);
  const cx = assertFiniteNumber(raw.cx, `${label}.cx`);
  const cy = assertFiniteNumber(raw.cy, `${label}.cy`);
  const distortion = Array.isArray(raw.distortion)
    ? raw.distortion.map((d, idx) =>
        assertFiniteNumber(d, `${label}.distortion[${idx}]`),
      )
    : [];
  const distortionModel =
    typeof raw.distortion_model === "string" ? raw.distortion_model : undefined;
  return {
    fx,
    fy,
    cx,
    cy,
    ...(distortionModel ? { distortion_model: distortionModel } : {}),
    distortion,
  };
}

export function parseCalibrationIntrinsicsJson(
  rawText: string,
): CalibrationIntrinsicsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Malformed intrinsics.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Invalid intrinsics.json: root must be a JSON object");
  }
  const version = assertNonNegativeInt(
    parsed.version,
    "intrinsics.json.version",
  );
  const camera =
    typeof parsed.camera === "string" && parsed.camera.trim()
      ? parsed.camera
      : "observation.images.head";
  const imageSize = parseImageSize(
    parsed.image_size,
    "intrinsics.json.image_size",
  );
  const intrinsics = parseIntrinsicsObject(parsed, "intrinsics.json");
  return {
    version,
    camera,
    ...(typeof parsed.device === "string" ? { device: parsed.device } : {}),
    image_size: imageSize,
    ...intrinsics,
  };
}

function parseMatrix4(raw: unknown, label: string): Matrix4RowMajor {
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error(`Invalid ${label}: expected 4x4 matrix`);
  }
  return raw.map((row, r) => {
    if (!Array.isArray(row) || row.length !== 4) {
      throw new Error(`Invalid ${label}[${r}]: expected 4-element row`);
    }
    return row.map((v, c) => assertFiniteNumber(v, `${label}[${r}][${c}]`)) as [
      number,
      number,
      number,
      number,
    ];
  }) as Matrix4RowMajor;
}

function parseToolOffset(
  raw: unknown,
  label: string,
): [number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error(`Invalid ${label}: expected 3-element vector`);
  }
  return [
    assertFiniteNumber(raw[0], `${label}[0]`),
    assertFiniteNumber(raw[1], `${label}[1]`),
    assertFiniteNumber(raw[2], `${label}[2]`),
  ];
}

function parseResiduals(raw: unknown, label: string): CalibrationResidual[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid ${label}: expected array`);
  }
  return raw.map((item, idx) => {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid ${label}[${idx}]: expected object`);
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      throw new Error(`Invalid ${label}[${idx}].id: expected string`);
    }
    return {
      id: item.id,
      du: assertFiniteNumber(item.du, `${label}[${idx}].du`),
      dv: assertFiniteNumber(item.dv, `${label}[${idx}].dv`),
    };
  });
}

export function parseCalibrationHeadJson(rawText: string): CalibrationHeadFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Malformed head.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Invalid head.json: root must be a JSON object");
  }
  const version = assertNonNegativeInt(parsed.version, "head.json.version");
  const repoId = typeof parsed.repo_id === "string" ? parsed.repo_id : "";
  const revision = typeof parsed.revision === "string" ? parsed.revision : "";
  const camera =
    typeof parsed.camera === "string" && parsed.camera.trim()
      ? parsed.camera
      : "observation.images.head";
  const imageSize = parseImageSize(parsed.image_size, "head.json.image_size");
  const intrinsics = parseIntrinsicsObject(
    parsed.intrinsics,
    "head.json.intrinsics",
  );

  if (!isPlainObject(parsed.arms)) {
    throw new Error("Invalid head.json.arms: expected object");
  }
  const arms: Record<string, CalibrationArmResult> = {};
  for (const [armName, rawArm] of Object.entries(parsed.arms)) {
    if (!isPlainObject(rawArm)) {
      throw new Error(`Invalid head.json.arms.${armName}: expected object`);
    }
    arms[armName] = {
      T_cam_base: parseMatrix4(
        rawArm.T_cam_base,
        `head.json.arms.${armName}.T_cam_base`,
      ),
      tool_offset: parseToolOffset(
        rawArm.tool_offset,
        `head.json.arms.${armName}.tool_offset`,
      ),
      n_points: assertNonNegativeInt(
        rawArm.n_points,
        `head.json.arms.${armName}.n_points`,
      ),
      rms_px: assertFiniteNumber(
        rawArm.rms_px,
        `head.json.arms.${armName}.rms_px`,
      ),
      loo_rms_px: assertFiniteNumber(
        rawArm.loo_rms_px,
        `head.json.arms.${armName}.loo_rms_px`,
      ),
      residuals: parseResiduals(
        rawArm.residuals,
        `head.json.arms.${armName}.residuals`,
      ),
    };
  }

  return {
    version,
    repo_id: repoId,
    revision,
    camera,
    image_size: imageSize,
    intrinsics,
    arms,
  };
}

function applyPointUpdate(
  entry: CalibrationPointEntry,
  update: CalibrationPointUpdate,
): CalibrationPointEntry {
  const next: CalibrationPointEntry = { ...entry };
  if (
    update.pixel &&
    Array.isArray(update.pixel) &&
    update.pixel.length === 2
  ) {
    const u = assertFiniteNumber(
      update.pixel[0],
      `update[${update.id}].pixel[0]`,
    );
    const v = assertFiniteNumber(
      update.pixel[1],
      `update[${update.id}].pixel[1]`,
    );
    next.pixel = [u, v];
    delete next.skipped;
    return next;
  }
  if (update.skipped === true) {
    next.skipped = true;
    delete next.pixel;
    return next;
  }
  // Explicit clear: neither pixel nor skipped.
  delete next.pixel;
  delete next.skipped;
  return next;
}

/**
 * Merge `frames.json` with existing `points.json` by frame `id`, then apply
 * optional user updates.
 *
 * Untouched frames keep their existing annotations and extra properties intact.
 * New frames appended to `frames.json` are included in `frames.json` order, and
 * entries that only exist in `points.json` are preserved at the end so manual
 * work is never silently dropped.
 */
export function mergeCalibrationPoints(
  framesFile: CalibrationFramesFile | null,
  existingPointsFile: CalibrationPointsFile | null,
  updates: readonly CalibrationPointUpdate[] = [],
): CalibrationPointsFile {
  const base = framesFile ?? existingPointsFile;
  if (!base) {
    throw new Error("Neither frames.json nor points.json exists");
  }

  const existingById = new Map<string, CalibrationPointEntry>();
  if (existingPointsFile) {
    for (const entry of existingPointsFile.frames) {
      existingById.set(entry.id, entry);
    }
  }

  const updateById = new Map<string, CalibrationPointUpdate>();
  for (const update of updates) {
    updateById.set(update.id, update);
  }

  const mergedFrames: CalibrationPointEntry[] = [];
  const emittedIds = new Set<string>();

  if (framesFile) {
    for (const frame of framesFile.frames) {
      const existing = existingById.get(frame.id);
      let combined: CalibrationPointEntry;
      if (existing) {
        combined = {
          ...existing,
          ...frame,
          ...(existing.pixel
            ? { pixel: [...existing.pixel] as CalibrationPixel }
            : {}),
          ...(existing.skipped ? { skipped: true } : {}),
        };
        if (combined.pixel) delete combined.skipped;
      } else {
        combined = { ...frame };
      }

      const update = updateById.get(frame.id);
      if (update) {
        combined = applyPointUpdate(combined, update);
      }
      mergedFrames.push(combined);
      emittedIds.add(frame.id);
    }
  }

  if (existingPointsFile) {
    for (const existing of existingPointsFile.frames) {
      if (emittedIds.has(existing.id)) continue;
      const update = updateById.get(existing.id);
      mergedFrames.push(
        update ? applyPointUpdate(existing, update) : { ...existing },
      );
      emittedIds.add(existing.id);
    }
  }

  return {
    ...(existingPointsFile ?? {}),
    ...base,
    version: base.version,
    repo_id: base.repo_id,
    revision: base.revision,
    camera: base.camera,
    image_size: [base.image_size[0], base.image_size[1]],
    frames: mergedFrames,
  };
}

export function serializeCalibrationPoints(
  file: CalibrationPointsFile,
): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function isFrameClicked(entry: CalibrationPointEntry): boolean {
  return (
    Array.isArray(entry.pixel) &&
    entry.pixel.length === 2 &&
    Number.isFinite(entry.pixel[0]) &&
    Number.isFinite(entry.pixel[1])
  );
}

export function isFrameSkipped(entry: CalibrationPointEntry): boolean {
  return !isFrameClicked(entry) && entry.skipped === true;
}

export function summarizeCalibrationProgress(
  frames: readonly CalibrationPointEntry[],
): CalibrationProgressSummary {
  const byArmMap = new Map<string, ArmCalibrationProgress>();
  let clicked = 0;
  let skipped = 0;
  let remaining = 0;

  for (const frame of frames) {
    let bucket = byArmMap.get(frame.arm);
    if (!bucket) {
      bucket = {
        arm: frame.arm,
        total: 0,
        clicked: 0,
        skipped: 0,
        remaining: 0,
      };
      byArmMap.set(frame.arm, bucket);
    }
    bucket.total += 1;
    if (isFrameClicked(frame)) {
      bucket.clicked += 1;
      clicked += 1;
    } else if (isFrameSkipped(frame)) {
      bucket.skipped += 1;
      skipped += 1;
    } else {
      bucket.remaining += 1;
      remaining += 1;
    }
  }

  return {
    total: frames.length,
    clicked,
    skipped,
    remaining,
    byArm: [...byArmMap.values()],
  };
}

export function groupCalibrationFramesByArm(
  frames: readonly CalibrationPointEntry[],
): Array<{ arm: string; frames: CalibrationPointEntry[] }> {
  const grouped = new Map<string, CalibrationPointEntry[]>();
  for (const frame of frames) {
    let list = grouped.get(frame.arm);
    if (!list) {
      list = [];
      grouped.set(frame.arm, list);
    }
    list.push(frame);
  }
  return [...grouped.entries()].map(([arm, armFrames]) => ({
    arm,
    frames: armFrames,
  }));
}

export function frameEntryToBase(
  entry: CalibrationPointEntry,
): CalibrationFrameEntry {
  const copy: CalibrationPointEntry = { ...entry };
  delete copy.pixel;
  delete copy.skipped;
  return copy;
}
