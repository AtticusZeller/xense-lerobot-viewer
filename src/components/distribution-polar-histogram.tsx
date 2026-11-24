"use client";

import React, { useMemo } from "react";
import { computeYawPolarHistogram } from "@/utils/distributionMetrics";

export interface PolarHistogramSeries {
  id: string;
  label: string;
  color: string;
  yawsDeg: number[];
}

interface DistributionPolarHistogramProps {
  title: string;
  series: readonly PolarHistogramSeries[];
  binDeg: number;
}

const SIZE = 136;
const CENTER = SIZE / 2;
const MAX_R = 46;
const INNER_R = 8;

function polarToCartesian(radius: number, angleDeg: number): [number, number] {
  // 0° points right (+X), 90° points up (+Y) to match top-down XY orientation.
  const rad = (angleDeg * Math.PI) / 180;
  return [CENTER + radius * Math.cos(rad), CENTER - radius * Math.sin(rad)];
}

function wedgePath(
  rInner: number,
  rOuter: number,
  startDeg: number,
  endDeg: number,
): string {
  const [x1, y1] = polarToCartesian(rOuter, startDeg);
  const [x2, y2] = polarToCartesian(rOuter, endDeg);
  const [x3, y3] = polarToCartesian(rInner, endDeg);
  const [x4, y4] = polarToCartesian(rInner, startDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  // Counter-clockwise on screen (sweep=0) corresponds to increasing math angle.
  return [
    `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `A ${rOuter.toFixed(2)} ${rOuter.toFixed(2)} 0 ${largeArc} 0 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    `A ${rInner.toFixed(2)} ${rInner.toFixed(2)} 0 ${largeArc} 1 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
    "Z",
  ].join(" ");
}

export function DistributionPolarHistogram({
  title,
  series,
  binDeg,
}: DistributionPolarHistogramProps) {
  const { binsPerSeries, totals, maxCount } = useMemo(() => {
    const computed = series.map((s) => ({
      ...s,
      bins: computeYawPolarHistogram(s.yawsDeg, binDeg),
    }));
    const numBins =
      computed[0]?.bins.length ?? Math.max(1, Math.round(360 / binDeg));
    const binTotals = new Array<number>(numBins).fill(0);
    for (const s of computed) {
      for (let i = 0; i < numBins; i += 1) {
        binTotals[i] += s.bins[i]?.count ?? 0;
      }
    }
    const maxVal = Math.max(1, ...binTotals);
    return { binsPerSeries: computed, totals: binTotals, maxCount: maxVal };
  }, [binDeg, series]);

  const numBins = totals.length;
  const totalSamples = totals.reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col items-center rounded border border-white/10 bg-black/25 px-2 py-2">
      <div className="flex w-full items-center justify-between text-[10px] text-slate-400">
        <span className="truncate font-medium text-slate-300">{title}</span>
        <span className="font-mono tabular">n={totalSamples}</span>
      </div>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="h-32 w-32 select-none"
        role="img"
        aria-label={title}
      >
        {/* Concentric reference rings */}
        {[0.5, 1].map((frac) => (
          <circle
            key={frac}
            cx={CENTER}
            cy={CENTER}
            r={INNER_R + (MAX_R - INNER_R) * frac}
            fill="none"
            stroke="rgba(148,163,184,0.18)"
            strokeDasharray={frac === 0.5 ? "2 2" : undefined}
          />
        ))}
        {/* Cross axes */}
        <line
          x1={CENTER - MAX_R}
          y1={CENTER}
          x2={CENTER + MAX_R}
          y2={CENTER}
          stroke="rgba(148,163,184,0.16)"
        />
        <line
          x1={CENTER}
          y1={CENTER - MAX_R}
          x2={CENTER}
          y2={CENTER + MAX_R}
          stroke="rgba(148,163,184,0.16)"
        />

        {/* Stacked wedges per yaw bin */}
        {Array.from({ length: numBins }, (_, binIdx) => {
          let acc = 0;
          return binsPerSeries.map((s) => {
            const bin = s.bins[binIdx];
            if (!bin || bin.count <= 0) return null;
            const r0 = INNER_R + (acc / maxCount) * (MAX_R - INNER_R);
            acc += bin.count;
            const r1 = INNER_R + (acc / maxCount) * (MAX_R - INNER_R);
            return (
              <path
                key={`${s.id}-${binIdx}`}
                d={wedgePath(r0, r1, bin.startDeg + 0.8, bin.endDeg - 0.8)}
                fill={s.color}
                fillOpacity={0.78}
                stroke="rgba(2,6,23,0.75)"
                strokeWidth={0.7}
              >
                <title>{`${s.label}: ${bin.startDeg.toFixed(0)}°–${bin.endDeg.toFixed(0)}° (${bin.count})`}</title>
              </path>
            );
          });
        })}

        <circle
          cx={CENTER}
          cy={CENTER}
          r={INNER_R}
          fill="#020617"
          stroke="rgba(148,163,184,0.25)"
        />

        {/* Cardinal angle labels */}
        <text
          x={CENTER + MAX_R + 4}
          y={CENTER + 3}
          fontSize="8"
          fill="#94a3b8"
          textAnchor="start"
        >
          0°
        </text>
        <text
          x={CENTER}
          y={CENTER - MAX_R - 4}
          fontSize="8"
          fill="#94a3b8"
          textAnchor="middle"
        >
          90°
        </text>
        <text
          x={CENTER - MAX_R - 4}
          y={CENTER + 3}
          fontSize="8"
          fill="#94a3b8"
          textAnchor="end"
        >
          180°
        </text>
        <text
          x={CENTER}
          y={CENTER + MAX_R + 10}
          fontSize="8"
          fill="#94a3b8"
          textAnchor="middle"
        >
          270°
        </text>
      </svg>
    </div>
  );
}
