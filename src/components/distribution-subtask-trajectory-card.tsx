"use client";

import React, { lazy, Suspense, useMemo, useState } from "react";
import { useT } from "@/context/locale-context";
import {
  DistributionPolarHistogram,
  type PolarHistogramSeries,
} from "@/components/distribution-polar-histogram";
import type { ColoredSubtaskEpisode } from "@/components/distribution-trajectory-3d";
import type {
  DistributionCoverageConfig,
  DistributionSubtaskArmData,
  DistributionSubtaskArmEpisode,
} from "@/types/distribution.types";
import { recomputeSubtaskArmMetrics } from "@/utils/distributionMetrics";

const DistributionTrajectory3D = lazy(
  () => import("@/components/distribution-trajectory-3d"),
);

export interface DistributionGroupSlice {
  id: string;
  name: string;
  color: string;
  episodes: ReadonlySet<number>;
}

interface DistributionSubtaskTrajectoryCardProps {
  subtaskName: string;
  armName: string;
  armData: DistributionSubtaskArmData;
  coverageConfig: DistributionCoverageConfig;
  selectedEpisodes: ReadonlySet<number>;
  groups: readonly DistributionGroupSlice[];
}

const SVG_W = 420;
const SVG_H = 290;
const PAD = { left: 46, right: 16, top: 14, bottom: 30 };

export function DistributionSubtaskTrajectoryCard({
  subtaskName,
  armName,
  armData,
  coverageConfig,
  selectedEpisodes,
  groups,
}: DistributionSubtaskTrajectoryCardProps) {
  const t = useT();
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [showTrajectories, setShowTrajectories] = useState(false);

  const filteredEpisodes = useMemo<DistributionSubtaskArmEpisode[]>(
    () =>
      armData.episodes.filter((ep) => selectedEpisodes.has(ep.episode_index)),
    [armData.episodes, selectedEpisodes],
  );

  const metrics = useMemo(
    () => recomputeSubtaskArmMetrics(filteredEpisodes, coverageConfig.xy_bin_m),
    [coverageConfig.xy_bin_m, filteredEpisodes],
  );

  const coloredItems = useMemo<ColoredSubtaskEpisode[]>(() => {
    return filteredEpisodes.map((episode) => {
      const owner = groups.find((g) => g.episodes.has(episode.episode_index));
      return {
        episode,
        color: owner?.color ?? "#38bdf8",
        groupName: owner?.name ?? "",
      };
    });
  }, [filteredEpisodes, groups]);

  const groupMetrics = useMemo(() => {
    if (groups.length <= 1) return [];
    return groups.map((group) => {
      const eps = filteredEpisodes.filter((e) =>
        group.episodes.has(e.episode_index),
      );
      return {
        group,
        metrics: recomputeSubtaskArmMetrics(eps, coverageConfig.xy_bin_m),
      };
    });
  }, [coverageConfig.xy_bin_m, filteredEpisodes, groups]);

  const { startYawSeries, endYawSeries } = useMemo(() => {
    const startSeries: PolarHistogramSeries[] = groups.map((g) => ({
      id: g.id,
      label: g.name,
      color: g.color,
      yawsDeg: filteredEpisodes
        .filter((e) => g.episodes.has(e.episode_index))
        .map((e) => e.start_pose.yaw_deg),
    }));
    const endSeries: PolarHistogramSeries[] = groups.map((g) => ({
      id: g.id,
      label: g.name,
      color: g.color,
      yawsDeg: filteredEpisodes
        .filter((e) => g.episodes.has(e.episode_index))
        .flatMap((e) => (e.end_pose ? [e.end_pose.yaw_deg] : [])),
    }));
    return { startYawSeries: startSeries, endYawSeries: endSeries };
  }, [filteredEpisodes, groups]);

  const plot = useMemo(() => {
    if (filteredEpisodes.length === 0) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const includePoint = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };

    for (const ep of filteredEpisodes) {
      includePoint(ep.start_pose.x_m, ep.start_pose.y_m);
      if (ep.end_pose) includePoint(ep.end_pose.x_m, ep.end_pose.y_m);
      if (showTrajectories) {
        for (const pt of ep.trajectory) includePoint(pt.x_m, pt.y_m);
      }
    }

    const span = Math.max(maxX - minX, maxY - minY, coverageConfig.xy_bin_m);
    const padM = Math.max(span * 0.14, 0.02);
    minX -= padM;
    maxX += padM;
    minY -= padM;
    maxY += padM;

    const plotW = SVG_W - PAD.left - PAD.right;
    const plotH = SVG_H - PAD.top - PAD.bottom;
    const scale = Math.min(plotW / (maxX - minX), plotH / (maxY - minY));
    const usedW = (maxX - minX) * scale;
    const usedH = (maxY - minY) * scale;
    const offsetX = PAD.left + (plotW - usedW) / 2;
    const offsetY = PAD.top + (plotH - usedH) / 2;

    return {
      minX,
      maxX,
      minY,
      maxY,
      offsetX,
      offsetY,
      usedW,
      usedH,
      toSvgX: (x: number) => offsetX + (x - minX) * scale,
      toSvgY: (y: number) => offsetY + (maxY - y) * scale,
      arrowPx: 14,
    };
  }, [coverageConfig.xy_bin_m, filteredEpisodes, showTrajectories]);

  return (
    <div className="panel flex flex-col gap-3 p-3.5 text-xs">
      {/* Header & toggles */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h4 className="text-sm font-semibold text-slate-100">
            {subtaskName}
          </h4>
          <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] uppercase text-cyan-300">
            {armName}
          </span>
          <span className="font-mono text-[11px] text-slate-400 tabular">
            n={metrics.episode_count}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300">
            <input
              type="checkbox"
              checked={showTrajectories}
              onChange={(e) => setShowTrajectories(e.target.checked)}
              className="accent-cyan-400"
            />
            {t("dist.showTrajectory")}
          </label>

          <div className="inline-flex overflow-hidden rounded border border-white/10">
            <button
              type="button"
              onClick={() => setViewMode("2d")}
              className={`px-2 py-0.5 text-[11px] transition-colors ${
                viewMode === "2d"
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "bg-[var(--surface-1)]/60 text-slate-400 hover:text-slate-200"
              }`}
            >
              {t("dist.topDown")}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("3d")}
              className={`px-2 py-0.5 text-[11px] transition-colors ${
                viewMode === "3d"
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "bg-[var(--surface-1)]/60 text-slate-400 hover:text-slate-200"
              }`}
            >
              3D
            </button>
          </div>
        </div>
      </div>

      {/* Main plot + polar histograms & 3 metrics */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_18.5rem]">
        {/* Left: Top-down XY or 3D view */}
        <div className="flex flex-col gap-1">
          {viewMode === "3d" ? (
            <Suspense
              fallback={
                <div className="flex h-[290px] items-center justify-center rounded border border-white/10 bg-slate-950 text-slate-400">
                  {t("chart.threeDLoading")}
                </div>
              }
            >
              <DistributionTrajectory3D
                items={coloredItems}
                showTrajectories={showTrajectories}
              />
            </Suspense>
          ) : !plot ? (
            <div className="flex h-[290px] items-center justify-center rounded border border-white/10 bg-slate-950/60 text-slate-500">
              {t("dist.noPoses")}
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              className="h-[290px] w-full rounded border border-white/10 bg-slate-950 select-none"
            >
              {/* Axes */}
              <line
                x1={plot.offsetX}
                y1={plot.offsetY + plot.usedH}
                x2={plot.offsetX + plot.usedW}
                y2={plot.offsetY + plot.usedH}
                stroke="rgba(148,163,184,0.3)"
              />
              <line
                x1={plot.offsetX}
                y1={plot.offsetY}
                x2={plot.offsetX}
                y2={plot.offsetY + plot.usedH}
                stroke="rgba(148,163,184,0.3)"
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

              {/* Optional resampled trajectories + periodic yaw arrows */}
              {showTrajectories &&
                coloredItems.map(({ episode, color }) => {
                  const ptsStr = episode.trajectory
                    .map(
                      (pt) =>
                        `${plot.toSvgX(pt.x_m).toFixed(1)},${plot.toSvgY(pt.y_m).toFixed(1)}`,
                    )
                    .join(" ");
                  const step = Math.max(
                    1,
                    Math.floor(episode.trajectory.length / 8),
                  );
                  return (
                    <g key={`traj-${episode.episode_index}`}>
                      <polyline
                        points={ptsStr}
                        fill="none"
                        stroke={color}
                        strokeWidth={1.4}
                        strokeOpacity={0.7}
                      />
                      {episode.trajectory.map((pt, idx) => {
                        if (
                          idx === 0 ||
                          idx === episode.trajectory.length - 1 ||
                          idx % step !== 0
                        ) {
                          return null;
                        }
                        const cx = plot.toSvgX(pt.x_m);
                        const cy = plot.toSvgY(pt.y_m);
                        const rad = (pt.yaw_deg * Math.PI) / 180;
                        const tx = cx + 9 * Math.cos(rad);
                        const ty = cy - 9 * Math.sin(rad);
                        return (
                          <line
                            key={idx}
                            x1={cx}
                            y1={cy}
                            x2={tx}
                            y2={ty}
                            stroke={color}
                            strokeWidth={1}
                            strokeOpacity={0.75}
                          />
                        );
                      })}
                    </g>
                  );
                })}

              {/* Start (circle) & End (square) points with yaw arrows */}
              {coloredItems.map(({ episode, color, groupName }) => {
                const sx = plot.toSvgX(episode.start_pose.x_m);
                const sy = plot.toSvgY(episode.start_pose.y_m);
                const sRad = (episode.start_pose.yaw_deg * Math.PI) / 180;
                const stx = sx + plot.arrowPx * Math.cos(sRad);
                const sty = sy - plot.arrowPx * Math.sin(sRad);

                const endPose = episode.end_pose;
                const ex = endPose ? plot.toSvgX(endPose.x_m) : 0;
                const ey = endPose ? plot.toSvgY(endPose.y_m) : 0;
                const eRad = endPose ? (endPose.yaw_deg * Math.PI) / 180 : 0;
                const etx = ex + plot.arrowPx * Math.cos(eRad);
                const ety = ey - plot.arrowPx * Math.sin(eRad);

                return (
                  <g key={`se-${episode.episode_index}`}>
                    {/* Start arrow & circle */}
                    <line
                      x1={sx}
                      y1={sy}
                      x2={stx}
                      y2={sty}
                      stroke={color}
                      strokeWidth={1.5}
                    />
                    <circle
                      cx={sx}
                      cy={sy}
                      r={3.8}
                      fill={color}
                      stroke="#020617"
                      strokeWidth={1}
                    >
                      <title>{`${groupName} ep ${episode.episode_index} start (${episode.start_pose.x_m.toFixed(3)}, ${episode.start_pose.y_m.toFixed(3)}) yaw ${episode.start_pose.yaw_deg.toFixed(1)}°`}</title>
                    </circle>

                    {/* End arrow & square (absent for the last subtask) */}
                    {endPose && (
                      <>
                        <line
                          x1={ex}
                          y1={ey}
                          x2={etx}
                          y2={ety}
                          stroke="#f8fafc"
                          strokeWidth={1.4}
                        />
                        <rect
                          x={ex - 3.5}
                          y={ey - 3.5}
                          width={7}
                          height={7}
                          fill={color}
                          stroke="#f8fafc"
                          strokeWidth={1.1}
                        >
                          <title>{`${groupName} ep ${episode.episode_index} end (${endPose.x_m.toFixed(3)}, ${endPose.y_m.toFixed(3)}) yaw ${endPose.yaw_deg.toFixed(1)}°`}</title>
                        </rect>
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span>● {t("dist.startLegend")}</span>
            <span>■ {t("dist.endLegend")}</span>
          </div>
        </div>

        {/* Right: Polar yaw histograms + 3 metrics */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <DistributionPolarHistogram
              title={t("dist.startYaw")}
              series={startYawSeries}
              binDeg={coverageConfig.yaw_bin_deg}
            />
            <DistributionPolarHistogram
              title={t("dist.endYaw")}
              series={endYawSeries}
              binDeg={coverageConfig.yaw_bin_deg}
            />
          </div>

          {/* 3 exact metrics */}
          <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px] tabular">
            <div className="rounded border border-white/10 bg-black/25 px-2 py-1.5">
              <span className="block font-sans text-[10px] text-slate-400">
                {t("dist.metricStartCoverage")}
              </span>
              <span className="text-slate-100">
                {metrics.start_coverage.occupied_xy_cells} cells
              </span>
              <span className="block text-[10px] text-cyan-300">
                {metrics.start_coverage.yaw_span_deg.toFixed(1)}°
              </span>
            </div>

            <div className="rounded border border-white/10 bg-black/25 px-2 py-1.5">
              <span className="block font-sans text-[10px] text-slate-400">
                {t("dist.metricEndCoverage")}
              </span>
              <span className="text-slate-100">
                {metrics.end_coverage.occupied_xy_cells} cells
              </span>
              <span className="block text-[10px] text-cyan-300">
                {metrics.end_coverage.yaw_span_deg.toFixed(1)}°
              </span>
            </div>

            <div className="rounded border border-white/10 bg-black/25 px-2 py-1.5">
              <span className="block font-sans text-[10px] text-slate-400">
                {t("dist.metricDispersion")}
              </span>
              <span className="text-slate-100">
                {metrics.trajectory_dispersion_cm !== null
                  ? `${metrics.trajectory_dispersion_cm.toFixed(2)} cm`
                  : "--"}
              </span>
            </div>
          </div>

          {/* Per-group metric breakdown when comparing multiple groups */}
          {groupMetrics.length > 0 && (
            <div className="space-y-1 rounded border border-white/10 bg-black/20 p-2 font-mono text-[10px] tabular">
              {groupMetrics.map(({ group, metrics: gm }) => (
                <div
                  key={group.id}
                  className="flex items-center justify-between gap-2 text-slate-300"
                >
                  <span className="inline-flex items-center gap-1.5 truncate font-sans">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: group.color }}
                    />
                    <span className="truncate">{group.name}</span>
                  </span>
                  <span className="shrink-0 text-slate-400">
                    {gm.start_coverage.occupied_xy_cells}/
                    {gm.end_coverage.occupied_xy_cells}c ·{" "}
                    {gm.trajectory_dispersion_cm !== null
                      ? `${gm.trajectory_dispersion_cm.toFixed(1)}cm`
                      : "--"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
