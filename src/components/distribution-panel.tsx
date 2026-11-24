"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/context/locale-context";
import {
  DistributionObjectCard,
  type EpisodeColorResolver,
} from "@/components/distribution-object-card";
import {
  DistributionSubtaskTrajectoryCard,
  type DistributionGroupSlice,
} from "@/components/distribution-subtask-trajectory-card";
import type {
  DistributionRecomputeResult,
  DistributionStatePayload,
} from "@/types/distribution.types";
import { copyTextToClipboard } from "@/utils/clipboard";
import { parseEpisodeSelection } from "@/utils/distributionData";
import { recomputeFrameShares } from "@/utils/distributionMetrics";

interface DistributionPanelProps {
  encodedPath: string | null;
  datasetName: string;
  refreshNonce?: number;
}

interface EpisodeGroupDraft {
  id: string;
  name: string;
  expr: string;
  color: string;
  enabled: boolean;
}

const GROUP_COLORS = [
  "#38bdf8", // sky-400
  "#f472b6", // pink-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#2dd4bf", // teal-400
] as const;

export default function DistributionPanel({
  encodedPath,
  datasetName,
  refreshNonce = 0,
}: DistributionPanelProps) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<DistributionStatePayload | null>(null);
  const [localRefreshNonce, setLocalRefreshNonce] = useState(0);

  const [recomputing, setRecomputing] = useState(false);
  const [cliBanner, setCliBanner] = useState<{
    kind: "info" | "ok" | "error";
    title: string;
    command?: string;
    output?: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [groups, setGroups] = useState<EpisodeGroupDraft[]>([
    {
      id: "g-1",
      name: "Group 1",
      expr: "",
      color: GROUP_COLORS[0],
      enabled: true,
    },
  ]);

  const loadState = useCallback(() => {
    if (!encodedPath) {
      setLoading(false);
      setState(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/local-datasets/${encodedPath}/distribution`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(
            String((body as { error?: string }).error ?? `HTTP ${res.status}`),
          );
          setState(null);
          return;
        }
        setState(body as DistributionStatePayload);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [encodedPath]);

  useEffect(() => {
    loadState();
  }, [loadState, refreshNonce, localRefreshNonce]);

  const handleCopy = async (key: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1800);
    }
  };

  const handleRecompute = async () => {
    if (!encodedPath || !state) return;
    if (!state.cli.configured) {
      setCliBanner({
        kind: "info",
        title: t("dist.cliUnconfigured"),
        command: state.cli.command,
      });
      return;
    }

    setRecomputing(true);
    setCliBanner(null);
    try {
      const res = await fetch(
        `/api/local-datasets/${encodedPath}/distribution/recompute`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as Partial<
        DistributionRecomputeResult & { error?: string }
      >;
      if (body.state) {
        setState(body.state);
      }
      if (!res.ok || !body.ok) {
        setCliBanner({
          kind: body.configured === false ? "info" : "error",
          title: body.error ?? `HTTP ${res.status}`,
          command: body.command ?? state.cli.command,
          output: [body.stdout, body.stderr].filter(Boolean).join("\n").trim(),
        });
        return;
      }
      setCliBanner({
        kind: "ok",
        title: t("dist.recomputeOk"),
      });
    } catch (err) {
      setCliBanner({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
        command: state.cli.command,
      });
    } finally {
      setRecomputing(false);
    }
  };

  const distribution = state?.distribution ?? null;
  const annotatedEpisodes = useMemo(
    () => distribution?.provenance.annotated_episodes ?? [],
    [distribution],
  );
  const annotatedSet = useMemo(
    () => new Set(annotatedEpisodes),
    [annotatedEpisodes],
  );

  // Parse each group's episode range/list expression.
  const parsedGroups = useMemo(() => {
    const totalEps = distribution?.provenance.dataset_total_episodes;
    return groups.map((group) => {
      const parsed = parseEpisodeSelection(group.expr, totalEps);
      if (parsed.error) {
        return {
          ...group,
          error: parsed.error,
          matched: new Set<number>(),
        };
      }
      const matchedList =
        parsed.episodes === null
          ? annotatedEpisodes
          : parsed.episodes.filter((ep) => annotatedSet.has(ep));
      return {
        ...group,
        error: null,
        matched: new Set<number>(matchedList),
      };
    });
  }, [annotatedEpisodes, annotatedSet, distribution, groups]);

  const activeGroups = useMemo<DistributionGroupSlice[]>(
    () =>
      parsedGroups
        .filter((g) => g.enabled && !g.error)
        .map((g) => ({
          id: g.id,
          name: g.name,
          color: g.color,
          episodes: g.matched,
        })),
    [parsedGroups],
  );

  const selectedEpisodes = useMemo(() => {
    const union = new Set<number>();
    for (const g of activeGroups) {
      for (const ep of g.episodes) union.add(ep);
    }
    return union;
  }, [activeGroups]);

  const selectedEpisodeList = useMemo(
    () => [...selectedEpisodes].sort((a, b) => a - b),
    [selectedEpisodes],
  );

  const colorResolver = useMemo<EpisodeColorResolver>(() => {
    const byEpisode = new Map<number, { color: string; name: string }>();
    for (const g of activeGroups) {
      for (const ep of g.episodes) {
        if (!byEpisode.has(ep)) {
          byEpisode.set(ep, { color: g.color, name: g.name });
        }
      }
    }
    return {
      colorOf: (ep) => byEpisode.get(ep)?.color ?? GROUP_COLORS[0],
      groupNameOf: (ep) => byEpisode.get(ep)?.name ?? "",
    };
  }, [activeGroups]);

  const recomputedSummary = useMemo(() => {
    if (!distribution) return null;
    return recomputeFrameShares(distribution, selectedEpisodes);
  }, [distribution, selectedEpisodes]);

  const addGroup = () => {
    setGroups((prev) => {
      const nextIdx = prev.length + 1;
      return [
        ...prev,
        {
          id: `g-${Date.now()}-${nextIdx}`,
          name: `Group ${nextIdx}`,
          expr: "",
          color: GROUP_COLORS[(nextIdx - 1) % GROUP_COLORS.length],
          enabled: true,
        },
      ];
    });
  };

  if (loading) {
    return (
      <div className="panel p-6 text-sm text-slate-400">
        {t("dist.loading")}
      </div>
    );
  }

  if (error || !state || !encodedPath) {
    return (
      <div className="panel border-rose-500/40 p-6 text-sm text-rose-200">
        {error ?? t("dist.loadError")}
      </div>
    );
  }

  if (!state.exists || !distribution || !recomputedSummary) {
    return (
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-4 py-6">
        <div className="panel-raised space-y-4 p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-100">
              {t("dist.missingTitle")}
            </h2>
            <span className="font-mono text-xs text-slate-500">
              {state.repoId}@{state.revision.slice(0, 8)}
            </span>
          </div>
          {state.fileError && (
            <p className="rounded border border-rose-500/40 bg-rose-500/10 p-2.5 font-mono text-xs text-rose-200">
              {state.fileError}
            </p>
          )}
          <div className="rounded-md border border-white/10 bg-black/30 p-3 text-xs">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
              {t("dist.expectedPath")}
            </p>
            <p className="break-all font-mono text-slate-300">
              {state.distributionPath}
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-300">
                {t("dist.runCommand")}
              </span>
              <button
                type="button"
                onClick={() => void handleCopy("missing", state.cli.command)}
                className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-slate-200 hover:border-cyan-400/40"
              >
                {copiedKey === "missing" ? t("dist.copied") : t("common.copy")}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-md border border-cyan-400/20 bg-black/50 p-3 font-mono text-xs text-cyan-200">
              {state.cli.command}
            </pre>
          </div>
          <div className="flex justify-end gap-2">
            {state.cli.configured && (
              <button
                type="button"
                disabled={recomputing}
                onClick={() => void handleRecompute()}
                className="rounded-md border border-cyan-400/40 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50"
              >
                {recomputing ? t("dist.recomputing") : t("dist.recompute")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setLocalRefreshNonce((n) => n + 1)}
              className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400/40"
            >
              {t("dist.refresh")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const prov = distribution.provenance;
  const counts = recomputedSummary.annotatorCounts;

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* Header + Provenance line */}
      <div className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-xs">
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold text-slate-100"
            title={datasetName}
          >
            {t("dist.title")} · {prov.repo_id}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-400 tabular">
            <span>
              {t("dist.provAnnotated")}: {prov.annotated_episodes.length}/
              {prov.dataset_total_episodes}
            </span>
            <span>·</span>
            <span>
              human {counts.human} / agent {counts.agent}
              {counts.converted > 0 ? ` / conv ${counts.converted}` : ""}
            </span>
            {counts.agent > 0 && (
              <span className="rounded border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10px] text-amber-200">
                {t("dist.unreviewedAgentWarn", { count: counts.agent })}
              </span>
            )}
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                prov.position_point === "tool_point"
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-white/10 text-slate-300"
              }`}
            >
              {prov.position_point}
            </span>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={recomputing}
            onClick={() => void handleRecompute()}
            className="rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2.5 py-1.5 font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {recomputing ? t("dist.recomputing") : t("dist.recompute")}
          </button>
          <button
            type="button"
            onClick={() => setLocalRefreshNonce((n) => n + 1)}
            className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-100"
          >
            {t("dist.refresh")}
          </button>
        </div>
      </div>

      {/* CLI banner (copyable command or recompute status) */}
      {cliBanner && (
        <div
          className={`rounded-md border px-4 py-2.5 text-xs space-y-2 ${
            cliBanner.kind === "ok"
              ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
              : cliBanner.kind === "error"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-100"
                : "border-cyan-400/35 bg-cyan-500/10 text-cyan-100"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span>{cliBanner.title}</span>
            <button
              type="button"
              onClick={() => setCliBanner(null)}
              className="text-slate-400 hover:text-slate-100"
            >
              ×
            </button>
          </div>
          {cliBanner.command && (
            <div className="flex items-center gap-2">
              <pre className="flex-1 overflow-x-auto rounded border border-white/10 bg-black/50 px-2.5 py-1.5 font-mono text-[11px] text-cyan-200">
                {cliBanner.command}
              </pre>
              <button
                type="button"
                onClick={() => void handleCopy("cli", cliBanner.command!)}
                className="shrink-0 rounded border border-white/15 bg-[var(--surface-1)]/80 px-2 py-1 text-slate-200 hover:border-cyan-400/50"
              >
                {copiedKey === "cli" ? t("dist.copied") : t("common.copy")}
              </button>
            </div>
          )}
          {cliBanner.output && (
            <pre className="max-h-28 overflow-auto rounded border border-white/10 bg-black/40 p-2 font-mono text-[10px] text-slate-300 whitespace-pre-wrap">
              {cliBanner.output}
            </pre>
          )}
        </div>
      )}

      {/* Episode Selection & Groups */}
      <div className="panel flex flex-col gap-2.5 p-3.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h3 className="font-semibold text-slate-100">
              {t("dist.episodeSelection")}
            </h3>
            <span className="font-mono text-[11px] text-slate-400 tabular">
              {selectedEpisodeList.length}/{annotatedEpisodes.length}
            </span>
          </div>
          <button
            type="button"
            onClick={addGroup}
            className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-slate-200 hover:border-cyan-400/40 hover:text-cyan-100"
          >
            + {t("dist.addGroup")}
          </button>
        </div>

        <div className="space-y-2">
          {parsedGroups.map((group) => (
            <div
              key={group.id}
              className="flex flex-wrap items-center gap-2 rounded border border-white/10 bg-black/25 px-2.5 py-1.5"
            >
              <input
                type="checkbox"
                checked={group.enabled}
                onChange={(e) =>
                  setGroups((prev) =>
                    prev.map((item) =>
                      item.id === group.id
                        ? { ...item, enabled: e.target.checked }
                        : item,
                    ),
                  )
                }
                className="accent-cyan-400"
              />
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: group.color }}
              />
              <input
                type="text"
                value={group.name}
                aria-label={t("dist.groupName")}
                onChange={(e) =>
                  setGroups((prev) =>
                    prev.map((item) =>
                      item.id === group.id
                        ? { ...item, name: e.target.value }
                        : item,
                    ),
                  )
                }
                className="w-28 rounded border border-white/10 bg-black/40 px-2 py-1 text-xs text-slate-100 focus:border-cyan-400/50 focus:outline-none"
              />
              <input
                type="text"
                value={group.expr}
                aria-label={t("dist.episodeFilter")}
                placeholder={t("dist.episodePlaceholder")}
                onChange={(e) =>
                  setGroups((prev) =>
                    prev.map((item) =>
                      item.id === group.id
                        ? { ...item, expr: e.target.value }
                        : item,
                    ),
                  )
                }
                className={`min-w-[14rem] flex-1 rounded border bg-black/40 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none ${
                  group.error
                    ? "border-rose-400/60"
                    : "border-white/10 focus:border-cyan-400/50"
                }`}
              />
              <span className="font-mono text-[11px] text-slate-400 tabular">
                {group.matched.size} ep
              </span>
              {group.error && (
                <span className="text-[11px] text-rose-300">{group.error}</span>
              )}
              {groups.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setGroups((prev) =>
                      prev.filter((item) => item.id !== group.id),
                    )
                  }
                  className="rounded border border-white/10 px-1.5 py-0.5 text-slate-400 hover:border-rose-400/40 hover:text-rose-200"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Block 1: Frame Shares */}
      <section className="panel flex flex-col gap-2.5 p-3.5 text-xs">
        <div className="flex items-baseline justify-between">
          <h3 className="font-semibold text-slate-100">
            {t("dist.sectionFrameShares")}
          </h3>
          <span className="font-mono text-[11px] text-slate-400 tabular">
            {recomputedSummary.frameShares.total_frames} frames
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left font-mono text-xs tabular">
            <thead>
              <tr className="border-b border-white/10 font-sans text-[11px] text-slate-400">
                <th className="py-1.5 pr-3 font-medium">
                  {t("dist.colSubtask")}
                </th>
                <th className="py-1.5 px-3 text-right font-medium">
                  {t("dist.colEpisodes")}
                </th>
                <th className="py-1.5 px-3 text-right font-medium">
                  {t("dist.colFrames")}
                </th>
                <th className="py-1.5 pl-3 text-right font-medium">
                  {t("dist.colShare")}
                </th>
              </tr>
            </thead>
            <tbody>
              {recomputedSummary.frameShares.subtasks.map((row) => {
                const pct = row.share * 100;
                return (
                  <tr
                    key={row.subtask}
                    className="border-b border-white/5 last:border-b-0"
                  >
                    <td className="py-1.5 pr-3 text-slate-100">
                      {row.subtask}
                    </td>
                    <td className="py-1.5 px-3 text-right text-slate-300">
                      {row.episodes}
                    </td>
                    <td className="py-1.5 px-3 text-right text-slate-300">
                      {row.frames}
                    </td>
                    <td className="py-1.5 pl-3">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full bg-cyan-400"
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="w-12 text-right text-cyan-200">
                          {pct.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Block 2: Object Initial Positions */}
      {distribution.objects.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            {t("dist.sectionObjects")}
          </h3>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {distribution.objects.map((obj) => (
              <DistributionObjectCard
                key={`${obj.name}-${obj.subtask}-${obj.event}`}
                encodedPath={encodedPath}
                objectEntry={obj}
                coverageConfig={distribution.coverage_config}
                selectedEpisodes={selectedEpisodes}
                selectedEpisodeList={selectedEpisodeList}
                colorResolver={colorResolver}
                positionPoint={prov.position_point}
                calibrationHead={state.calibration.head}
                recomputing={recomputing}
                onRecompute={() => void handleRecompute()}
              />
            ))}
          </div>
        </section>
      )}

      {/* Block 3: Subtask Trajectories */}
      {distribution.subtasks.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            {t("dist.sectionTrajectories")}
          </h3>
          <div className="flex flex-col gap-3">
            {distribution.subtasks.map((sub) =>
              sub.participating_arms.map((armName) => {
                const armData = sub.arms[armName];
                if (!armData) return null;
                return (
                  <DistributionSubtaskTrajectoryCard
                    key={`${sub.name}-${armName}`}
                    subtaskName={sub.name}
                    armName={armName}
                    armData={armData}
                    coverageConfig={distribution.coverage_config}
                    selectedEpisodes={selectedEpisodes}
                    groups={activeGroups}
                  />
                );
              }),
            )}
          </div>
        </section>
      )}
    </div>
  );
}
