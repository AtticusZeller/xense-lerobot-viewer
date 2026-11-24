"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/context/locale-context";
import type {
  CalibrationEpisodeVideoInfo,
  CalibrationPixel,
  CalibrationPointEntry,
} from "@/types/calibration.types";
import type { ProjectedPixel } from "@/utils/calibrationMath";
import {
  createCoalescedSeeker,
  type CoalescedSeeker,
} from "@/utils/coalescedSeek";
import { frameToTime } from "@/utils/subtaskEditor";
import { mediaTimeFromEpisodeTime } from "@/utils/videoSegments";

interface CalibrationFrameCanvasProps {
  frame: CalibrationPointEntry;
  imageSize: [number, number];
  video: CalibrationEpisodeVideoInfo | null;
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
  const seekerRef = useRef<CoalescedSeeker | null>(null);

  const [videoReady, setVideoReady] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
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

  // Compute the currently visible crop rectangle in image pixel coordinates.
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

  // Reset pan when frame dimensions change or switching back to 1x.
  useEffect(() => {
    if (viewZoom === 1) {
      setPanCenter([imgWidth / 2, imgHeight / 2]);
    } else if (frame.pixel) {
      setPanCenter(clampPan(frame.pixel[0], frame.pixel[1], viewZoom));
    }
  }, [clampPan, frame.id, frame.pixel, imgHeight, imgWidth, viewZoom]);

  // Attach coalesced seeker to the hidden video element.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const seeker = createCoalescedSeeker(el, 1e-4);
    seekerRef.current = seeker;
    return () => {
      seeker.dispose();
      seekerRef.current = null;
    };
  }, []);

  // Seek to exact frame midpoint `(frame_index + 0.5) / fps` inside segment.
  const targetMediaTime = video
    ? mediaTimeFromEpisodeTime(video, frameToTime(frame.frame_index, fps))
    : 0;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !video) {
      setVideoReady(false);
      return;
    }

    setVideoError(null);
    const sameSrc = el.getAttribute("data-src") === video.url;
    if (!sameSrc) {
      setVideoReady(false);
      el.setAttribute("data-src", video.url);
      el.src = video.url;
      el.load();
    }

    const seekNow = () => {
      if (el.readyState < HTMLMediaElement.HAVE_METADATA) return;
      if (Math.abs(el.currentTime - targetMediaTime) <= 1e-4) {
        setVideoReady(true);
        setFrameRevision((n) => n + 1);
        return;
      }
      if (seekerRef.current) {
        seekerRef.current.request(targetMediaTime, 1e-4);
      } else {
        el.currentTime = targetMediaTime;
      }
    };

    const handleLoadedData = () => {
      seekNow();
    };
    const handleSeeked = () => {
      setVideoReady(true);
      setFrameRevision((n) => n + 1);
    };
    const handleError = () => {
      setVideoReady(false);
      setVideoError(t("calib.videoLoadError"));
    };

    el.addEventListener("loadeddata", handleLoadedData);
    el.addEventListener("seeked", handleSeeked);
    el.addEventListener("error", handleError);

    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      seekNow();
    }

    return () => {
      el.removeEventListener("loadeddata", handleLoadedData);
      el.removeEventListener("seeked", handleSeeked);
      el.removeEventListener("error", handleError);
    };
  }, [t, targetMediaTime, video]);

  // Draw the current video frame and markers onto the main canvas.
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

    if (
      el &&
      videoReady &&
      el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      el.videoWidth > 0 &&
      el.videoHeight > 0
    ) {
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
    } else {
      ctx.fillStyle = "#0b1120";
      ctx.fillRect(0, 0, imgWidth, imgHeight);
    }

    const toCanvas = (u: number, v: number): [number, number] => [
      ((u - sx) / sw) * imgWidth,
      ((v - sy) / sh) * imgHeight,
    ];

    // Connecting line between clicked and reprojected points when both exist.
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

    // Reprojected marker (amber diamond + crosshair).
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

    // Clicked marker (emerald/cyan ring + precision crosshair).
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
    frame.pixel,
    frameRevision,
    imgHeight,
    imgWidth,
    reprojected,
    videoReady,
    viewZoom,
    viewportRect,
  ]);

  // Draw the crisp zoomed magnifier loupe around the cursor.
  useEffect(() => {
    if (!loupeEnabled || !hoverPixel) return;
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
      videoReady &&
      el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      el.videoWidth > 0 &&
      el.videoHeight > 0
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

    // Center 1-pixel target crosshair.
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
    frame.pixel,
    frameRevision,
    hoverPixel,
    imgHeight,
    imgWidth,
    loupeEnabled,
    loupeMag,
    reprojected,
    videoReady,
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
    // Right-drag or Shift+drag pans when zoomed in; plain left-click places pixel.
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

  return (
    <div className="flex flex-col gap-2">
      {/* Hidden source video retained across seeks on the same MP4 shard */}
      <video
        ref={videoRef}
        muted
        playsInline
        preload="auto"
        className="hidden"
      />

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
        <canvas
          ref={canvasRef}
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
          className="block w-full cursor-crosshair"
        />

        {(loading || (!videoReady && !error && !videoError)) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/60 text-xs text-slate-300">
            {t("calib.loadingFrame")}
          </div>
        )}

        {(error || videoError) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/80 p-4 text-center text-xs text-rose-300">
            {error ?? videoError}
          </div>
        )}

        {frame.skipped && !frame.pixel && (
          <div className="pointer-events-none absolute top-3 left-3 rounded bg-slate-900/85 px-2.5 py-1 text-xs font-medium text-amber-300 border border-amber-400/30">
            {t("calib.statusSkipped")}
          </div>
        )}

        {/* Cursor coordinate readout */}
        {hoverPixel && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/75 px-2 py-0.5 font-mono text-[11px] text-cyan-200 tabular">
            u={hoverPixel.u.toFixed(1)}, v={hoverPixel.v.toFixed(1)}
          </div>
        )}

        {/* Floating pixel-accurate magnifier loupe */}
        {loupeEnabled && hoverPixel && videoReady && (
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
