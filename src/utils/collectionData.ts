import type {
  CollectionMaskBundle,
  CollectionMaskTarget,
  CollectionPlan,
  CollectionPlanRound,
  CollectionPlanTarget,
  SuggestionObjectGeometry,
  SuggestionPointItem,
  SuggestionsFile,
  SuggestionsProvenance,
  SuggestionTier,
  TargetPolygonFile,
  TargetPolygonVertex,
} from "@/types/collection.types";
import type { DistributionPositionPoint } from "@/types/distribution.types";

/** Exact column list written by `lerobot_check.suggest.write_suggestions_csv`. */
export const SUGGESTIONS_CSV_COLUMNS = [
  "kind",
  "object",
  "arm",
  "index",
  "tier",
  "x_m",
  "y_m",
  "z_m",
  "yaw_deg",
  "ix",
  "iy",
  "yaw_bin",
  "cell_count",
  "pixel_u",
  "pixel_v",
  "arrow_end_u",
  "arrow_end_v",
] as const;

const VALID_TIERS = new Set<string>(["empty", "sparse", "dense", "edge"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: expected finite number`);
  }
  return value;
}

function assertInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid ${label}: expected integer`);
  }
  return value;
}

function assertNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: expected non-negative integer`);
  }
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected string`);
  }
  return value;
}

function parsePoint2(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`Invalid ${label}: expected [x, y]`);
  }
  return [
    assertFiniteNumber(value[0], `${label}[0]`),
    assertFiniteNumber(value[1], `${label}[1]`),
  ];
}

function parseNullablePoint2(
  value: unknown,
  label: string,
): [number, number] | null {
  if (value === null || value === undefined) return null;
  return parsePoint2(value, label);
}

export function parseTargetPolygonJson(rawText: string): TargetPolygonFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Malformed targets.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Invalid targets.json: root must be a JSON object");
  }
  const version = assertNonNegativeInt(parsed.version, "targets.json.version");
  if (version !== 1) {
    throw new Error(
      `Unsupported targets.json version: ${version} (expected 1)`,
    );
  }
  const camera =
    typeof parsed.camera === "string" && parsed.camera.trim()
      ? parsed.camera
      : "observation.images.head";
  const imageSize = parsePoint2(parsed.image_size, "targets.json.image_size");
  if (imageSize[0] <= 0 || imageSize[1] <= 0) {
    throw new Error(
      "Invalid targets.json.image_size: dimensions must be positive",
    );
  }
  if (!Array.isArray(parsed.polygon) || parsed.polygon.length < 3) {
    throw new Error(
      "Invalid targets.json.polygon: must contain at least 3 [u, v] vertices",
    );
  }
  const polygon: TargetPolygonVertex[] = parsed.polygon.map((pt, idx) =>
    parsePoint2(pt, `targets.json.polygon[${idx}]`),
  );

  return {
    version: 1,
    camera,
    image_size: imageSize,
    polygon,
  };
}

export function serializeTargetPolygon(file: TargetPolygonFile): string {
  return `${JSON.stringify(
    {
      version: 1,
      camera: file.camera,
      image_size: [file.image_size[0], file.image_size[1]],
      polygon: file.polygon.map(([u, v]) => [u, v]),
    },
    null,
    2,
  )}\n`;
}

function clampVertex(
  vertex: readonly [number, number],
  imageSize: readonly [number, number],
): TargetPolygonVertex {
  const u = Math.max(0, Math.min(imageSize[0] - 1, vertex[0]));
  const v = Math.max(0, Math.min(imageSize[1] - 1, vertex[1]));
  return [Math.round(u * 10) / 10, Math.round(v * 10) / 10];
}

export function appendPolygonVertex(
  polygon: readonly TargetPolygonVertex[],
  vertex: readonly [number, number],
  imageSize: readonly [number, number],
): TargetPolygonVertex[] {
  return [...polygon, clampVertex(vertex, imageSize)];
}

export function movePolygonVertex(
  polygon: readonly TargetPolygonVertex[],
  index: number,
  vertex: readonly [number, number],
  imageSize: readonly [number, number],
): TargetPolygonVertex[] {
  if (index < 0 || index >= polygon.length) return polygon.slice();
  const next = polygon.slice();
  next[index] = clampVertex(vertex, imageSize);
  return next;
}

export function insertPolygonVertexAfter(
  polygon: readonly TargetPolygonVertex[],
  afterIndex: number,
  vertex: readonly [number, number],
  imageSize: readonly [number, number],
): TargetPolygonVertex[] {
  if (afterIndex < 0 || afterIndex >= polygon.length) {
    return appendPolygonVertex(polygon, vertex, imageSize);
  }
  const next = polygon.slice();
  next.splice(afterIndex + 1, 0, clampVertex(vertex, imageSize));
  return next;
}

export function deletePolygonVertex(
  polygon: readonly TargetPolygonVertex[],
  index: number,
): TargetPolygonVertex[] {
  if (index < 0 || index >= polygon.length) return polygon.slice();
  return polygon.filter((_, i) => i !== index);
}

export function findNearestVertexIndex(
  polygon: readonly TargetPolygonVertex[],
  u: number,
  v: number,
  maxDistancePx = 10,
): number {
  let bestIdx = -1;
  let bestDist = maxDistancePx;
  for (let i = 0; i < polygon.length; i += 1) {
    const dist = Math.hypot(polygon[i][0] - u, polygon[i][1] - v);
    if (dist <= bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function pointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  tol = 1e-9,
): boolean {
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > tol * Math.max(1, Math.hypot(bx - ax, by - ay))) {
    return false;
  }
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  if (dot < -tol) return false;
  const sqLen = (bx - ax) ** 2 + (by - ay) ** 2;
  return dot <= sqLen + tol;
}

/** Standard ray-casting + boundary check matching `lerobot_check.suggest.point_in_polygon`. */
export function pointInPolygon(
  u: number,
  v: number,
  polygon: readonly TargetPolygonVertex[],
): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (pointOnSegment(u, v, xj, yj, xi, yi)) return true;
    const intersects =
      yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function parseSuggestionItem(raw: unknown, label: string): SuggestionPointItem {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  const tier = assertString(raw.tier, `${label}.tier`);
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`Invalid ${label}.tier: "${tier}"`);
  }
  return {
    object: assertString(raw.object, `${label}.object`),
    arm: assertString(raw.arm, `${label}.arm`),
    index: assertNonNegativeInt(raw.index, `${label}.index`),
    x_m: assertFiniteNumber(raw.x_m, `${label}.x_m`),
    y_m: assertFiniteNumber(raw.y_m, `${label}.y_m`),
    z_m: assertFiniteNumber(raw.z_m, `${label}.z_m`),
    yaw_deg: assertFiniteNumber(raw.yaw_deg, `${label}.yaw_deg`),
    ix: assertInt(raw.ix, `${label}.ix`),
    iy: assertInt(raw.iy, `${label}.iy`),
    yaw_bin: assertNonNegativeInt(raw.yaw_bin, `${label}.yaw_bin`),
    cell_count: assertNonNegativeInt(raw.cell_count, `${label}.cell_count`),
    tier: tier as SuggestionTier,
    pixel: parseNullablePoint2(raw.pixel, `${label}.pixel`),
    arrow_end_pixel: parseNullablePoint2(
      raw.arrow_end_pixel,
      `${label}.arrow_end_pixel`,
    ),
  };
}

function parseSuggestionObject(
  raw: unknown,
  label: string,
): SuggestionObjectGeometry {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  if (!Array.isArray(raw.polygon_base_xy_m)) {
    throw new Error(`Invalid ${label}.polygon_base_xy_m: expected array`);
  }
  const polygonBase = raw.polygon_base_xy_m.map((pt, idx) =>
    parsePoint2(pt, `${label}.polygon_base_xy_m[${idx}]`),
  );
  const polygonPixel =
    raw.polygon_pixel === null || raw.polygon_pixel === undefined
      ? null
      : Array.isArray(raw.polygon_pixel)
        ? raw.polygon_pixel.map((pt, idx) =>
            parsePoint2(pt, `${label}.polygon_pixel[${idx}]`),
          )
        : (() => {
            throw new Error(
              `Invalid ${label}.polygon_pixel: expected array or null`,
            );
          })();
  return {
    object: assertString(raw.object, `${label}.object`),
    arm: assertString(raw.arm, `${label}.arm`),
    z_plane_m: assertFiniteNumber(raw.z_plane_m, `${label}.z_plane_m`),
    yaw_symmetry_deg: assertFiniteNumber(
      raw.yaw_symmetry_deg,
      `${label}.yaw_symmetry_deg`,
    ),
    polygon_base_xy_m: polygonBase,
    polygon_pixel: polygonPixel,
  };
}

function parseSuggestionsProvenance(raw: unknown): SuggestionsProvenance {
  if (!isPlainObject(raw)) {
    throw new Error("Invalid suggestions.json.provenance: expected object");
  }
  const posPoint = raw.position_point;
  if (posPoint !== "tool_point" && posPoint !== "tcp") {
    throw new Error(
      'Invalid suggestions.json.provenance.position_point: expected "tool_point" or "tcp"',
    );
  }
  const nullableStr = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    repo_id: assertString(raw.repo_id, "provenance.repo_id"),
    revision: assertString(raw.revision, "provenance.revision"),
    task_name: typeof raw.task_name === "string" ? raw.task_name : "",
    position_point: posPoint as DistributionPositionPoint,
    distribution_path: nullableStr(raw.distribution_path),
    targets_path: nullableStr(raw.targets_path),
    calib_path: nullableStr(raw.calib_path),
    region_source: assertString(raw.region_source, "provenance.region_source"),
    seed: assertInt(raw.seed, "provenance.seed"),
    count_per_object: assertNonNegativeInt(
      raw.count_per_object,
      "provenance.count_per_object",
    ),
    test_per_tier: assertNonNegativeInt(
      raw.test_per_tier,
      "provenance.test_per_tier",
    ),
    arrow_length_m: assertFiniteNumber(
      raw.arrow_length_m,
      "provenance.arrow_length_m",
    ),
    note: typeof raw.note === "string" ? raw.note : "",
  };
}

export function parseSuggestionsJson(rawText: string): SuggestionsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Malformed suggestions.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Invalid suggestions.json: root must be a JSON object");
  }
  const version = assertNonNegativeInt(
    parsed.version,
    "suggestions.json.version",
  );
  if (version !== 1) {
    throw new Error(
      `Unsupported suggestions.json version: ${version} (expected 1)`,
    );
  }
  if (!Array.isArray(parsed.objects)) {
    throw new Error("Invalid suggestions.json.objects: expected array");
  }
  if (!Array.isArray(parsed.placements)) {
    throw new Error("Invalid suggestions.json.placements: expected array");
  }
  if (!Array.isArray(parsed.test_points)) {
    throw new Error("Invalid suggestions.json.test_points: expected array");
  }
  const omitted = Array.isArray(parsed.omitted_objects)
    ? parsed.omitted_objects.map((v, i) =>
        assertString(v, `suggestions.json.omitted_objects[${i}]`),
      )
    : [];

  return {
    version,
    provenance: parseSuggestionsProvenance(parsed.provenance),
    objects: parsed.objects.map((o, idx) =>
      parseSuggestionObject(o, `suggestions.json.objects[${idx}]`),
    ),
    omitted_objects: omitted,
    placements: parsed.placements.map((item, idx) =>
      parseSuggestionItem(item, `suggestions.json.placements[${idx}]`),
    ),
    test_points: parsed.test_points.map((item, idx) =>
      parseSuggestionItem(item, `suggestions.json.test_points[${idx}]`),
    ),
  };
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export interface SuggestionsCsvFilter {
  objects?: ReadonlySet<string>;
  includePlacements?: boolean;
  includeTestTiers?: ReadonlySet<string>;
}

/**
 * Serialize placements and test points using the exact 17-column CSV schema
 * written by `lerobot-check suggest --csv`.
 */
export function formatSuggestionsCsv(
  suggestions: SuggestionsFile,
  filter?: SuggestionsCsvFilter,
): string {
  const lines: string[] = [SUGGESTIONS_CSV_COLUMNS.join(",")];

  const emitRow = (
    kind: "placement" | "test_point",
    item: SuggestionPointItem,
  ) => {
    if (filter?.objects && !filter.objects.has(item.object)) return;
    if (kind === "placement" && filter?.includePlacements === false) return;
    if (
      kind === "test_point" &&
      filter?.includeTestTiers &&
      !filter.includeTestTiers.has(item.tier)
    ) {
      return;
    }

    const row = [
      kind,
      item.object,
      item.arm,
      String(item.index),
      item.tier,
      item.x_m.toFixed(4),
      item.y_m.toFixed(4),
      item.z_m.toFixed(4),
      item.yaw_deg.toFixed(2),
      String(item.ix),
      String(item.iy),
      String(item.yaw_bin),
      String(item.cell_count),
      item.pixel === null ? "" : item.pixel[0].toFixed(2),
      item.pixel === null ? "" : item.pixel[1].toFixed(2),
      item.arrow_end_pixel === null ? "" : item.arrow_end_pixel[0].toFixed(2),
      item.arrow_end_pixel === null ? "" : item.arrow_end_pixel[1].toFixed(2),
    ];
    lines.push(row.map(escapeCsvCell).join(","));
  };

  for (const item of suggestions.placements) emitRow("placement", item);
  for (const item of suggestions.test_points) emitRow("test_point", item);

  return `${lines.join("\n")}\n`;
}

export function collectionTargetKey(
  kind: CollectionMaskTarget["kind"],
  item: Pick<SuggestionPointItem, "object" | "index"> & {
    tier?: SuggestionTier;
  },
): string {
  return JSON.stringify(
    kind === "placement"
      ? [kind, item.object, item.index]
      : [kind, item.object, item.tier, item.index],
  );
}

function parseMaskTargetKind(target: Record<string, unknown>) {
  const { kind, tier } = target;
  if (kind === "placement" && tier === undefined) {
    return { kind } as const;
  }
  if (
    kind === "test_point" &&
    (tier === "dense" || tier === "edge" || tier === "empty")
  ) {
    return { kind, tier } as const;
  }
  throw new Error("Invalid collection mask target kind or tier");
}

export function parseCollectionMasks(rawText: string): CollectionMaskBundle {
  const value: unknown = JSON.parse(rawText);
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    !isPlainObject(value.sources) ||
    !Array.isArray(value.targets)
  )
    throw new Error("Invalid collection mask bundle");
  const size = parsePoint2(value.image_size, "image_size");
  if (!size.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error("Invalid collection mask image size");
  }
  const keys = new Set<string>();
  const targets = value.targets.map((target: unknown): CollectionMaskTarget => {
    if (!isPlainObject(target)) {
      throw new Error("Invalid collection mask target");
    }
    const classification = parseMaskTargetKind(target);
    const object = assertString(target.object, "object");
    const index = assertInt(target.index, "index");
    if (!object || index < 1)
      throw new Error("Invalid collection mask target ID");
    const outline =
      target.outline === null
        ? null
        : Array.isArray(target.outline)
          ? target.outline.map((point: unknown) =>
              parsePoint2(point, "outline"),
            )
          : [];
    const reason =
      target.reason === null ? null : assertString(target.reason, "reason");
    if (
      outline
        ? outline.length < 3 ||
          reason !== null ||
          outline.some(
            ([x, y]) => x < 0 || y < 0 || x >= size[0] || y >= size[1],
          )
        : !reason
    ) {
      throw new Error("Invalid collection mask outline or missing reason");
    }
    const item: CollectionMaskTarget = {
      ...classification,
      object,
      index,
      outline,
      reason,
      pixel: parseNullablePoint2(target.pixel, "pixel"),
      arrow_end_pixel: parseNullablePoint2(
        target.arrow_end_pixel,
        "arrow_end_pixel",
      ),
    };
    const key = collectionTargetKey(item.kind, item);
    if (keys.has(key)) throw new Error("Duplicate collection mask target");
    keys.add(key);
    return item;
  });
  return {
    version: 1,
    repo_id: assertString(value.repo_id, "repo_id"),
    revision: assertString(value.revision, "revision"),
    camera: assertString(value.camera, "camera"),
    image_size: size,
    calibration_sha256: assertString(
      value.calibration_sha256,
      "calibration_sha256",
    ),
    suggestions_sha256: assertString(
      value.suggestions_sha256,
      "suggestions_sha256",
    ),
    sources: value.sources,
    targets,
  };
}

export function isPlanInteger(value: unknown, minimum = 1): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

export function isPlanId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  );
}

function isPlanText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function planCheck(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`Invalid collection plan: ${field}`);
}

function parsePlanTarget(
  target: unknown,
  size: [number, number],
  multi: boolean,
): CollectionPlanTarget {
  planCheck(
    isPlainObject(target) && target.kind === "placement",
    "target kind",
  );
  const { object, arm, index, reason } = target;
  planCheck(
    isPlanText(object) && isPlanText(arm) && isPlanInteger(index),
    "target identity",
  );
  const yaw = assertFiniteNumber(target.yaw_deg, "yaw_deg");
  const period = assertFiniteNumber(
    target.yaw_symmetry_deg,
    "yaw_symmetry_deg",
  );
  planCheck(
    period > 0 && period <= 360 && yaw >= 0 && yaw < period,
    "target yaw",
  );
  const inFrame = ([x, y]: TargetPolygonVertex) =>
    x >= 0 && y >= 0 && x < size[0] && y < size[1];
  const pixel = parsePoint2(target.pixel, "pixel");
  planCheck(inFrame(pixel), "target pixel");
  const base = {
    kind: "placement" as const,
    object,
    arm,
    index,
    pixel,
    x_m: assertFiniteNumber(target.x_m, "x_m"),
    y_m: assertFiniteNumber(target.y_m, "y_m"),
    z_m: assertFiniteNumber(target.z_m, "z_m"),
    yaw_deg: yaw,
    yaw_symmetry_deg: period,
    arrow_end_pixel: parsePoint2(target.arrow_end_pixel, "arrow_end_pixel"),
  };
  if (target.outline === null) {
    planCheck(
      !multi && isPlanText(reason) && target.outline_plane_z_m === null,
      "unprojectable target",
    );
    return { ...base, outline: null, reason, outline_plane_z_m: null };
  }
  planCheck(
    Array.isArray(target.outline) &&
      target.outline.length >= 3 &&
      reason === null,
    "target outline",
  );
  const outline = target.outline.map((point: unknown) =>
    parsePoint2(point, "outline"),
  );
  planCheck(outline.every(inFrame), "target outline bounds");
  return {
    ...base,
    outline,
    reason,
    outline_plane_z_m: assertFiniteNumber(
      target.outline_plane_z_m,
      "outline_plane_z_m",
    ),
  };
}

function parsePlanSettings(value: unknown): CollectionPlan["settings"] {
  planCheck(isPlainObject(value), "settings");
  planCheck(
    isPlanInteger(value.round_count) &&
      isPlanInteger(value.objects_per_round) &&
      isPlanInteger(value.seed, 0),
    "settings counts and seed",
  );
  planCheck(
    assertFiniteNumber(value.min_revisit_distance_m, "min_revisit_distance_m") >
      0 && isPlanText(value.region_source),
    "settings region",
  );
  return value as CollectionPlan["settings"];
}

function parsePlanRounds(
  value: Record<string, unknown>,
  size: [number, number],
  settings: CollectionPlan["settings"],
): CollectionPlanRound[] {
  planCheck(
    Array.isArray(value.rounds) &&
      isPlanInteger(value.next_round_id) &&
      isPlanInteger(value.source_episode_count, 0),
    "rounds and sequence",
  );
  const { next_round_id: nextId, source_episode_count: baseline } = value;
  const ids = new Set<number>();
  const episodes = new Set<number>();
  return value.rounds.map((round: unknown) => {
    planCheck(
      isPlainObject(round) &&
        isPlanInteger(round.id) &&
        round.id < nextId &&
        !ids.has(round.id),
      "round id",
    );
    ids.add(round.id);
    planCheck(isSha(round.mask_bundle_sha256), "round mask bundle hash");
    const { status, episode_index: episode, targets: rawTargets } = round;
    if (status === "collected") {
      planCheck(
        isPlanInteger(episode, baseline) && !episodes.has(episode),
        "collected episode index",
      );
      episodes.add(episode);
    } else {
      planCheck(
        (status === "pending" || status === "skipped") && episode === null,
        "round status and episode index",
      );
    }
    planCheck(
      Array.isArray(rawTargets) && rawTargets.length > 0,
      "round targets",
    );
    const targets = rawTargets.map((target: unknown) =>
      parsePlanTarget(target, size, rawTargets.length > 1),
    );
    planCheck(
      status !== "pending" || targets.length === settings.objects_per_round,
      "pending round size",
    );
    planCheck(
      new Set(targets.map(({ object }) => object)).size === targets.length,
      "duplicate round object",
    );
    return {
      id: round.id,
      mask_bundle_sha256: round.mask_bundle_sha256,
      status,
      episode_index: episode,
      targets,
    };
  });
}

export function parseCollectionPlan(raw: string): CollectionPlan {
  const value: unknown = JSON.parse(raw);
  planCheck(
    isPlainObject(value) &&
      value.format === "lerobot-collection-plan" &&
      value.version === 1,
    "format or version",
  );
  planCheck(
    isPlanId(value.plan_id) && isPlanInteger(value.generation),
    "plan id and generation",
  );
  planCheck(
    isPlanText(value.repo_id) &&
      isPlanText(value.revision) &&
      isPlanText(value.camera),
    "dataset and camera identity",
  );
  planCheck(
    value.camera_serial === null || isPlanText(value.camera_serial),
    "camera serial",
  );
  planCheck(
    isSha(value.calibration_sha256) && isSha(value.mask_bundle_sha256),
    "hashes",
  );
  const size = parsePoint2(value.image_size, "image_size");
  planCheck(
    size.every((n) => isPlanInteger(n)),
    "image size",
  );
  planCheck(
    isPlainObject(value.excluded_objects) &&
      Object.entries(value.excluded_objects).every(
        ([key, reason]) => isPlanText(key) && isPlanText(reason),
      ),
    "excluded objects",
  );
  const settings = parsePlanSettings(value.settings);
  const rounds = parsePlanRounds(value, size, settings);
  planCheck(
    isPlanInteger(value.next_round_id) &&
      isPlanInteger(value.source_episode_count, 0),
    "round sequence",
  );
  return {
    format: value.format,
    version: value.version,
    plan_id: value.plan_id,
    generation: value.generation,
    next_round_id: value.next_round_id,
    source_episode_count: value.source_episode_count,
    repo_id: value.repo_id,
    revision: value.revision,
    camera: value.camera,
    camera_serial: value.camera_serial,
    image_size: size,
    calibration_sha256: value.calibration_sha256,
    mask_bundle_sha256: value.mask_bundle_sha256,
    settings,
    rounds,
    excluded_objects: value.excluded_objects as Record<string, string>,
  };
}

export function markerCodeForItem(
  kind: "placement" | "test_point",
  item: Pick<SuggestionPointItem, "index" | "tier">,
): string {
  if (kind === "placement") return String(item.index);
  if (item.tier === "dense") return `D${item.index}`;
  if (item.tier === "edge") return `E${item.index}`;
  return `X${item.index}`;
}
