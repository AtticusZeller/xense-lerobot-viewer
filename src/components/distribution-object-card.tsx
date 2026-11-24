"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/context/locale-context";
import type {
  CalibrationEpisodeMediaPayload,
  CalibrationHeadFile,
} from "@/types/calibration.types";
import type {
  DistributionCoverageConfig,
  DistributionObjectEntry,
  DistributionObjectPose,
  DistributionPositionPoint,
} from "@/types/distribution.types";
import { hasNonZeroDistortion } from "@/utils/calibrationMath";
import {
  projectBasePointToPixel,
  recomputeObjectCoverage,
} from "@/utils/distributionMetrics";
import { frameToTime } from "@/utils/subtaskEditor";
import { mediaTimeFromEpisodeTime } from "@/utils/videoSegments";

export interface EpisodeColorResolver {
  colorOf(episodeIndex: number): string;
  groupNameOf(episodeIndex: number): string;
}

interface DistributionObjectCardProps {
  encodedPath: string;
  objectEntry: DistributionObjectEntry;
  coverageConfig: DistributionCoverageConfig;
  selectedEpisodes: ReadonlySet<number>;
  selectedEpisodeList: readonly number[];
  colorResolver: EpisodeColorResolver;
  positionPoint: DistributionPositionPoint;
  calibrationHead: CalibrationHeadFile | null;
  recomputing: boolean;
  onRecompute: () => void;
}

const SVG_W = 360;
const SVG_H = 260;
const PAD = { left: 44, right: 16, top: 14, bottom: 30 };
const ARROW_LEN_M = 0.05;

function HeadCameraObjectProjection({
  encodedPath,
  head,
  arm,
  poses,
  referenceEpisodes,
  colorResolver,
}: {
  encodedPath: string;
  head: CalibrationHeadFile;
  arm: string;
  poses: readonly DistributionObjectPose[];
  referenceEpisodes: readonly number[];
  colorResolver: EpisodeColorResolver;
}) {
  const t = useT();
  const [refEpisode, setRefEpisode] = useState<number>(
    () => referenceEpisodes[0] ?? 0,
  );
  const [media, setMedia] = useState<CalibrationEpisodeMediaPayload | null>(
    null,
  );
  const [videoReady, setVideoReady] = useState(false);
  const [frameRev, setFrameRev] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const armCalib = head.arms[arm];
  const distortionWarning = hasNonZeroDistortion(head.intrinsics);
  const [imgW, imgH] = head.image_size;

  // Keep reference episode synced when selection changes and current is absent.
  useEffect(() => {
    if (
      referenceEpisodes.length > 0 &&
      !referenceEpisodes.includes(refEpisode)
    ) {
      setRefEpisode(referenceEpisodes[0]);
    }
  }, [refEpisode, referenceEpisodes]);

  useEffect(() => {
    let cancelled = false;
    setVideoReady(false);
    const params = new URLSearchParams({
      episode: String(refEpisode),
      camera: head.camera,
      includeTcp: "0",
    });
    fetch(`/api/local-datasets/${encodedPath}/calibration/episode?${params}`, {
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        setMedia(body as CalibrationEpisodeMediaPayload | null);
      })
      .catch(() => {
        if (!cancelled) setMedia(null);
      });
    return () => {
      cancelled = true;
    };
  }, [encodedPath, head.camera, refEpisode]);

  useEffect(() => {
    const el = videoRef.current;
    const videoInfo = media?.video;
    if (!el || !videoInfo) return;
    const targetTime = mediaTimeFromEpisodeTime(
      videoInfo,
      frameToTime(0, media.fps),
    );
    const seekFrame0 = () => {
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
    el.addEventListener("loadeddata", seekFrame0);
    el.addEventListener("seeked", onSeeked);
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) seekFrame0();
    return () => {
      el.removeEventListener("loadeddata", seekFrame0);
      el.removeEventListener("seeked", onSeeked);
    };
  }, [media]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const el = videoRef.current;
    if (!canvas || !armCalib) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = imgW;
    canvas.height = imgH;
    if (
      el &&
      videoReady &&
      el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      el.videoWidth > 0
    ) {
      ctx.drawImage(el, 0, 0, imgW, imgH);
    } else {
      ctx.fillStyle = "#020617";
      ctx.fillRect(0, 0, imgW, imgH);
    }

    // Project tool points directly through T_cam_base (NO tool_offset again).
    for (const pose of poses) {
      const origin = projectBasePointToPixel(
        [pose.x_m, pose.y_m, pose.z_m],
        armCalib.T_cam_base,
        head.intrinsics,
      );
      if (!origin) continue;
      const color = colorResolver.colorOf(pose.episode_index);
      const rad = (pose.folded_yaw_deg * Math.PI) / 180;
      const tip = projectBasePointToPixel(
        [
          pose.x_m + ARROW_LEN_M * Math.cos(rad),
          pose.y_m + ARROW_LEN_M * Math.sin(rad),
          pose.z_m,
        ],
        armCalib.T_cam_base,
        head.intrinsics,
      );

      ctx.save();
      if (tip) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(origin.u, origin.v);
        ctx.lineTo(tip.u, tip.v);
        ctx.stroke();

        const angle = Math.atan2(tip.v - origin.v, tip.u - origin.u);
        const headLen = 6;
        ctx.beginPath();
        ctx.moveTo(tip.u, tip.v);
        ctx.lineTo(
          tip.u - headLen * Math.cos(angle - Math.PI / 6),
          tip.v - headLen * Math.sin(angle - Math.PI / 6),
        );
        ctx.moveTo(tip.u, tip.v);
        ctx.lineTo(
          tip.u - headLen * Math.cos(angle + Math.PI / 6),
          tip.v - headLen * Math.sin(angle + Math.PI / 6),
        );
        ctx.stroke();
      }

      ctx.fillStyle = color;
      ctx.strokeStyle = "#020617";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(origin.u, origin.v, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, [
    armCalib,
    colorResolver,
    frameRev,
    head.intrinsics,
    imgH,
    imgW,
    poses,
    videoReady,
  ]);

  if (!armCalib) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
        <span>{t("dist.headProjection")}</span>
        <label className="inline-flex items-center gap-1.5">
          <span>{t("dist.refEpisode")}</span>
          <select
            value={refEpisode}
            onChange={(e) => setRefEpisode(Number(e.target.value))}
            className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-slate-200"
          >
            {(referenceEpisodes.length > 0 ? referenceEpisodes : [0]).map(
              (ep) => (
                <option key={ep} value={ep}>
                  ep {ep}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      {distortionWarning && (
        <p className="rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
          {t("calib.distortionWarning")}
        </p>
      )}
      {media?.video && (
        <video
          key={media.video.url}
          ref={videoRef}
          src={media.video.url}
          muted
          playsInline
          preload="auto"
          className="hidden"
        />
      )}
      <div className="overflow-hidden rounded border border-white/10 bg-slate-950">
        <canvas
          ref={canvasRef}
          width={imgW}
          height={imgH}
          style={{ aspectRatio: `${imgW} / ${imgH}` }}
          className="block w-full"
        />
      </div>
    </div>
  );
}

export function DistributionObjectCard({
  encodedPath,
  objectEntry,
  coverageConfig,
  selectedEpisodes,
  selectedEpisodeList,
  colorResolver,
  positionPoint,
  calibrationHead,
  recomputing,
  onRecompute,
}: DistributionObjectCardProps) {
  const t = useT();
  const [hovered, setHovered] = useState<DistributionObjectPose | null>(null);

  const summary = useMemo(
    () =>
      recomputeObjectCoverage(objectEntry, coverageConfig, selectedEpisodes),
    [coverageConfig, objectEntry, selectedEpisodes],
  );

  const plot = useMemo(() => {
    const plotW = SVG_W - PAD.left - PAD.right;
    const plotH = SVG_H - PAD.top - PAD.bottom;

    if (!summary.ix_range || !summary.iy_range) {
      return null;
    }

    const bin = summary.xy_bin_m;
    const rawMinX = summary.ix_range[0] * bin;
    const rawMaxX = (summary.ix_range[1] + 1) * bin;
    const rawMinY = summary.iy_range[0] * bin;
    const rawMaxY = (summary.iy_range[1] + 1) * bin;

    const spanX = Math.max(rawMaxX - rawMinX, bin);
    const spanY = Math.max(rawMaxY - rawMinY, bin);
    const padX = bin * 0.4;
    const padY = bin * 0.4;

    const minX = rawMinX - padX;
    const maxX = rawMaxX + padX;
    const minY = rawMinY - padY;
    const maxY = rawMaxY + padY;

    // Equal aspect ratio so angles/arrows are undistorted.
    const scale = Math.min(plotW / (maxX - minX), plotH / (maxY - minY));
    const usedW = (maxX - minX) * scale;
    const usedH = (maxY - minY) * scale;
    const offsetX = PAD.left + (plotW - usedW) / 2;
    const offsetY = PAD.top + (plotH - usedH) / 2;

    const toSvgX = (x: number) => offsetX + (x - minX) * scale;
    const toSvgY = (y: number) => offsetY + (maxY - y) * scale;

    return {
      minX,
      maxX,
      minY,
      maxY,
      scale,
      offsetX,
      offsetY,
      usedW,
      usedH,
      toSvgX,
      toSvgY,
      arrowPx: Math.max(12, Math.min(26, bin * 0.55 * scale)),
      spanX,
      spanY,
    };
  }, [summary]);

  const hasArmCalibration = Boolean(calibrationHead?.arms[objectEntry.arm]);
  const showHeadProjection =
    hasArmCalibration &&
    positionPoint === "tool_point" &&
    calibrationHead !== null;
  const showTcpNotice = hasArmCalibration && positionPoint === "tcp";

  return (
    <div className="panel flex flex-col gap-3 p-3.5 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h4 className="text-sm font-semibold text-slate-100">
            {objectEntry.name}
          </h4>
          <span className="font-mono text-[11px] text-slate-400">
            {objectEntry.subtask} · {objectEntry.event} · {objectEntry.arm}
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400 tabular">
          <span>n={summary.poses.length}</span>
          {summary.median_z_m !== null && (
            <span>z={summary.median_z_m.toFixed(3)}m</span>
          )}
          <span>sym={objectEntry.yaw_symmetry_deg}°</span>
        </div>
      </div>

      {showTcpNotice && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-400/35 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
          <span>{t("dist.calibTcpNotice")}</span>
          <button
            type="button"
            disabled={recomputing}
            onClick={onRecompute}
            className="rounded border border-amber-300/40 bg-amber-500/20 px-2 py-0.5 font-medium text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
          >
            {recomputing ? t("dist.recomputing") : t("dist.recompute")}
          </button>
        </div>
      )}

      <div
        className={`grid gap-3 ${
          showHeadProjection ? "grid-cols-1 xl:grid-cols-2" : "grid-cols-1"
        }`}
      >
        {/* Top-down XY coverage + yaw arrows */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>
              {t("dist.topDownXy")} ({(summary.xy_bin_m * 100).toFixed(0)}cm)
            </span>
            {hovered ? (
              <span className="font-mono text-cyan-200 tabular">
                ep {hovered.episode_index} ({hovered.x_m.toFixed(3)},{" "}
                {hovered.y_m.toFixed(3)}) {hovered.folded_yaw_deg.toFixed(1)}°
              </span>
            ) : (
              <span className="font-mono text-slate-500">
                {t("dist.sparseThreshold", {
                  threshold: summary.sparse_threshold,
                })}
              </span>
            )}
          </div>

          {!plot ? (
            <div className="flex h-[220px] items-center justify-center rounded border border-white/10 bg-slate-950/60 text-slate-500">
              {t("dist.noPoses")}
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              className="w-full rounded border border-white/10 bg-slate-950 select-none"
            >
              {/* Coverage grid cells shaded by count */}
              {summary.xyCells.map((cell) => {
                const x1 = plot.toSvgX(cell.x_min_m);
                const x2 = plot.toSvgX(cell.x_max_m);
                const y1 = plot.toSvgY(cell.y_max_m);
                const y2 = plot.toSvgY(cell.y_min_m);
                const w = Math.max(0, x2 - x1);
                const h = Math.max(0, y2 - y1);
                const intensity =
                  summary.maxCellCount > 0
                    ? cell.count / summary.maxCellCount
                    : 0;
                const isSparse =
                  cell.count > 0 && cell.count < summary.sparse_threshold;
                return (
                  <g key={`${cell.ix},${cell.iy}`}>
                    <rect
                      x={x1}
                      y={y1}
                      width={w}
                      height={h}
                      fill={
                        cell.count === 0
                          ? "rgba(15, 23, 42, 0.35)"
                          : `rgba(56, 189, 248, ${(0.12 + 0.38 * intensity).toFixed(2)})`
                      }
                      stroke={
                        isSparse
                          ? "rgba(251, 191, 36, 0.45)"
                          : "rgba(148, 163, 184, 0.2)"
                      }
                      strokeWidth={isSparse ? 1 : 0.7}
                    />
                    {cell.count > 0 && w >= 18 && h >= 14 && (
                      <text
                        x={x1 + w - 3}
                        y={y1 + 10}
                        fontSize="8"
                        fill="rgba(226, 232, 240, 0.55)"
                        textAnchor="end"
                        className="font-mono"
                      >
                        {cell.count}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Axes border & ticks */}
              <line
                x1={plot.offsetX}
                y1={plot.offsetY + plot.usedH}
                x2={plot.offsetX + plot.usedW}
                y2={plot.offsetY + plot.usedH}
                stroke="rgba(148,163,184,0.35)"
              />
              <line
                x1={plot.offsetX}
                y1={plot.offsetY}
                x2={plot.offsetX}
                y2={plot.offsetY + plot.usedH}
                stroke="rgba(148,163,184,0.35)"
              />
              <text
                x={plot.offsetX}
                y={SVG_H - 8}
                fontSize="9"
                fill="#94a3b8"
                className="font-mono"
              >
                {plot.minX.toFixed(2)}m
              </text>
              <text
                x={plot.offsetX + plot.usedW}
                y={SVG_H - 8}
                fontSize="9"
                fill="#94a3b8"
                textAnchor="end"
                className="font-mono"
              >
                X {plot.maxX.toFixed(2)}m
              </text>
              <text
                x={4}
                y={plot.offsetY + 9}
                fontSize="9"
                fill="#94a3b8"
                className="font-mono"
              >
                Y {plot.maxY.toFixed(2)}
              </text>
              <text
                x={4}
                y={plot.offsetY + plot.usedH}
                fontSize="9"
                fill="#94a3b8"
                className="font-mono"
              >
                {plot.minY.toFixed(2)}
              </text>

              {/* Pose points + folded-yaw arrows */}
              {summary.poses.map((pose) => {
                const cx = plot.toSvgX(pose.x_m);
                const cy = plot.toSvgY(pose.y_m);
                const rad = (pose.folded_yaw_deg * Math.PI) / 180;
                const tx = cx + plot.arrowPx * Math.cos(rad);
                const ty = cy - plot.arrowPx * Math.sin(rad);
                const color = colorResolver.colorOf(pose.episode_index);
                const angle = Math.atan2(ty - cy, tx - cx);
                const headLen = 5;
                const hx1 = tx - headLen * Math.cos(angle - Math.PI / 6);
                const hy1 = ty - headLen * Math.sin(angle - Math.PI / 6);
                const hx2 = tx - headLen * Math.cos(angle + Math.PI / 6);
                const hy2 = ty - headLen * Math.sin(angle + Math.PI / 6);

                return (
                  <g
                    key={pose.episode_index}
                    onMouseEnter={() => setHovered(pose)}
                    onMouseLeave={() => setHovered(null)}
                    className="cursor-pointer"
                  >
                    <line
                      x1={cx}
                      y1={cy}
                      x2={tx}
                      y2={ty}
                      stroke={color}
                      strokeWidth={1.6}
                    />
                    <polyline
                      points={`${hx1},${hy1} ${tx},${ty} ${hx2},${hy2}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.4}
                    />
                    <circle
                      cx={cx}
                      cy={cy}
                      r={3.5}
                      fill={color}
                      stroke="#020617"
                      strokeWidth={1}
                    />
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Optional calibrated head-camera projection */}
        {showHeadProjection && (
          <HeadCameraObjectProjection
            encodedPath={encodedPath}
            head={calibrationHead}
            arm={objectEntry.arm}
            poses={summary.poses}
            referenceEpisodes={selectedEpisodeList}
            colorResolver={colorResolver}
          />
        )}
      </div>
    </div>
  );
}
