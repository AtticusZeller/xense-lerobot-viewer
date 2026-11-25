import { describe, expect, test } from "bun:test";
import type {
  CalibrationEpisodeVideoInfo,
  CalibrationResidual,
} from "@/types/calibration.types";
import {
  computeResidualReviewThresholdPx,
  rankCalibrationResiduals,
} from "../calibrationData";
import {
  canAcceptCalibrationCanvasClick,
  computeTargetCalibrationMediaTime,
  createInitialCalibrationFrameState,
  decodedFrameIndexFromMediaTime,
  isMediaAtSelectedFrame,
  reduceCalibrationFrameState,
  type DisplayedCalibrationFrame,
  type SelectedCalibrationTarget,
} from "../calibrationFrameState";

const EP30_VIDEO: CalibrationEpisodeVideoInfo = {
  filename: "observation.images.head",
  url: "/api/local-datasets/test/videos/observation.images.head/chunk-000/file-003.mp4",
  isSegmented: true,
  segmentStart: 420.233333,
  segmentEnd: 510.233333,
  segmentDuration: 90,
};

const EP33_VIDEO: CalibrationEpisodeVideoInfo = {
  filename: "observation.images.head",
  url: "/api/local-datasets/test/videos/observation.images.head/chunk-000/file-003.mp4",
  isSegmented: true,
  segmentStart: 656.7,
  segmentEnd: 710.0,
  segmentDuration: 53.3,
};

const EP3_VIDEO: CalibrationEpisodeVideoInfo = {
  filename: "observation.images.head",
  url: "/api/local-datasets/test/videos/observation.images.head/chunk-000/file-000.mp4",
  isSegmented: true,
  segmentStart: 120.0,
  segmentEnd: 180.0,
  segmentDuration: 60,
};

const TARGET_EP30: SelectedCalibrationTarget = {
  id: "left-000",
  episodeIndex: 30,
  frameIndex: 2529,
};

const TARGET_EP33: SelectedCalibrationTarget = {
  id: "right-017",
  episodeIndex: 33,
  frameIndex: 669,
};

const TARGET_EP3: SelectedCalibrationTarget = {
  id: "left-001",
  episodeIndex: 3,
  frameIndex: 266,
};

describe("calibrationFrameState — decoded frame mapping", () => {
  test("midpoint seek maps back to the exact frame index via floor", () => {
    const t33 = computeTargetCalibrationMediaTime(EP33_VIDEO, 669, 30);
    expect(decodedFrameIndexFromMediaTime(EP33_VIDEO, t33, 30, 1599)).toBe(669);

    const t30 = computeTargetCalibrationMediaTime(EP30_VIDEO, 2529, 30);
    expect(decodedFrameIndexFromMediaTime(EP30_VIDEO, t30, 30, 2700)).toBe(
      2529,
    );
  });

  test("rejects media timestamps outside the episode segment (e.g. t=0 before seek)", () => {
    expect(decodedFrameIndexFromMediaTime(EP33_VIDEO, 0, 30, 1599)).toBeNull();
    expect(
      decodedFrameIndexFromMediaTime(EP33_VIDEO, 504.55, 30, 1599),
    ).toBeNull();
    expect(
      decodedFrameIndexFromMediaTime(EP33_VIDEO, 720.0, 30, 1599),
    ).toBeNull();
  });

  test("isMediaAtSelectedFrame enforces matching episode, decoded frame, readyState, dimensions, and !seeking", () => {
    const t33 = computeTargetCalibrationMediaTime(EP33_VIDEO, 669, 30);
    expect(
      isMediaAtSelectedFrame({
        video: EP33_VIDEO,
        mediaEpisodeIndex: 33,
        selectedTarget: TARGET_EP33,
        mediaTimeSeconds: t33,
        fps: 30,
        episodeLength: 1599,
        readyState: 4,
        seeking: false,
        videoWidth: 640,
        videoHeight: 480,
      }),
    ).toBe(true);

    // Wrong episode metadata (e.g. stale ep 30 video paired with ep 33 frame)
    expect(
      isMediaAtSelectedFrame({
        video: EP30_VIDEO,
        mediaEpisodeIndex: 30,
        selectedTarget: TARGET_EP33,
        mediaTimeSeconds: computeTargetCalibrationMediaTime(
          EP30_VIDEO,
          669,
          30,
        ),
        fps: 30,
        episodeLength: 2700,
        readyState: 4,
        seeking: false,
        videoWidth: 640,
        videoHeight: 480,
      }),
    ).toBe(false);

    // Still seeking
    expect(
      isMediaAtSelectedFrame({
        video: EP33_VIDEO,
        mediaEpisodeIndex: 33,
        selectedTarget: TARGET_EP33,
        mediaTimeSeconds: t33,
        fps: 30,
        episodeLength: 1599,
        readyState: 4,
        seeking: true,
        videoWidth: 640,
        videoHeight: 480,
      }),
    ).toBe(false);

    // Only HAVE_METADATA (readyState=1), decoded pixels not available yet
    expect(
      isMediaAtSelectedFrame({
        video: EP33_VIDEO,
        mediaEpisodeIndex: 33,
        selectedTarget: TARGET_EP33,
        mediaTimeSeconds: t33,
        fps: 30,
        episodeLength: 1599,
        readyState: 1,
        seeking: false,
        videoWidth: 640,
        videoHeight: 480,
      }),
    ).toBe(false);

    // Adjacent frame (off by 1 frame)
    expect(
      isMediaAtSelectedFrame({
        video: EP33_VIDEO,
        mediaEpisodeIndex: 33,
        selectedTarget: TARGET_EP33,
        mediaTimeSeconds: computeTargetCalibrationMediaTime(
          EP33_VIDEO,
          670,
          30,
        ),
        fps: 30,
        episodeLength: 1599,
        readyState: 4,
        seeking: false,
        videoWidth: 640,
        videoHeight: 480,
      }),
    ).toBe(false);
  });
});

describe("calibrationFrameState — loading state transitions", () => {
  test("initial -> seeking -> frame_confirmed -> select new frame -> loading -> confirmed", () => {
    const s0 = createInitialCalibrationFrameState(TARGET_EP30);
    expect(s0.status).toBe("loading");
    expect(s0.displayedFrame).toBeNull();

    const s1 = reduceCalibrationFrameState(s0, { type: "seeking" });
    expect(s1.status).toBe("loading");

    const ep30Displayed: DisplayedCalibrationFrame = {
      ...TARGET_EP30,
      videoUrl: EP30_VIDEO.url,
      mediaTime: computeTargetCalibrationMediaTime(EP30_VIDEO, 2529, 30),
    };
    const s2 = reduceCalibrationFrameState(s1, {
      type: "frame_confirmed",
      frame: ep30Displayed,
    });
    expect(s2.status).toBe("ready");
    expect(s2.displayedFrame).toEqual(ep30Displayed);

    // Selecting a new frame immediately invalidates the old displayed frame
    const s3 = reduceCalibrationFrameState(s2, {
      type: "select",
      target: TARGET_EP3,
    });
    expect(s3.status).toBe("loading");
    expect(s3.displayedFrame).toBeNull();
    expect(s3.target).toEqual(TARGET_EP3);

    // Stale frame_confirmed from the previous episode is ignored
    const s4 = reduceCalibrationFrameState(s3, {
      type: "frame_confirmed",
      frame: ep30Displayed,
    });
    expect(s4.status).toBe("loading");
    expect(s4.displayedFrame).toBeNull();

    // Matching frame_confirmed transitions cleanly to ready
    const ep3Displayed: DisplayedCalibrationFrame = {
      ...TARGET_EP3,
      videoUrl: EP3_VIDEO.url,
      mediaTime: computeTargetCalibrationMediaTime(EP3_VIDEO, 266, 30),
    };
    const s5 = reduceCalibrationFrameState(s4, {
      type: "frame_confirmed",
      frame: ep3Displayed,
    });
    expect(s5.status).toBe("ready");
    expect(s5.displayedFrame).toEqual(ep3Displayed);
  });

  test("error state clears displayedFrame and recovers when selecting another frame", () => {
    const s0 = createInitialCalibrationFrameState(TARGET_EP30);
    const sErr = reduceCalibrationFrameState(s0, {
      type: "error",
      message: "Failed to load video",
    });
    expect(sErr.status).toBe("error");
    expect(sErr.error).toBe("Failed to load video");
    expect(sErr.displayedFrame).toBeNull();

    const sNext = reduceCalibrationFrameState(sErr, {
      type: "select",
      target: TARGET_EP33,
    });
    expect(sNext.status).toBe("loading");
    expect(sNext.error).toBeNull();
    expect(sNext.target).toEqual(TARGET_EP33);
  });
});

describe("calibrationFrameState — click guard", () => {
  test("ignores clicks while loading, on error, or whenever displayed/drawn frame != selected frame", () => {
    const ep30Displayed: DisplayedCalibrationFrame = {
      ...TARGET_EP30,
      videoUrl: EP30_VIDEO.url,
      mediaTime: computeTargetCalibrationMediaTime(EP30_VIDEO, 2529, 30),
    };
    const readyEp30 = reduceCalibrationFrameState(
      createInitialCalibrationFrameState(TARGET_EP30),
      { type: "frame_confirmed", frame: ep30Displayed },
    );

    // Confirmed match: click accepted
    expect(
      canAcceptCalibrationCanvasClick({
        selectedTarget: TARGET_EP30,
        state: readyEp30,
        drawnFrame: ep30Displayed,
        loading: false,
        error: null,
      }),
    ).toBe(true);

    // Immediately after selection changes to ep33 (before reducer effect runs): click REJECTED
    expect(
      canAcceptCalibrationCanvasClick({
        selectedTarget: TARGET_EP33,
        state: readyEp30,
        drawnFrame: ep30Displayed,
        loading: false,
        error: null,
      }),
    ).toBe(false);

    // While episode media is loading: click REJECTED
    expect(
      canAcceptCalibrationCanvasClick({
        selectedTarget: TARGET_EP30,
        state: readyEp30,
        drawnFrame: ep30Displayed,
        loading: true,
        error: null,
      }),
    ).toBe(false);

    // When canvas has not drawn the confirmed frame yet: click REJECTED
    expect(
      canAcceptCalibrationCanvasClick({
        selectedTarget: TARGET_EP30,
        state: readyEp30,
        drawnFrame: null,
        loading: false,
        error: null,
      }),
    ).toBe(false);

    // When state is still loading: click REJECTED
    expect(
      canAcceptCalibrationCanvasClick({
        selectedTarget: TARGET_EP30,
        state: createInitialCalibrationFrameState(TARGET_EP30),
        drawnFrame: ep30Displayed,
        loading: false,
        error: null,
      }),
    ).toBe(false);

    // When error is present: click REJECTED
    expect(
      canAcceptCalibrationCanvasClick({
        selectedTarget: TARGET_EP30,
        state: readyEp30,
        drawnFrame: ep30Displayed,
        loading: false,
        error: "decode failed",
      }),
    ).toBe(false);
  });
});

describe("rankCalibrationResiduals — outlier review threshold max(3 * median, 15 px)", () => {
  test("sorts descending and flags outliers above max(3 * median, 15 px)", () => {
    const residuals: CalibrationResidual[] = [
      { id: "r-small", du: 2, dv: 0 }, // 2 px
      { id: "r-med-low", du: 3, dv: 0 }, // 3 px
      { id: "r-med", du: 3, dv: 4 }, // 5 px -> median = 5 -> 3*5 = 15 -> floor 15
      { id: "r-border", du: 15, dv: 0 }, // 15 px (not strictly above 15)
      { id: "r-outlier", du: 12, dv: 16 }, // 20 px (> 15 -> review)
    ];

    expect(computeResidualReviewThresholdPx(residuals)).toBe(15);
    const ranked = rankCalibrationResiduals(residuals);
    expect(ranked.thresholdPx).toBe(15);
    expect(ranked.items.map((i) => i.id)).toEqual([
      "r-outlier",
      "r-border",
      "r-med",
      "r-med-low",
      "r-small",
    ]);
    expect(ranked.items.map((i) => i.needsReview)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  test("uses 3 * median when median > 5 px (e.g. real right-arm head.json case)", () => {
    const residuals: CalibrationResidual[] = [
      { id: "right-015", du: -3.2, dv: -3.6 }, // ~4.8
      { id: "right-011", du: -2.1, dv: 8.1 }, // ~8.4
      { id: "right-007", du: 15.8, dv: 4.8 }, // ~16.5 (median)
      { id: "right-005", du: -23.8, dv: -5.1 }, // ~24.3
      { id: "right-017", du: 50.4, dv: 9.1 }, // ~51.2 > 3 * 16.51 = 49.54
    ];
    const ranked = rankCalibrationResiduals(residuals);
    expect(ranked.thresholdPx).toBeGreaterThan(49);
    expect(ranked.items[0].id).toBe("right-017");
    expect(ranked.items[0].needsReview).toBe(true);
    expect(ranked.items.slice(1).every((i) => !i.needsReview)).toBe(true);
  });
});
