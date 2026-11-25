import type { CalibrationEpisodeVideoInfo } from "@/types/calibration.types";
import { frameToTime, timeToFrame } from "@/utils/subtaskEditor";
import {
  episodeTimeFromMediaTime,
  mediaTimeFromEpisodeTime,
} from "@/utils/videoSegments";

export interface SelectedCalibrationTarget {
  id: string;
  episodeIndex: number;
  frameIndex: number;
}

export interface DisplayedCalibrationFrame extends SelectedCalibrationTarget {
  videoUrl: string;
  mediaTime: number;
}

export type CalibrationFrameLoadState =
  | {
      status: "loading";
      target: SelectedCalibrationTarget;
      displayedFrame: null;
      error: null;
    }
  | {
      status: "ready";
      target: SelectedCalibrationTarget;
      displayedFrame: DisplayedCalibrationFrame;
      error: null;
    }
  | {
      status: "error";
      target: SelectedCalibrationTarget;
      displayedFrame: null;
      error: string;
    };

export type CalibrationFrameLoadEvent =
  | { type: "select"; target: SelectedCalibrationTarget }
  | { type: "media_loading" }
  | { type: "seeking" }
  | { type: "frame_confirmed"; frame: DisplayedCalibrationFrame }
  | { type: "error"; message: string };

const SEGMENT_BOUNDARY_SLACK_S = 1e-3;

export function targetsMatch(
  a: SelectedCalibrationTarget | null,
  b: SelectedCalibrationTarget | null,
): boolean {
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.episodeIndex === b.episodeIndex &&
    a.frameIndex === b.frameIndex
  );
}

export function createInitialCalibrationFrameState(
  target: SelectedCalibrationTarget,
): CalibrationFrameLoadState {
  return {
    status: "loading",
    target,
    displayedFrame: null,
    error: null,
  };
}

export function reduceCalibrationFrameState(
  state: CalibrationFrameLoadState,
  event: CalibrationFrameLoadEvent,
): CalibrationFrameLoadState {
  switch (event.type) {
    case "select": {
      if (targetsMatch(state.target, event.target)) {
        return state;
      }
      return {
        status: "loading",
        target: event.target,
        displayedFrame: null,
        error: null,
      };
    }
    case "media_loading":
    case "seeking": {
      if (state.status === "loading" && state.displayedFrame === null) {
        return state;
      }
      return {
        status: "loading",
        target: state.target,
        displayedFrame: null,
        error: null,
      };
    }
    case "frame_confirmed": {
      if (!targetsMatch(state.target, event.frame)) {
        if (state.status === "loading" && state.displayedFrame === null) {
          return state;
        }
        return {
          status: "loading",
          target: state.target,
          displayedFrame: null,
          error: null,
        };
      }
      return {
        status: "ready",
        target: state.target,
        displayedFrame: event.frame,
        error: null,
      };
    }
    case "error": {
      return {
        status: "error",
        target: state.target,
        displayedFrame: null,
        error: event.message,
      };
    }
  }
}

export function computeTargetCalibrationMediaTime(
  video: CalibrationEpisodeVideoInfo,
  frameIndex: number,
  fps: number,
): number {
  return mediaTimeFromEpisodeTime(video, frameToTime(frameIndex, fps));
}

export function decodedFrameIndexFromMediaTime(
  video: CalibrationEpisodeVideoInfo,
  mediaTimeSeconds: number,
  fps: number,
  episodeLength?: number | null,
): number | null {
  if (!Number.isFinite(mediaTimeSeconds) || !Number.isFinite(fps) || fps <= 0) {
    return null;
  }

  const segmentStart = video.isSegmented
    ? Math.max(0, video.segmentStart ?? 0)
    : 0;
  const segmentEnd =
    video.isSegmented &&
    video.segmentEnd !== undefined &&
    Number.isFinite(video.segmentEnd)
      ? video.segmentEnd
      : undefined;

  if (mediaTimeSeconds < segmentStart - SEGMENT_BOUNDARY_SLACK_S) {
    return null;
  }
  if (
    segmentEnd !== undefined &&
    mediaTimeSeconds > segmentEnd + SEGMENT_BOUNDARY_SLACK_S
  ) {
    return null;
  }

  const episodeTime = episodeTimeFromMediaTime(video, mediaTimeSeconds);
  if (
    episodeLength !== undefined &&
    episodeLength !== null &&
    Number.isFinite(episodeLength) &&
    episodeLength > 0
  ) {
    return timeToFrame(episodeTime, fps, episodeLength);
  }
  return Math.max(0, Math.floor(episodeTime * fps + 1e-6));
}

export interface MediaFrameVerificationInput {
  video: CalibrationEpisodeVideoInfo | null;
  mediaEpisodeIndex: number | null;
  selectedTarget: SelectedCalibrationTarget;
  mediaTimeSeconds: number;
  fps: number;
  episodeLength?: number | null;
  readyState: number;
  seeking: boolean;
  videoWidth: number;
  videoHeight: number;
}

export function isMediaAtSelectedFrame(
  input: MediaFrameVerificationInput,
): boolean {
  const {
    video,
    mediaEpisodeIndex,
    selectedTarget,
    mediaTimeSeconds,
    fps,
    episodeLength,
    readyState,
    seeking,
    videoWidth,
    videoHeight,
  } = input;

  if (!video || mediaEpisodeIndex !== selectedTarget.episodeIndex) {
    return false;
  }
  if (seeking || readyState < 2 || videoWidth <= 0 || videoHeight <= 0) {
    return false;
  }
  const decodedFrame = decodedFrameIndexFromMediaTime(
    video,
    mediaTimeSeconds,
    fps,
    episodeLength,
  );
  return decodedFrame === selectedTarget.frameIndex;
}

export interface CalibrationClickGuardInput {
  selectedTarget: SelectedCalibrationTarget;
  state: CalibrationFrameLoadState;
  drawnFrame: DisplayedCalibrationFrame | null;
  loading: boolean;
  error: string | null;
}

export function canAcceptCalibrationCanvasClick(
  input: CalibrationClickGuardInput,
): boolean {
  const { selectedTarget, state, drawnFrame, loading, error } = input;
  if (loading || error !== null) return false;
  if (state.status !== "ready") return false;
  if (!targetsMatch(state.target, selectedTarget)) return false;
  if (!targetsMatch(state.displayedFrame, selectedTarget)) return false;
  if (!targetsMatch(drawnFrame, selectedTarget)) return false;
  return true;
}
