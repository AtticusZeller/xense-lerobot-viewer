import type {
  DistributionAnnotatorCounts,
  DistributionCoverageBin,
  DistributionCoverageConfig,
  DistributionEpisodeEntry,
  DistributionEpisodeSubtask,
  DistributionFile,
  DistributionFrameShareEntry,
  DistributionFrameShares,
  DistributionObjectCoverage,
  DistributionObjectEntry,
  DistributionObjectPose,
  DistributionObjectSkipped,
  DistributionPose,
  DistributionPositionPoint,
  DistributionProvenance,
  DistributionRot6d,
  DistributionSubtaskArmData,
  DistributionSubtaskArmEpisode,
  DistributionSubtaskArmMetrics,
  DistributionSubtaskEntry,
  DistributionTrajectoryPoint,
} from "@/types/distribution.types";

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

function assertInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid ${label}: expected integer`);
  }
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected string`);
  }
  return value;
}

function assertNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label}: expected string or null`);
  }
  return value;
}

function parseIntList(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected array`);
  }
  return value.map((item, idx) =>
    assertNonNegativeInt(item, `${label}[${idx}]`),
  );
}

function parseRot6d(value: unknown, label: string): DistributionRot6d {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new Error(`Invalid ${label}: expected 6-element rot6d array`);
  }
  return value.map((v, idx) =>
    assertFiniteNumber(v, `${label}[${idx}]`),
  ) as DistributionRot6d;
}

function parseAnnotatorCounts(
  raw: unknown,
  label: string,
): DistributionAnnotatorCounts {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return {
    agent: assertNonNegativeInt(raw.agent, `${label}.agent`),
    human: assertNonNegativeInt(raw.human, `${label}.human`),
    converted: assertNonNegativeInt(raw.converted, `${label}.converted`),
    total: assertNonNegativeInt(raw.total, `${label}.total`),
  };
}

function parseProvenance(raw: unknown): DistributionProvenance {
  if (!isPlainObject(raw)) {
    throw new Error("Invalid provenance: expected object");
  }
  const posPoint = raw.position_point;
  if (posPoint !== "tool_point" && posPoint !== "tcp") {
    throw new Error(
      `Invalid provenance.position_point: expected "tool_point" or "tcp"`,
    );
  }
  const calibratedArms = Array.isArray(raw.calibrated_arms)
    ? raw.calibrated_arms.map((item, idx) =>
        assertString(item, `provenance.calibrated_arms[${idx}]`),
      )
    : [];

  return {
    repo_id: assertString(raw.repo_id, "provenance.repo_id"),
    revision: assertString(raw.revision, "provenance.revision"),
    task_name: typeof raw.task_name === "string" ? raw.task_name : "",
    annotations_path: assertNullableString(
      raw.annotations_path,
      "provenance.annotations_path",
    ),
    task_spec_path: assertNullableString(
      raw.task_spec_path,
      "provenance.task_spec_path",
    ),
    position_point: posPoint as DistributionPositionPoint,
    calib_path: assertNullableString(raw.calib_path, "provenance.calib_path"),
    calib_mtime: assertNullableString(
      raw.calib_mtime,
      "provenance.calib_mtime",
    ),
    calibrated_arms: calibratedArms,
    fps: assertFiniteNumber(raw.fps, "provenance.fps"),
    annotator_counts: parseAnnotatorCounts(
      raw.annotator_counts,
      "provenance.annotator_counts",
    ),
    dataset_total_episodes: assertNonNegativeInt(
      raw.dataset_total_episodes,
      "provenance.dataset_total_episodes",
    ),
    episode_filter:
      raw.episode_filter === null || raw.episode_filter === undefined
        ? null
        : parseIntList(raw.episode_filter, "provenance.episode_filter"),
    annotated_episodes: parseIntList(
      raw.annotated_episodes,
      "provenance.annotated_episodes",
    ),
    skipped_episodes: parseIntList(
      raw.skipped_episodes,
      "provenance.skipped_episodes",
    ),
  };
}

function parseCoverageConfig(raw: unknown): DistributionCoverageConfig {
  if (!isPlainObject(raw)) {
    throw new Error("Invalid coverage_config: expected object");
  }
  const xyBinM = assertFiniteNumber(raw.xy_bin_m, "coverage_config.xy_bin_m");
  const yawBinDeg = assertFiniteNumber(
    raw.yaw_bin_deg,
    "coverage_config.yaw_bin_deg",
  );
  if (xyBinM <= 0 || yawBinDeg <= 0) {
    throw new Error("Invalid coverage_config: bin sizes must be positive");
  }
  return {
    xy_bin_m: xyBinM,
    yaw_bin_deg: yawBinDeg,
    sparse_threshold: assertNonNegativeInt(
      raw.sparse_threshold,
      "coverage_config.sparse_threshold",
    ),
  };
}

function parseFrameShares(raw: unknown): DistributionFrameShares {
  if (!isPlainObject(raw)) {
    throw new Error("Invalid frame_shares: expected object");
  }
  if (!Array.isArray(raw.subtasks)) {
    throw new Error("Invalid frame_shares.subtasks: expected array");
  }
  const subtasks: DistributionFrameShareEntry[] = raw.subtasks.map(
    (item, idx) => {
      if (!isPlainObject(item)) {
        throw new Error(
          `Invalid frame_shares.subtasks[${idx}]: expected object`,
        );
      }
      return {
        subtask: assertString(
          item.subtask,
          `frame_shares.subtasks[${idx}].subtask`,
        ),
        episodes: assertNonNegativeInt(
          item.episodes,
          `frame_shares.subtasks[${idx}].episodes`,
        ),
        frames: assertNonNegativeInt(
          item.frames,
          `frame_shares.subtasks[${idx}].frames`,
        ),
        share: assertFiniteNumber(
          item.share,
          `frame_shares.subtasks[${idx}].share`,
        ),
      };
    },
  );
  return {
    total_frames: assertNonNegativeInt(
      raw.total_frames,
      "frame_shares.total_frames",
    ),
    subtasks,
  };
}

function parseEpisodes(raw: unknown): DistributionEpisodeEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid episodes: expected array");
  }
  return raw.map((item, idx) => {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid episodes[${idx}]: expected object`);
    }
    if (!Array.isArray(item.subtasks)) {
      throw new Error(`Invalid episodes[${idx}].subtasks: expected array`);
    }
    const subtasks: DistributionEpisodeSubtask[] = item.subtasks.map(
      (sub, sIdx) => {
        if (!isPlainObject(sub)) {
          throw new Error(
            `Invalid episodes[${idx}].subtasks[${sIdx}]: expected object`,
          );
        }
        return {
          subtask: assertString(
            sub.subtask,
            `episodes[${idx}].subtasks[${sIdx}].subtask`,
          ),
          start: assertNonNegativeInt(
            sub.start,
            `episodes[${idx}].subtasks[${sIdx}].start`,
          ),
          end: assertNonNegativeInt(
            sub.end,
            `episodes[${idx}].subtasks[${sIdx}].end`,
          ),
          frames: assertNonNegativeInt(
            sub.frames,
            `episodes[${idx}].subtasks[${sIdx}].frames`,
          ),
          grasp:
            sub.grasp === null || sub.grasp === undefined
              ? null
              : assertNonNegativeInt(
                  sub.grasp,
                  `episodes[${idx}].subtasks[${sIdx}].grasp`,
                ),
          success: Boolean(sub.success),
          annotator: assertString(
            sub.annotator,
            `episodes[${idx}].subtasks[${sIdx}].annotator`,
          ),
        };
      },
    );
    return {
      episode_index: assertNonNegativeInt(
        item.episode_index,
        `episodes[${idx}].episode_index`,
      ),
      length: assertNonNegativeInt(item.length, `episodes[${idx}].length`),
      subtasks,
    };
  });
}

function parseObjectCoverage(
  raw: unknown,
  label: string,
): DistributionObjectCoverage {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  const parseRange = (v: unknown, rLabel: string): [number, number] | null => {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.length !== 2) {
      throw new Error(`Invalid ${rLabel}: expected [min, max] or null`);
    }
    return [assertInt(v[0], `${rLabel}[0]`), assertInt(v[1], `${rLabel}[1]`)];
  };
  if (!Array.isArray(raw.bins)) {
    throw new Error(`Invalid ${label}.bins: expected array`);
  }
  const bins: DistributionCoverageBin[] = raw.bins.map((bin, idx) => {
    if (!isPlainObject(bin)) {
      throw new Error(`Invalid ${label}.bins[${idx}]: expected object`);
    }
    return {
      ix: assertInt(bin.ix, `${label}.bins[${idx}].ix`),
      iy: assertInt(bin.iy, `${label}.bins[${idx}].iy`),
      yaw_bin: assertNonNegativeInt(
        bin.yaw_bin,
        `${label}.bins[${idx}].yaw_bin`,
      ),
      x_min_m: assertFiniteNumber(bin.x_min_m, `${label}.bins[${idx}].x_min_m`),
      x_max_m: assertFiniteNumber(bin.x_max_m, `${label}.bins[${idx}].x_max_m`),
      y_min_m: assertFiniteNumber(bin.y_min_m, `${label}.bins[${idx}].y_min_m`),
      y_max_m: assertFiniteNumber(bin.y_max_m, `${label}.bins[${idx}].y_max_m`),
      yaw_min_deg: assertFiniteNumber(
        bin.yaw_min_deg,
        `${label}.bins[${idx}].yaw_min_deg`,
      ),
      yaw_max_deg: assertFiniteNumber(
        bin.yaw_max_deg,
        `${label}.bins[${idx}].yaw_max_deg`,
      ),
      count: assertNonNegativeInt(bin.count, `${label}.bins[${idx}].count`),
    };
  });
  return {
    sample_count: assertNonNegativeInt(
      raw.sample_count,
      `${label}.sample_count`,
    ),
    xy_bin_m: assertFiniteNumber(raw.xy_bin_m, `${label}.xy_bin_m`),
    yaw_bin_deg: assertFiniteNumber(raw.yaw_bin_deg, `${label}.yaw_bin_deg`),
    sparse_threshold: assertNonNegativeInt(
      raw.sparse_threshold,
      `${label}.sparse_threshold`,
    ),
    num_yaw_bins: assertNonNegativeInt(
      raw.num_yaw_bins,
      `${label}.num_yaw_bins`,
    ),
    ix_range: parseRange(raw.ix_range, `${label}.ix_range`),
    iy_range: parseRange(raw.iy_range, `${label}.iy_range`),
    bins,
  };
}

function parseObjects(raw: unknown): DistributionObjectEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid objects: expected array");
  }
  return raw.map((item, idx) => {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid objects[${idx}]: expected object`);
    }
    const event = item.event;
    if (event !== "grasp" && event !== "release") {
      throw new Error(
        `Invalid objects[${idx}].event: expected "grasp" or "release"`,
      );
    }
    if (!Array.isArray(item.poses)) {
      throw new Error(`Invalid objects[${idx}].poses: expected array`);
    }
    const poses: DistributionObjectPose[] = item.poses.map((pose, pIdx) => {
      if (!isPlainObject(pose)) {
        throw new Error(
          `Invalid objects[${idx}].poses[${pIdx}]: expected object`,
        );
      }
      return {
        episode_index: assertNonNegativeInt(
          pose.episode_index,
          `objects[${idx}].poses[${pIdx}].episode_index`,
        ),
        frame: assertNonNegativeInt(
          pose.frame,
          `objects[${idx}].poses[${pIdx}].frame`,
        ),
        arm: assertString(pose.arm, `objects[${idx}].poses[${pIdx}].arm`),
        x_m: assertFiniteNumber(pose.x_m, `objects[${idx}].poses[${pIdx}].x_m`),
        y_m: assertFiniteNumber(pose.y_m, `objects[${idx}].poses[${pIdx}].y_m`),
        z_m: assertFiniteNumber(pose.z_m, `objects[${idx}].poses[${pIdx}].z_m`),
        raw_yaw_deg: assertFiniteNumber(
          pose.raw_yaw_deg,
          `objects[${idx}].poses[${pIdx}].raw_yaw_deg`,
        ),
        folded_yaw_deg: assertFiniteNumber(
          pose.folded_yaw_deg,
          `objects[${idx}].poses[${pIdx}].folded_yaw_deg`,
        ),
        rot6d: parseRot6d(pose.rot6d, `objects[${idx}].poses[${pIdx}].rot6d`),
      };
    });
    const skipped: DistributionObjectSkipped[] = Array.isArray(item.skipped)
      ? item.skipped.map((skip, sIdx) => {
          if (!isPlainObject(skip)) {
            throw new Error(
              `Invalid objects[${idx}].skipped[${sIdx}]: expected object`,
            );
          }
          return {
            episode_index: assertNonNegativeInt(
              skip.episode_index,
              `objects[${idx}].skipped[${sIdx}].episode_index`,
            ),
            reason: assertString(
              skip.reason,
              `objects[${idx}].skipped[${sIdx}].reason`,
            ),
          };
        })
      : [];

    return {
      name: assertString(item.name, `objects[${idx}].name`),
      subtask: assertString(item.subtask, `objects[${idx}].subtask`),
      event,
      arm: assertString(item.arm, `objects[${idx}].arm`),
      yaw_symmetry_deg: assertFiniteNumber(
        item.yaw_symmetry_deg,
        `objects[${idx}].yaw_symmetry_deg`,
      ),
      median_z_m:
        item.median_z_m === null || item.median_z_m === undefined
          ? null
          : assertFiniteNumber(item.median_z_m, `objects[${idx}].median_z_m`),
      poses,
      skipped,
      coverage: parseObjectCoverage(item.coverage, `objects[${idx}].coverage`),
    };
  });
}

function parseStartSource(
  raw: unknown,
  label: string,
): { start_source?: "grasp" | "start" } {
  if (raw === undefined) return {};
  if (raw === "grasp" || raw === "start") return { start_source: raw };
  throw new Error(`Invalid ${label}: expected "grasp" or "start"`);
}

function parsePose(raw: unknown, label: string): DistributionPose {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return {
    x_m: assertFiniteNumber(raw.x_m, `${label}.x_m`),
    y_m: assertFiniteNumber(raw.y_m, `${label}.y_m`),
    z_m: assertFiniteNumber(raw.z_m, `${label}.z_m`),
    yaw_deg: assertFiniteNumber(raw.yaw_deg, `${label}.yaw_deg`),
    rot6d: parseRot6d(raw.rot6d, `${label}.rot6d`),
  };
}

function parseSubtaskArmMetrics(
  raw: unknown,
  label: string,
): DistributionSubtaskArmMetrics {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  if (!isPlainObject(raw.start_coverage) || !isPlainObject(raw.end_coverage)) {
    throw new Error(`Invalid ${label}: missing start_coverage or end_coverage`);
  }
  return {
    episode_count: assertNonNegativeInt(
      raw.episode_count,
      `${label}.episode_count`,
    ),
    start_coverage: {
      occupied_xy_cells: assertNonNegativeInt(
        raw.start_coverage.occupied_xy_cells,
        `${label}.start_coverage.occupied_xy_cells`,
      ),
      yaw_span_deg: assertFiniteNumber(
        raw.start_coverage.yaw_span_deg,
        `${label}.start_coverage.yaw_span_deg`,
      ),
    },
    end_coverage: {
      occupied_xy_cells: assertNonNegativeInt(
        raw.end_coverage.occupied_xy_cells,
        `${label}.end_coverage.occupied_xy_cells`,
      ),
      yaw_span_deg: assertFiniteNumber(
        raw.end_coverage.yaw_span_deg,
        `${label}.end_coverage.yaw_span_deg`,
      ),
    },
    trajectory_dispersion_cm:
      raw.trajectory_dispersion_cm === null ||
      raw.trajectory_dispersion_cm === undefined
        ? null
        : assertFiniteNumber(
            raw.trajectory_dispersion_cm,
            `${label}.trajectory_dispersion_cm`,
          ),
  };
}

function parseSubtasks(raw: unknown): DistributionSubtaskEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid subtasks: expected array");
  }
  return raw.map((item, idx) => {
    if (!isPlainObject(item)) {
      throw new Error(`Invalid subtasks[${idx}]: expected object`);
    }
    const participatingArms = Array.isArray(item.participating_arms)
      ? item.participating_arms.map((arm, aIdx) =>
          assertString(arm, `subtasks[${idx}].participating_arms[${aIdx}]`),
        )
      : [];
    if (!isPlainObject(item.arms)) {
      throw new Error(`Invalid subtasks[${idx}].arms: expected object`);
    }
    const arms: Record<string, DistributionSubtaskArmData> = {};
    for (const [armName, rawArm] of Object.entries(item.arms)) {
      const armLabel = `subtasks[${idx}].arms.${armName}`;
      if (!isPlainObject(rawArm)) {
        throw new Error(`Invalid ${armLabel}: expected object`);
      }
      if (!Array.isArray(rawArm.episodes)) {
        throw new Error(`Invalid ${armLabel}.episodes: expected array`);
      }
      const episodes: DistributionSubtaskArmEpisode[] = rawArm.episodes.map(
        (ep, eIdx) => {
          const epLabel = `${armLabel}.episodes[${eIdx}]`;
          if (!isPlainObject(ep)) {
            throw new Error(`Invalid ${epLabel}: expected object`);
          }
          if (!Array.isArray(ep.trajectory)) {
            throw new Error(`Invalid ${epLabel}.trajectory: expected array`);
          }
          const trajectory: DistributionTrajectoryPoint[] = ep.trajectory.map(
            (pt, tIdx) => {
              if (!isPlainObject(pt)) {
                throw new Error(
                  `Invalid ${epLabel}.trajectory[${tIdx}]: expected object`,
                );
              }
              return {
                progress: assertFiniteNumber(
                  pt.progress,
                  `${epLabel}.trajectory[${tIdx}].progress`,
                ),
                x_m: assertFiniteNumber(
                  pt.x_m,
                  `${epLabel}.trajectory[${tIdx}].x_m`,
                ),
                y_m: assertFiniteNumber(
                  pt.y_m,
                  `${epLabel}.trajectory[${tIdx}].y_m`,
                ),
                z_m: assertFiniteNumber(
                  pt.z_m,
                  `${epLabel}.trajectory[${tIdx}].z_m`,
                ),
                yaw_deg: assertFiniteNumber(
                  pt.yaw_deg,
                  `${epLabel}.trajectory[${tIdx}].yaw_deg`,
                ),
              };
            },
          );
          return {
            episode_index: assertNonNegativeInt(
              ep.episode_index,
              `${epLabel}.episode_index`,
            ),
            start_frame: assertNonNegativeInt(
              ep.start_frame,
              `${epLabel}.start_frame`,
            ),
            ...parseStartSource(ep.start_source, `${epLabel}.start_source`),
            end_frame:
              ep.end_frame === null
                ? null
                : assertNonNegativeInt(ep.end_frame, `${epLabel}.end_frame`),
            start_pose: parsePose(ep.start_pose, `${epLabel}.start_pose`),
            end_pose:
              ep.end_pose === null
                ? null
                : parsePose(ep.end_pose, `${epLabel}.end_pose`),
            trajectory,
          };
        },
      );
      arms[armName] = {
        metrics: parseSubtaskArmMetrics(rawArm.metrics, `${armLabel}.metrics`),
        episodes,
      };
    }

    return {
      name: assertString(item.name, `subtasks[${idx}].name`),
      prompt: typeof item.prompt === "string" ? item.prompt : "",
      participating_arms: participatingArms,
      arms,
    };
  });
}

export function parseDistributionJson(rawText: string): DistributionFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Malformed distribution.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Invalid distribution.json: root must be a JSON object");
  }
  const version = assertNonNegativeInt(
    parsed.version,
    "distribution.json.version",
  );
  if (version !== 1) {
    throw new Error(
      `Unsupported distribution.json version: ${version} (expected 1)`,
    );
  }

  return {
    version,
    provenance: parseProvenance(parsed.provenance),
    coverage_config: parseCoverageConfig(parsed.coverage_config),
    trajectory_samples: assertNonNegativeInt(
      parsed.trajectory_samples,
      "distribution.json.trajectory_samples",
    ),
    frame_shares: parseFrameShares(parsed.frame_shares),
    episodes: parseEpisodes(parsed.episodes),
    objects: parseObjects(parsed.objects),
    subtasks: parseSubtasks(parsed.subtasks),
  };
}

export interface EpisodeSelectionParseResult {
  /** Null when input is blank (meaning "all available episodes"). */
  episodes: number[] | null;
  error: string | null;
}

const NON_NEGATIVE_INT_RE = /^\d+$/;

function parseNonNegativeIntToken(raw: string): number | null {
  if (!NON_NEGATIVE_INT_RE.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Parse an episode range/list expression matching `lerobot-check`'s
 * `parse_episode_filter`:
 * - Single integers: `"40"` -> `{40}`
 * - Inclusive hyphen ranges: `"0-20"` -> `[0, 20]`
 * - Half-open colon ranges: `"60:80"` -> `[60, 80)` (supports `:20` and `60:` when `totalEpisodes` is given)
 * - Separated by commas or whitespace; blank input returns `episodes: null` (all).
 */
export function parseEpisodeSelection(
  input: string,
  totalEpisodes?: number,
): EpisodeSelectionParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { episodes: null, error: null };
  }

  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const selected = new Set<number>();

  for (const token of tokens) {
    if (token.includes(":")) {
      const parts = token.split(":");
      if (parts.length !== 2) {
        return {
          episodes: null,
          error: `Invalid half-open range "${token}"`,
        };
      }
      const start = parts[0] === "" ? 0 : parseNonNegativeIntToken(parts[0]);
      const end =
        parts[1] === ""
          ? totalEpisodes !== undefined && Number.isInteger(totalEpisodes)
            ? totalEpisodes
            : null
          : parseNonNegativeIntToken(parts[1]);
      if (start === null || end === null) {
        return {
          episodes: null,
          error: `Invalid half-open range "${token}"`,
        };
      }
      if (start >= end) {
        return {
          episodes: null,
          error: `Empty or inverted range "${token}"`,
        };
      }
      if (totalEpisodes !== undefined && end > totalEpisodes) {
        return {
          episodes: null,
          error: `Range "${token}" exceeds total episodes (${totalEpisodes})`,
        };
      }
      for (let ep = start; ep < end; ep += 1) {
        selected.add(ep);
      }
    } else if (token.includes("-")) {
      const parts = token.split("-");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return {
          episodes: null,
          error: `Invalid inclusive range "${token}"`,
        };
      }
      const start = parseNonNegativeIntToken(parts[0]);
      const end = parseNonNegativeIntToken(parts[1]);
      if (start === null || end === null) {
        return {
          episodes: null,
          error: `Invalid inclusive range "${token}"`,
        };
      }
      if (start > end) {
        return {
          episodes: null,
          error: `Inverted range "${token}"`,
        };
      }
      if (totalEpisodes !== undefined && end >= totalEpisodes) {
        return {
          episodes: null,
          error: `Range "${token}" exceeds max episode index (${Math.max(0, totalEpisodes - 1)})`,
        };
      }
      for (let ep = start; ep <= end; ep += 1) {
        selected.add(ep);
      }
    } else {
      const ep = parseNonNegativeIntToken(token);
      if (ep === null) {
        return {
          episodes: null,
          error: `Invalid episode index "${token}"`,
        };
      }
      if (totalEpisodes !== undefined && ep >= totalEpisodes) {
        return {
          episodes: null,
          error: `Episode ${ep} exceeds max episode index (${Math.max(0, totalEpisodes - 1)})`,
        };
      }
      selected.add(ep);
    }
  }

  return {
    episodes: [...selected].sort((a, b) => a - b),
    error: null,
  };
}
