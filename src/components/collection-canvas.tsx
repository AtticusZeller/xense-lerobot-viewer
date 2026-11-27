"use client";

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useT } from "@/context/locale-context";
import type { CalibrationEpisodeVideoInfo } from "@/types/calibration.types";
import type {
  SuggestionPointItem,
  TargetPolygonVertex,
} from "@/types/collection.types";
import {
  appendPolygonVertex,
  deletePolygonVertex,
  findNearestVertexIndex,
  markerCodeForItem,
  movePolygonVertex,
} from "@/utils/collectionData";
import { frameToTime } from "@/utils/subtaskEditor";
import { mediaTimeFromEpisodeTime } from "@/utils/videoSegments";

export interface CollectionMarkerEntry {
  key: string;
  kind: "placement" | "test_point";
  item: Pick<
    SuggestionPointItem,
    "object" | "x_m" | "y_m" | "yaw_deg" | "pixel" | "arrow_end_pixel"
  > &
    Partial<Pick<SuggestionPointItem, "tier">>;
  outline?: readonly TargetPolygonVertex[] | null;
  color: string;
  code: string;
}

export interface CollectionCanvasHandle {
  exportAnnotatedPngDataUrl: (legend: {
    title: string;
    objects: Array<{ name: string; color: string }>;
    note?: string;
  }) => string | null;
}

interface CollectionCanvasProps {
  imageSize: [number, number];
  video: CalibrationEpisodeVideoInfo | null;
  fps: number;
  loading: boolean;
  error: string | null;
  polygon: readonly TargetPolygonVertex[];
  showPolygon: boolean;
  editPolygon: boolean;
  onPolygonChange: (next: TargetPolygonVertex[]) => void;
  markers: readonly CollectionMarkerEntry[];
  highlightedKey: string | null;
  selectedOutline: readonly TargetPolygonVertex[] | null;
  calibratedMarkersOnly: boolean;
  onHoverMarker: (key: string | null) => void;
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
  scale: number,
): void {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const headLen = 6 * scale;
  ctx.save();
  ctx.strokeStyle = "#020617";
  ctx.lineWidth = 3.2 * scale;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8 * scale;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(
    x1 - headLen * Math.cos(angle - Math.PI / 6),
    y1 - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - headLen * Math.cos(angle + Math.PI / 6),
    y1 - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.stroke();
  ctx.restore();
}

function drawOutline(
  ctx: CanvasRenderingContext2D,
  outline: readonly TargetPolygonVertex[],
  color: string,
  scale: number,
) {
  ctx.beginPath();
  outline.forEach(([u, v], i) => {
    if (i === 0) ctx.moveTo(u * scale, v * scale);
    else ctx.lineTo(u * scale, v * scale);
  });
  ctx.closePath();
  ctx.fillStyle = `${color}45`;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * scale;
  ctx.fill();
  ctx.stroke();
}

function drawMarkerShape(
  ctx: CanvasRenderingContext2D,
  entry: CollectionMarkerEntry,
  scale: number,
  highlighted: boolean,
): void {
  const px = entry.item.pixel;
  if (!px) return;
  const x = px[0] * scale;
  const y = px[1] * scale;
  const r = (entry.kind === "placement" ? 8.5 : 7.5) * scale;

  if (entry.item.arrow_end_pixel) {
    drawArrow(
      ctx,
      x,
      y,
      entry.item.arrow_end_pixel[0] * scale,
      entry.item.arrow_end_pixel[1] * scale,
      entry.color,
      scale,
    );
  }

  ctx.save();
  if (highlighted) {
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = 2.6 * scale;
    ctx.beginPath();
    ctx.arc(x, y, r + 4.5 * scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = entry.color;
  ctx.strokeStyle = "#020617";
  ctx.lineWidth = 1.6 * scale;
  ctx.beginPath();

  if (entry.kind === "placement") {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (entry.item.tier === "dense") {
    // Triangle (upward)
    ctx.moveTo(x, y - r * 1.15);
    ctx.lineTo(x + r * 1.05, y + r * 0.85);
    ctx.lineTo(x - r * 1.05, y + r * 0.85);
    ctx.closePath();
  } else if (entry.item.tier === "edge") {
    // Diamond
    ctx.moveTo(x, y - r * 1.15);
    ctx.lineTo(x + r * 1.15, y);
    ctx.lineTo(x, y + r * 1.15);
    ctx.lineTo(x - r * 1.15, y);
    ctx.closePath();
  } else {
    // Empty tier: square
    ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
  }

  ctx.fill();
  ctx.stroke();

  // Crisp inner/adjacent code label
  ctx.fillStyle = "#020617";
  ctx.font = `bold ${Math.round(8.5 * scale)}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    entry.code,
    x,
    y + (entry.item.tier === "dense" ? 2 * scale : 0.5 * scale),
  );
  ctx.restore();
}

function drawPolygonLayer(
  ctx: CanvasRenderingContext2D,
  polygon: readonly TargetPolygonVertex[],
  scale: number,
  options: {
    editMode: boolean;
    hoverPixel: [number, number] | null;
    dragIndex: number | null;
  },
): void {
  if (polygon.length === 0) return;

  ctx.save();
  if (polygon.length >= 3) {
    ctx.fillStyle = "rgba(34, 211, 238, 0.14)";
    ctx.beginPath();
    ctx.moveTo(polygon[0][0] * scale, polygon[0][1] * scale);
    for (let i = 1; i < polygon.length; i += 1) {
      ctx.lineTo(polygon[i][0] * scale, polygon[i][1] * scale);
    }
    ctx.closePath();
    ctx.fill();
  }

  ctx.strokeStyle = "#22d3ee";
  ctx.lineWidth = 2 * scale;
  ctx.setLineDash([6 * scale, 4 * scale]);
  ctx.beginPath();
  ctx.moveTo(polygon[0][0] * scale, polygon[0][1] * scale);
  for (let i = 1; i < polygon.length; i += 1) {
    ctx.lineTo(polygon[i][0] * scale, polygon[i][1] * scale);
  }
  if (polygon.length >= 3) ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // Preview edge to cursor while drawing in edit mode.
  if (
    options.editMode &&
    options.dragIndex === null &&
    options.hoverPixel &&
    polygon.length >= 1
  ) {
    const last = polygon[polygon.length - 1];
    ctx.strokeStyle = "rgba(34, 211, 238, 0.55)";
    ctx.lineWidth = 1.2 * scale;
    ctx.setLineDash([3 * scale, 3 * scale]);
    ctx.beginPath();
    ctx.moveTo(last[0] * scale, last[1] * scale);
    ctx.lineTo(options.hoverPixel[0] * scale, options.hoverPixel[1] * scale);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Vertex handles
  if (options.editMode) {
    for (let i = 0; i < polygon.length; i += 1) {
      const [u, v] = polygon[i];
      const active = options.dragIndex === i;
      ctx.fillStyle = active ? "#fde047" : "#22d3ee";
      ctx.strokeStyle = "#020617";
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      ctx.arc(u * scale, v * scale, (active ? 6.5 : 5) * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ecfeff";
      ctx.font = `bold ${Math.round(9 * scale)}px monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(String(i + 1), (u + 6) * scale, (v - 4) * scale);
    }
  }
  ctx.restore();
}

export const CollectionCanvas = React.forwardRef<
  CollectionCanvasHandle,
  CollectionCanvasProps
>(function CollectionCanvas(
  {
    imageSize,
    video,
    fps,
    loading,
    error,
    polygon,
    showPolygon,
    editPolygon,
    onPolygonChange,
    markers,
    highlightedKey,
    selectedOutline,
    calibratedMarkersOnly,
    onHoverMarker,
  },
  ref,
) {
  const t = useT();
  const [imgW, imgH] = imageSize;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [videoReady, setVideoReady] = useState(false);
  const [frameRev, setFrameRev] = useState(0);
  const [hoverPixel, setHoverPixel] = useState<[number, number] | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Seek reference head video to frame 0 midpoint `(0.5)/fps`.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !video) {
      setVideoReady(false);
      return;
    }

    const sameSrc = el.getAttribute("data-src") === video.url;
    if (!sameSrc) {
      setVideoReady(false);
      el.setAttribute("data-src", video.url);
      el.src = video.url;
      el.load();
    }

    const targetTime = mediaTimeFromEpisodeTime(video, frameToTime(0, fps));
    const seekNow = () => {
      if (el.readyState < HTMLMediaElement.HAVE_METADATA) return;
      if (Math.abs(el.currentTime - targetTime) <= 1e-4) {
        setVideoReady(true);
        setFrameRev((n) => n + 1);
      } else {
        el.currentTime = targetTime;
      }
    };
    const onSeeked = () => {
      setVideoReady(true);
      setFrameRev((n) => n + 1);
    };

    el.addEventListener("loadeddata", seekNow);
    el.addEventListener("seeked", onSeeked);
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) seekNow();

    return () => {
      el.removeEventListener("loadeddata", seekNow);
      el.removeEventListener("seeked", onSeeked);
    };
  }, [fps, video]);

  const drawScene = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number, forExport: boolean) => {
      const el = videoRef.current;
      const w = imgW * scale;
      const h = imgH * scale;
      if (
        el &&
        videoReady &&
        el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        el.videoWidth > 0
      ) {
        ctx.drawImage(el, 0, 0, w, h);
      } else {
        ctx.fillStyle = "#020617";
        ctx.fillRect(0, 0, w, h);
      }

      if (showPolygon) {
        drawPolygonLayer(ctx, polygon, scale, {
          editMode: !forExport && editPolygon,
          hoverPixel: forExport ? null : hoverPixel,
          dragIndex: forExport ? null : dragIndex,
        });
      }

      const calibratedFrame =
        videoReady && el?.videoWidth === imgW && el.videoHeight === imgH;
      if (calibratedFrame) {
        if (selectedOutline)
          drawOutline(ctx, selectedOutline, "#22d3ee", scale);
        for (const marker of markers) {
          if (marker.outline)
            drawOutline(ctx, marker.outline, marker.color, scale);
        }
      }
      if (calibratedMarkersOnly && !calibratedFrame) return;

      // Draw non-highlighted first, highlighted last so it stays on top.
      for (const entry of markers) {
        if (!forExport && entry.key === highlightedKey) continue;
        drawMarkerShape(ctx, entry, scale, false);
      }
      if (!forExport && highlightedKey) {
        const active = markers.find((m) => m.key === highlightedKey);
        if (active) drawMarkerShape(ctx, active, scale, true);
      }
    },
    [
      calibratedMarkersOnly,
      dragIndex,
      editPolygon,
      highlightedKey,
      hoverPixel,
      imgH,
      imgW,
      markers,
      polygon,
      selectedOutline,
      showPolygon,
      videoReady,
    ],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = imgW;
    canvas.height = imgH;
    drawScene(ctx, 1, false);
  }, [drawScene, frameRev, imgH, imgW]);

  useImperativeHandle(
    ref,
    () => ({
      exportAnnotatedPngDataUrl: (legend) => {
        const scale = 2;
        const footerH = 92;
        const out = document.createElement("canvas");
        out.width = imgW * scale;
        out.height = imgH * scale + footerH;
        const ctx = out.getContext("2d");
        if (!ctx) return null;

        drawScene(ctx, scale, true);

        // Legend strip underneath image
        const y0 = imgH * scale;
        ctx.fillStyle = "#0b1120";
        ctx.fillRect(0, y0, out.width, footerH);
        ctx.strokeStyle = "#334155";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, y0);
        ctx.lineTo(out.width, y0);
        ctx.stroke();

        ctx.fillStyle = "#f1f5f9";
        ctx.font = "bold 18px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(legend.title, 20, y0 + 24);

        // Object color swatches
        let cursorX = 20;
        const row2Y = y0 + 54;
        ctx.font = "15px monospace";
        for (const obj of legend.objects) {
          ctx.fillStyle = obj.color;
          ctx.beginPath();
          ctx.arc(cursorX + 6, row2Y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#e2e8f0";
          ctx.fillText(obj.name, cursorX + 18, row2Y);
          cursorX += ctx.measureText(obj.name).width + 38;
        }

        // Shape key on right
        const shapeLegend =
          "● 1..N Placement   ▲ D Dense   ◆ E Edge   ■ X Empty";
        ctx.fillStyle = "#cbd5e1";
        ctx.font = "14px monospace";
        ctx.textAlign = "right";
        ctx.fillText(shapeLegend, out.width - 20, row2Y);

        if (legend.note) {
          ctx.fillStyle = "#94a3b8";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(legend.note, 20, y0 + 78);
        }

        return out.toDataURL("image/png");
      },
    }),
    [drawScene, imgH, imgW],
  );

  const eventToImagePixel = (
    e: React.MouseEvent<HTMLCanvasElement>,
  ): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const u = ((e.clientX - rect.left) / rect.width) * imgW;
    const v = ((e.clientY - rect.top) / rect.height) * imgH;
    return [
      Math.max(0, Math.min(imgW - 1, u)),
      Math.max(0, Math.min(imgH - 1, v)),
    ];
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pt = eventToImagePixel(e);
    setHoverPixel(pt);
    if (!pt) return;

    if (dragIndex !== null && editPolygon) {
      onPolygonChange(movePolygonVertex(polygon, dragIndex, pt, imageSize));
      return;
    }

    // Hover highlight for nearest marker
    let bestKey: string | null = null;
    let bestDist = 14;
    for (const m of markers) {
      if (!m.item.pixel) continue;
      const d = Math.hypot(m.item.pixel[0] - pt[0], m.item.pixel[1] - pt[1]);
      if (d < bestDist) {
        bestDist = d;
        bestKey = m.key;
      }
    }
    onHoverMarker(bestKey);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!editPolygon) return;
    const pt = eventToImagePixel(e);
    if (!pt) return;

    const hitIdx = findNearestVertexIndex(polygon, pt[0], pt[1], 10);

    // Right-click or Shift+click deletes a vertex.
    if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
      if (hitIdx !== -1) {
        e.preventDefault();
        onPolygonChange(deletePolygonVertex(polygon, hitIdx));
      }
      return;
    }

    if (e.button !== 0) return;
    if (hitIdx !== -1) {
      setDragIndex(hitIdx);
    } else {
      onPolygonChange(appendPolygonVertex(polygon, pt, imageSize));
    }
  };

  const handleMouseUp = () => {
    if (dragIndex !== null) setDragIndex(null);
  };

  const videoElement = videoRef.current;
  const mismatchedFrame =
    selectedOutline &&
    videoReady &&
    videoElement &&
    (videoElement.videoWidth !== imgW || videoElement.videoHeight !== imgH);

  return (
    <div className="flex flex-col gap-1.5">
      <video
        ref={videoRef}
        muted
        playsInline
        preload="auto"
        className="hidden"
      />
      <div className="relative overflow-hidden rounded-lg border border-white/10 bg-slate-950 select-none">
        <canvas
          ref={canvasRef}
          width={imgW}
          height={imgH}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            handleMouseUp();
            setHoverPixel(null);
            onHoverMarker(null);
          }}
          onContextMenu={(e) => {
            if (editPolygon) e.preventDefault();
          }}
          style={{ aspectRatio: `${imgW} / ${imgH}` }}
          className={`block w-full ${editPolygon ? "cursor-crosshair" : "cursor-default"}`}
        />
        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/60 text-xs text-slate-300">
            {t("calib.loadingFrame")}
          </div>
        )}
        {mismatchedFrame && (
          <p className="absolute inset-x-0 bottom-0 bg-slate-950/90 p-2 text-xs text-amber-200">
            {t("collect.masks.imageMismatch")}
          </p>
        )}
        {error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/80 p-4 text-xs text-rose-300">
            {error}
          </div>
        )}
        {hoverPixel && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/75 px-2 py-0.5 font-mono text-[11px] text-cyan-200 tabular">
            u={hoverPixel[0].toFixed(1)}, v={hoverPixel[1].toFixed(1)}
          </div>
        )}
      </div>
      {editPolygon && (
        <p className="text-[11px] text-slate-500">{t("collect.polygonHint")}</p>
      )}
    </div>
  );
});

export { markerCodeForItem };
