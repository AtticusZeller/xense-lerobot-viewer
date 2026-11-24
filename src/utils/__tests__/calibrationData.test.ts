import { describe, expect, it } from "bun:test";
import type {
  CalibrationFramesFile,
  CalibrationPointsFile,
} from "@/types/calibration.types";
import {
  mergeCalibrationPoints,
  parseCalibrationFramesJson,
  parseCalibrationHeadJson,
  parseCalibrationIntrinsicsJson,
  parseCalibrationPointsJson,
  serializeCalibrationPoints,
  summarizeCalibrationProgress,
} from "../calibrationData";

const SAMPLE_TCP = [0.3, 0.1, 0.25, 1, 0, 0, 0, 1, 0] as const;

function makeFramesFile(ids: string[]): CalibrationFramesFile {
  return {
    version: 1,
    repo_id: "Xense/pack_iphone_box_1119",
    revision: "3a8b398b",
    camera: "observation.images.head",
    image_size: [640, 480],
    frames: ids.map((id, idx) => ({
      id,
      arm: id.startsWith("right") ? "right" : "left",
      episode_index: idx,
      frame_index: 100 + idx * 10,
      tcp: [...SAMPLE_TCP],
    })),
  };
}

describe("calibrationData", () => {
  it("round-trips points.json, merges newly appended frames by id, and preserves untouched entries", () => {
    const initialFrames = makeFramesFile(["left-000", "left-001", "right-000"]);
    const firstWrite = mergeCalibrationPoints(initialFrames, null, [
      { id: "left-000", pixel: [312.5, 240.2] },
      { id: "left-001", skipped: true },
    ]);

    // Round-trip through JSON serialization + parser.
    const serialized = serializeCalibrationPoints(firstWrite);
    const reparsed: CalibrationPointsFile =
      parseCalibrationPointsJson(serialized);
    expect(reparsed.frames[0].pixel).toEqual([312.5, 240.2]);
    expect(reparsed.frames[0].skipped).toBeUndefined();
    expect(reparsed.frames[1].skipped).toBe(true);
    expect(reparsed.frames[1].pixel).toBeUndefined();
    expect(reparsed.frames[2].pixel).toBeUndefined();
    expect(reparsed.frames[2].skipped).toBeUndefined();

    // Simulate `lerobot-check calib-frames --append` adding two new frames and
    // user clicking only right-000, leaving left-000 and left-001 untouched.
    const appendedFrames = makeFramesFile([
      "left-000",
      "left-001",
      "right-000",
      "left-002",
      "right-001",
    ]);
    // Also attach an extra custom field on an untouched existing entry to prove preservation.
    reparsed.frames[0].note = "keep-me";
    const merged = mergeCalibrationPoints(appendedFrames, reparsed, [
      { id: "right-000", pixel: [410, 290] },
    ]);

    expect(merged.frames.map((f) => f.id)).toEqual([
      "left-000",
      "left-001",
      "right-000",
      "left-002",
      "right-001",
    ]);
    expect(merged.frames[0].pixel).toEqual([312.5, 240.2]);
    expect(merged.frames[0].note).toBe("keep-me");
    expect(merged.frames[1].skipped).toBe(true);
    expect(merged.frames[2].pixel).toEqual([410, 290]);
    expect(merged.frames[3].pixel).toBeUndefined();
    expect(merged.frames[4].pixel).toBeUndefined();

    // Progress summary counts clicked / skipped / remaining per arm.
    const progress = summarizeCalibrationProgress(merged.frames);
    expect(progress).toEqual({
      total: 5,
      clicked: 2,
      skipped: 1,
      remaining: 2,
      byArm: [
        { arm: "left", total: 3, clicked: 1, skipped: 1, remaining: 1 },
        { arm: "right", total: 2, clicked: 1, skipped: 0, remaining: 1 },
      ],
    });
  });

  it("clears mutually exclusive pixel/skipped fields cleanly on updates", () => {
    const frames = makeFramesFile(["left-000"]);
    const clicked = mergeCalibrationPoints(frames, null, [
      { id: "left-000", pixel: [100, 200] },
    ]);
    const skipped = mergeCalibrationPoints(frames, clicked, [
      { id: "left-000", skipped: true },
    ]);
    expect(skipped.frames[0].skipped).toBe(true);
    expect(skipped.frames[0].pixel).toBeUndefined();

    const cleared = mergeCalibrationPoints(frames, skipped, [
      { id: "left-000", pixel: null, skipped: null },
    ]);
    expect(cleared.frames[0].skipped).toBeUndefined();
    expect(cleared.frames[0].pixel).toBeUndefined();
  });

  it("rejects malformed frames.json, points.json, head.json, and intrinsics.json", () => {
    expect(() => parseCalibrationFramesJson("{not json")).toThrow(
      /Malformed frames\.json/,
    );
    expect(() =>
      parseCalibrationFramesJson(
        JSON.stringify({
          version: 1,
          image_size: [640, 480],
          frames: [
            {
              id: "left-000",
              arm: "left",
              episode_index: 0,
              frame_index: 10,
              tcp: [1, 2, 3], // must be 9 elements
            },
          ],
        }),
      ),
    ).toThrow(/9-element TCP/);

    expect(() =>
      parseCalibrationPointsJson(
        JSON.stringify({
          version: 1,
          image_size: [640, 480],
          frames: [
            {
              id: "left-000",
              arm: "left",
              episode_index: 0,
              frame_index: 10,
              tcp: [...SAMPLE_TCP],
              pixel: [120], // malformed pixel
            },
          ],
        }),
      ),
    ).toThrow(/expected \[u, v\]/);

    expect(() =>
      parseCalibrationHeadJson(
        JSON.stringify({
          version: 1,
          image_size: [640, 480],
          intrinsics: { fx: 600, fy: 600, cx: 320, cy: 240, distortion: [] },
          arms: {
            left: {
              T_cam_base: [[1, 0, 0]], // not 4x4
              tool_offset: [0, 0, 0],
              n_points: 1,
              rms_px: 1.0,
              loo_rms_px: 1.2,
              residuals: [],
            },
          },
        }),
      ),
    ).toThrow(/expected 4x4 matrix/);

    expect(() =>
      parseCalibrationIntrinsicsJson(
        JSON.stringify({ version: 1, image_size: [640, 480], fx: "bad" }),
      ),
    ).toThrow(/expected finite number/);
  });
});
