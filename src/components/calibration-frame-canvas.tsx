"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useT } from "@/context/locale-context";
import type {
  CalibrationEpisodeVideoInfo,
  CalibrationPixel,
  CalibrationPointEntry,
} from "@/types/calibration.types";
import {
  canAcceptCalibrationCanvasClick,
  computeTargetCalibrationMediaTime,
  createInitialCalibrationFrameState,
  decodedFrameIndexFromMediaTime,
  isMediaAtSelectedFrame,
  reduceCalibrationFrameState,
  targetsMatch,
  type DisplayedCalibrationFrame,
  type SelectedCalibrationTarget,
} from "@/utils/calibrationFrameState";
import type { ProjectedPixel } from "@/utils/calibrationMath";

interface CalibrationFrameCanvasProps {
  frame: CalibrationPointEntry;
  imageSize: [number, number];
  video: CalibrationEpisodeVideoInfo | null;
  mediaEpisodeIndex: number | null;
  episodeLength?: number | null;
  fps: number;
  loading: boolean;
  error: string | null;
  reprojected: ProjectedPixel | null;
  onSetPixel: (pixel: CalibrationPixel) => void;
}

const LOUPE_SIZE = 168;
const ZOOM_LEVELS = [1, 3, 4] as const;
const LOUPE_MAGNIFICATIONS = [3, 4, 6] as const;

export function CalibrationFrameCanvas({
  frame,
  imageSize,
  video,
  mediaEpisodeIndex,
  episodeLength = null,
  fps,
  loading,
  error,
  reprojected,
  onSetPixel,
}: CalibrationFrameCanvasProps) {
  const t = useT();
  const [imgWidth, imgHeight] = imageSize;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const activeSeekTargetRef = useRef<number | null>(null);
  const drawnFrameRef = useRef<DisplayedCalibrationFrame | null>(null);

  const selectedTarget = useMemo<SelectedCalibrationTarget>(
    () => ({
      id: frame.id,
      episodeIndex: frame.episode_index,
      frameIndex: frame.frame_index,
    }),
    [frame.episode_index, frame.frame_index, frame.id],
  );

  const [frameState, dispatchFrameState] = useReducer(
    reduceCalibrationFrameState,
    selectedTarget,
    createInitialCalibrationFrameState,
  );
  const [frameRevision, setFrameRevision] = useState(0);

  const [viewZoom, setViewZoom] = useState<(typeof ZOOM_LEVELS)[number]>(1);
  const [panCenter, setPanCenter] = useState<[number, number]>([
    imgWidth / 2,
    imgHeight / 2,
  ]);
  const [loupeEnabled, setLoupeEnabled] = useState(true);
  const [loupeMag, setLoupeMag] =
    useState<(typeof LOUPE_MAGNIFICATIONS)[number]>(4);
  const [hoverPixel, setHoverPixel] = useState<{
    u: number;
    v: number;
    relX: number;
    relY: number;
  } | null>(null);

  const dragPanRef = useRef<{
    active: boolean;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);

  const clampPan = useCallback(
    (cx: number, cy: number, zoom: number): [number, number] => {
      if (zoom <= 1) return [imgWidth / 2, imgHeight / 2];
      const halfW = imgWidth / (2 * zoom);
      const halfH = imgHeight / (2 * zoom);
      return [
        Math.max(halfW, Math.min(imgWidth - halfW, cx)),
        Math.max(halfH, Math.min(imgHeight - halfH, cy)),
      ];
    },
    [imgHeight, imgWidth],
  );

  const viewportRect = useCallback(() => {
    const sw = imgWidth / viewZoom;
    const sh = imgHeight / viewZoom;
    const [cx, cy] = clampPan(panCenter[0], panCenter[1], viewZoom);
    return {
      sx: cx - sw / 2,
      sy: cy - sh / 2,
      sw,
      sh,
    };
  }, [clampPan, imgHeight, imgWidth, panCenter, viewZoom]);

  useEffect(() => {
    if (viewZoom === 1) {
      setPanCenter([imgWidth / 2, imgHeight / 2]);
    } else if (frame.pixel) {
      setPanCenter(clampPan(frame.pixel[0], frame.pixel[1], viewZoom));
    }
  }, [clampPan, frame.id, frame.pixel, imgHeight, imgWidth, viewZoom]);

  const videoMatchesEpisode =
    video !== null && mediaEpisodeIndex === selectedTarget.episodeIndex;

  const targetMediaTime = videoMatchesEpisode
    ? computeTargetCalibrationMediaTime(video, selectedTarget.frameIndex, fps)
    : null;

  useEffect(() => {
    drawnFrameRef.current = null;
    activeSeekTargetRef.current = null;
    dispatchFrameState({ type: "select", target: selectedTarget });
  }, [selectedTarget]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || loading || !videoMatchesEpisode || targetMediaTime === null) {
      drawnFrameRef.current = null;
      dispatchFrameState({ type: "media_loading" });
      return;
    }

    let cancelled = false;
    const videoUrl = video.url;

    const verifyAndConfirm = (): boolean => {
      if (cancelled) return false;
      if (loadedSrcRef.current !== videoUrl) return false;
      const ready = isMediaAtSelectedFrame({
        video,
        mediaEpisodeIndex,
        selectedTarget,
        mediaTimeSeconds: el.currentTime,
        fps,
        episodeLength,
        readyState: el.readyState,
        seeking: el.seeking,
        videoWidth: el.videoWidth,
        videoHeight: el.videoHeight,
      });
      if (!ready) return false;

      activeSeekTargetRef.current = null;
      dispatchFrameState({
        type: "frame_confirmed",
        frame: {
          ...selectedTarget,
          videoUrl,
          mediaTime: el.currentTime,
        },
      });
      setFrameRevision((n) => n + 1);
      return true;
    };

    const syncToTarget = () => {
      if (cancelled) return;
      if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
        dispatchFrameState({ type: "media_loading" });
        return;
      }

      if (verifyAndConfirm()) {
        return;
      }

      const decodedFrame = decodedFrameIndexFromMediaTime(
        video,
        el.currentTime,
        fps,
        episodeLength,
      );
      if (decodedFrame === selectedTarget.frameIndex) {
        dispatchFrameState({ type: "media_loading" });
        return;
      }

      const alreadySeekingTarget =
        el.seeking &&
        activeSeekTargetRef.current !== null &&
        Math.abs(activeSeekTargetRef.current - targetMediaTime) <= 1e-4;
      if (!alreadySeekingTarget) {
        drawnFrameRef.current = null;
        activeSeekTargetRef.current = targetMediaTime;
        dispatchFrameState({ type: "seeking" });
        el.currentTime = targetMediaTime;
      }
    };

    const handleSeeking = () => {
      if (cancelled) return;
      drawnFrameRef.current = null;
      dispatchFrameState({ type: "seeking" });
    };

    const handleEmptied = () => {
      if (cancelled) return;
      drawnFrameRef.current = null;
      activeSeekTargetRef.current = null;
      dispatchFrameState({ type: "media_loading" });
    };

    const handleError = () => {
      if (cancelled) return;
      drawnFrameRef.current = null;
      activeSeekTargetRef.current = null;
      dispatchFrameState({
        type: "error",
        message: t("calib.videoLoadError"),
      });
    };

    el.addEventListener("loadedmetadata", syncToTarget);
    el.addEventListener("loadeddata", syncToTarget);
    el.addEventListener("canplay", syncToTarget);
    el.addEventListener("seeked", syncToTarget);
    el.addEventListener("seeking", handleSeeking);
    el.addEventListener("emptied", handleEmptied);
    el.addEventListener("error", handleError);

    if (loadedSrcRef.current !== videoUrl) {
      loadedSrcRef.current = videoUrl;
      activeSeekTargetRef.current = null;
      drawnFrameRef.current = null;
      dispatchFrameState({ type: "media_loading" });
      el.src = videoUrl;
      el.load();
    } else {
      syncToTarget();
    }

    return () => {
      cancelled = true;
      el.removeEventListener("loadedmetadata", syncToTarget);
      el.removeEventListener("loadeddata", syncToTarget);
      el.removeEventListener("canplay", syncToTarget);
      el.removeEventListener("seeked", syncToTarget);
      el.removeEventListener("seeking", handleSeeking);
      el.removeEventListener("emptied", handleEmptied);
      el.removeEventListener("error", handleError);
    };
  }, [
    episodeLength,
    fps,
    loading,
    mediaEpisodeIndex,
    selectedTarget,
    t,
    targetMediaTime,
    video,
    videoMatchesEpisode,
  ]);

  const combinedError = error ?? frameState.error;
  const isConfirmedReady =
    !loading &&
    combinedError === null &&
    frameState.status === "ready" &&
    targetsMatch(frameState.target, selectedTarget) &&
    targetsMatch(frameState.displayedFrame, selectedTarget);

  useEffect(() => {
    const canvas = canvasRef.current;
    const el = videoRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = imgWidth;
    canvas.height = imgHeight;
    ctx.clearRect(0, 0, imgWidth, imgHeight);

    const { sx, sy, sw, sh } = viewportRect();

    const canDrawConfirmedVideo =
      isConfirmedReady &&
      el !== null &&
      videoMatchesEpisode &&
      isMediaAtSelectedFrame({
        video,
        mediaEpisodeIndex,
        selectedTarget,
        mediaTimeSeconds: el.currentTime,
        fps,
        episodeLength,
        readyState: el.readyState,
        seeking: el.seeking,
        videoWidth: el.videoWidth,
        videoHeight: el.videoHeight,
      });

    if (canDrawConfirmedVideo && frameState.displayedFrame) {
      const scaleX = el.videoWidth / imgWidth;
      const scaleY = el.videoHeight / imgHeight;
      ctx.imageSmoothingEnabled = viewZoom === 1;
      ctx.drawImage(
        el,
        sx * scaleX,
        sy * scaleY,
        sw * scaleX,
        sh * scaleY,
        0,
        0,
        imgWidth,
        imgHeight,
      );
      drawnFrameRef.current = frameState.displayedFrame;

      // Stamp the confirmed loaded episode / frame directly onto the canvas.
      const frameTag = `ep ${frameState.displayedFrame.episodeIndex} / frame ${frameState.displayedFrame.frameIndex}`;
      ctx.save();
      ctx.font = "600 12px monospace";
      const tagW = ctx.measureText(frameTag).width;
      ctx.fillStyle = "rgba(2, 6, 23, 0.82)";
      ctx.fillRect(8, 8, tagW + 14, 22);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.45)";
      ctx.lineWidth = 1;
      ctx.strokeRect(8.5, 8.5, tagW + 13, 21);
      ctx.fillStyle = "#e0f2fe";
      ctx.textBaseline = "middle";
      ctx.fillText(frameTag, 15, 19.5);
      ctx.restore();
    } else {
      drawnFrameRef.current = null;
      ctx.fillStyle = "#0b1120";
      ctx.fillRect(0, 0, imgWidth, imgHeight);
      return;
    }

    const toCanvas = (u: number, v: number): [number, number] => [
      ((u - sx) / sw) * imgWidth,
      ((v - sy) / sh) * imgHeight,
    ];

    if (frame.pixel && reprojected) {
      const [cx1, cy1] = toCanvas(frame.pixel[0], frame.pixel[1]);
      const [cx2, cy2] = toCanvas(reprojected.u, reprojected.v);
      ctx.save();
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(cx1, cy1);
      ctx.lineTo(cx2, cy2);
      ctx.stroke();
      ctx.restore();
    }

    if (reprojected) {
      const [rx, ry] = toCanvas(reprojected.u, reprojected.v);
      ctx.save();
      ctx.strokeStyle = "#f59e0b";
      ctx.fillStyle = "rgba(245, 158, 11, 0.25)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rx, ry - 8);
      ctx.lineTo(rx + 8, ry);
      ctx.lineTo(rx, ry + 8);
      ctx.lineTo(rx - 8, ry);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#fef3c7";
      ctx.font = "11px monospace";
      const label = `proj (${reprojected.u.toFixed(1)}, ${reprojected.v.toFixed(1)})`;
      ctx.fillText(
        label,
        Math.min(rx + 10, imgWidth - 150),
        Math.max(14, ry - 10),
      );
      ctx.restore();
    }

    if (frame.pixel) {
      const [px, py] = toCanvas(frame.pixel[0], frame.pixel[1]);
      ctx.save();
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = "#ecfdf5";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px - 12, py);
      ctx.lineTo(px - 3, py);
      ctx.moveTo(px + 3, py);
      ctx.lineTo(px + 12, py);
      ctx.moveTo(px, py - 12);
      ctx.lineTo(px, py - 3);
      ctx.moveTo(px, py + 3);
      ctx.lineTo(px, py + 12);
      ctx.stroke();

      ctx.fillStyle = "#10b981";
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#d1fae5";
      ctx.font = "11px monospace";
      const label = `(${frame.pixel[0].toFixed(1)}, ${frame.pixel[1].toFixed(1)})`;
      ctx.fillText(
        label,
        Math.min(px + 10, imgWidth - 110),
        Math.min(py + 16, imgHeight - 6),
      );
      ctx.restore();
    }
  }, [
    episodeLength,
    fps,
    frame.pixel,
    frameRevision,
    frameState.displayedFrame,
    imgHeight,
    imgWidth,
    isConfirmedReady,
    mediaEpisodeIndex,
    reprojected,
    selectedTarget,
    video,
    videoMatchesEpisode,
    viewZoom,
    viewportRect,
  ]);

  useEffect(() => {
    if (!loupeEnabled || !hoverPixel || !isConfirmedReady) return;
    const loupe = loupeCanvasRef.current;
    const el = videoRef.current;
    if (!loupe) return;
    const ctx = loupe.getContext("2d");
    if (!ctx) return;

    loupe.width = LOUPE_SIZE;
    loupe.height = LOUPE_SIZE;
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);

    const srcSpan = LOUPE_SIZE / loupeMag;
    const halfSpan = srcSpan / 2;

    if (
      el &&
      videoMatchesEpisode &&
      isMediaAtSelectedFrame({
        video,
        mediaEpisodeIndex,
        selectedTarget,
        mediaTimeSeconds: el.currentTime,
        fps,
        episodeLength,
        readyState: el.readyState,
        seeking: el.seeking,
        videoWidth: el.videoWidth,
        videoHeight: el.videoHeight,
      })
    ) {
      const scaleX = el.videoWidth / imgWidth;
      const scaleY = el.videoHeight / imgHeight;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        el,
        (hoverPixel.u - halfSpan) * scaleX,
        (hoverPixel.v - halfSpan) * scaleY,
        srcSpan * scaleX,
        srcSpan * scaleY,
        0,
        0,
        LOUPE_SIZE,
        LOUPE_SIZE,
      );
    }

    const mid = LOUPE_SIZE / 2;
    const toLoupe = (u: number, v: number): [number, number] => [
      mid + (u - hoverPixel.u) * loupeMag,
      mid + (v - hoverPixel.v) * loupeMag,
    ];

    if (reprojected) {
      const [rx, ry] = toLoupe(reprojected.u, reprojected.v);
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rx, ry, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (frame.pixel) {
      const [px, py] = toLoupe(frame.pixel[0], frame.pixel[1]);
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(56, 189, 248, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(mid - 6, mid);
    ctx.moveTo(mid + 6, mid);
    ctx.lineTo(LOUPE_SIZE, mid);
    ctx.moveTo(mid, 0);
    ctx.lineTo(mid, mid - 6);
    ctx.moveTo(mid, mid + 6);
    ctx.lineTo(mid, LOUPE_SIZE);
    ctx.stroke();

    ctx.strokeStyle = "#38bdf8";
    ctx.strokeRect(mid - loupeMag / 2, mid - loupeMag / 2, loupeMag, loupeMag);
  }, [
    episodeLength,
    fps,
    frame.pixel,
    frameRevision,
    hoverPixel,
    imgHeight,
    imgWidth,
    isConfirmedReady,
    loupeEnabled,
    loupeMag,
    mediaEpisodeIndex,
    reprojected,
    selectedTarget,
    video,
    videoMatchesEpisode,
  ]);

  const pointerToImagePixel = (
    e: React.MouseEvent<HTMLCanvasElement>,
  ): { u: number; v: number; relX: number; relY: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const normX = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    const normY = Math.max(
      0,
      Math.min(1, (e.clientY - rect.top) / rect.height),
    );
    const { sx, sy, sw, sh } = viewportRect();
    const u = Math.max(0, Math.min(imgWidth - 1, sx + normX * sw));
    const v = Math.max(0, Math.min(imgHeight - 1, sy + normY * sh));
    return {
      u,
      v,
      relX: e.clientX - rect.left,
      relY: e.clientY - rect.top,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragPanRef.current;
    if (drag?.active && viewZoom > 1) {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const { sw, sh } = viewportRect();
        const dxImg = ((e.clientX - drag.startClientX) / rect.width) * sw;
        const dyImg = ((e.clientY - drag.startClientY) / rect.height) * sh;
        setPanCenter(
          clampPan(drag.startPanX - dxImg, drag.startPanY - dyImg, viewZoom),
        );
      }
    }
    const coords = pointerToImagePixel(e);
    setHoverPixel(coords);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (viewZoom > 1 && (e.button === 2 || e.button === 1 || e.shiftKey)) {
      e.preventDefault();
      dragPanRef.current = {
        active: true,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: panCenter[0],
        startPanY: panCenter[1],
      };
      return;
    }
    if (e.button !== 0) return;

    const el = videoRef.current;
    const stateAllowsClick = canAcceptCalibrationCanvasClick({
      selectedTarget,
      state: frameState,
      drawnFrame: drawnFrameRef.current,
      loading,
      error: combinedError,
    });
    const mediaStillMatches =
      el !== null &&
      videoMatchesEpisode &&
      isMediaAtSelectedFrame({
        video,
        mediaEpisodeIndex,
        selectedTarget,
        mediaTimeSeconds: el.currentTime,
        fps,
        episodeLength,
        readyState: el.readyState,
        seeking: el.seeking,
        videoWidth: el.videoWidth,
        videoHeight: el.videoHeight,
      });

    if (!stateAllowsClick || !mediaStillMatches) {
      return;
    }

    const coords = pointerToImagePixel(e);
    if (!coords) return;
    const rounded: CalibrationPixel = [
      Math.round(coords.u * 10) / 10,
      Math.round(coords.v * 10) / 10,
    ];
    onSetPixel(rounded);
  };

  const handleMouseUp = () => {
    if (dragPanRef.current) {
      dragPanRef.current.active = false;
    }
  };

  const handleZoomChange = (nextZoom: (typeof ZOOM_LEVELS)[number]) => {
    const anchor = hoverPixel
      ? ([hoverPixel.u, hoverPixel.v] as [number, number])
      : frame.pixel
        ? ([frame.pixel[0], frame.pixel[1]] as [number, number])
        : ([imgWidth / 2, imgHeight / 2] as [number, number]);
    setViewZoom(nextZoom);
    setPanCenter(clampPan(anchor[0], anchor[1], nextZoom));
  };

  const loupeFlipX = hoverPixel
    ? hoverPixel.relX > (canvasRef.current?.clientWidth ?? 640) * 0.65
    : false;
  const loupeFlipY = hoverPixel
    ? hoverPixel.relY > (canvasRef.current?.clientHeight ?? 480) * 0.62
    : false;

  const isLoadingFrame = !isConfirmedReady && combinedError === null;

  return (
    <div className="flex flex-col gap-2">
      {/* Zoom & magnifier toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-400">{t("calib.viewZoom")}</span>
          {ZOOM_LEVELS.map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => handleZoomChange(z)}
              className={`rounded border px-2 py-0.5 font-mono transition-colors ${
                viewZoom === z
                  ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                  : "border-white/10 bg-[var(--surface-1)]/60 text-slate-300 hover:border-white/25"
              }`}
            >
              {z}x
            </button>
          ))}
          {viewZoom > 1 && (
            <span className="text-[11px] text-slate-500">
              {t("calib.panHint")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300">
            <input
              type="checkbox"
              checked={loupeEnabled}
              onChange={(e) => setLoupeEnabled(e.target.checked)}
              className="accent-cyan-400"
            />
            {t("calib.magnifier")}
          </label>
          {loupeEnabled && (
            <div className="inline-flex items-center gap-1">
              {LOUPE_MAGNIFICATIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setLoupeMag(m)}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                    loupeMag === m
                      ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                      : "border-white/10 bg-[var(--surface-1)]/60 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {m}x
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main interactive image canvas */}
      <div className="relative overflow-hidden rounded-lg border border-white/10 bg-slate-950 select-none">
        {/* Keep video rendered (not display:none) so browsers never defer decoding */}
        <video
          ref={videoRef}
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 h-px w-px opacity-0"
        />

        <canvas
          ref={canvasRef}
          data-frame-ready={isConfirmedReady ? "true" : "false"}
          data-loaded-episode={
            frameState.displayedFrame
              ? String(frameState.displayedFrame.episodeIndex)
              : ""
          }
          data-loaded-frame={
            frameState.displayedFrame
              ? String(frameState.displayedFrame.frameIndex)
              : ""
          }
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            handleMouseUp();
            setHoverPixel(null);
          }}
          onContextMenu={(e) => {
            if (viewZoom > 1) e.preventDefault();
          }}
          style={{ aspectRatio: `${imgWidth} / ${imgHeight}` }}
          className={`block w-full ${
            isConfirmedReady ? "cursor-crosshair" : "cursor-wait"
          }`}
        />

        {isLoadingFrame && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-slate-950/75 text-xs text-slate-200">
            <span>{t("calib.loadingFrame")}</span>
            <span className="font-mono text-[11px] text-cyan-300/90">
              ep {selectedTarget.episodeIndex} / frame{" "}
              {selectedTarget.frameIndex}
            </span>
          </div>
        )}

        {combinedError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/80 p-4 text-center text-xs text-rose-300">
            {combinedError}
          </div>
        )}

        {frame.skipped && !frame.pixel && isConfirmedReady && (
          <div className="pointer-events-none absolute top-3 right-3 rounded border border-amber-400/30 bg-slate-900/85 px-2.5 py-1 text-xs font-medium text-amber-300">
            {t("calib.statusSkipped")}
          </div>
        )}

        {hoverPixel && isConfirmedReady && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/75 px-2 py-0.5 font-mono text-[11px] text-cyan-200 tabular">
            u={hoverPixel.u.toFixed(1)}, v={hoverPixel.v.toFixed(1)}
          </div>
        )}

        {loupeEnabled && hoverPixel && isConfirmedReady && (
          <div
            className="pointer-events-none absolute z-20 overflow-hidden rounded-lg border border-cyan-400/70 bg-slate-950 shadow-xl"
            style={{
              width: LOUPE_SIZE,
              height: LOUPE_SIZE,
              left: loupeFlipX
                ? Math.max(8, hoverPixel.relX - LOUPE_SIZE - 18)
                : hoverPixel.relX + 18,
              top: loupeFlipY
                ? Math.max(8, hoverPixel.relY - LOUPE_SIZE - 18)
                : hoverPixel.relY + 18,
            }}
          >
            <canvas
              ref={loupeCanvasRef}
              width={LOUPE_SIZE}
              height={LOUPE_SIZE}
              className="block h-full w-full"
            />
            <div className="absolute right-1 bottom-1 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200">
              {loupeMag}x · {hoverPixel.u.toFixed(1)}, {hoverPixel.v.toFixed(1)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
