"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "@/context/locale-context";
import {
  CollectionCanvas,
  markerCodeForItem,
  type CollectionCanvasHandle,
  type CollectionMarkerEntry,
} from "@/components/collection-canvas";
import CollectionPlanRounds from "@/components/collection-plan-rounds";
import type { CalibrationEpisodeMediaPayload } from "@/types/calibration.types";
import type {
  CollectionPlanAction,
  CollectionStatePayload,
  CollectionSuggestResult,
  TargetPolygonVertex,
} from "@/types/collection.types";
import type { DistributionRecomputeResult } from "@/types/distribution.types";
import { copyTextToClipboard } from "@/utils/clipboard";
import {
  collectionTargetKey,
  formatSuggestionsCsv,
} from "@/utils/collectionData";

interface CollectionPanelProps {
  encodedPath: string | null;
  datasetName: string;
  totalEpisodes: number;
  currentEpisodeId: number;
  fps: number;
  onOpenCalibrationTab: () => void;
}

const OBJECT_COLORS = [
  "#38bdf8", // sky-400
  "#f472b6", // pink-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#fb7185", // rose-400
] as const;

const TEST_TIERS = ["dense", "edge", "empty"] as const;

function triggerDownload(filename: string, url: string, revokeAfter = false) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  if (revokeAfter) {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export default function CollectionPanel({
  encodedPath,
  datasetName,
  totalEpisodes,
  currentEpisodeId,
  fps,
  onOpenCalibrationTab,
}: CollectionPanelProps) {
  const t = useT();
  const canvasRef = useRef<CollectionCanvasHandle | null>(null);

  const [state, setState] = useState<CollectionStatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [refEpisode, setRefEpisode] = useState<number>(currentEpisodeId);
  const [episodeMedia, setEpisodeMedia] =
    useState<CalibrationEpisodeMediaPayload | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const [draftPolygon, setDraftPolygon] = useState<TargetPolygonVertex[]>([]);
  const [polygonDirty, setPolygonDirty] = useState(false);
  const [editPolygon, setEditPolygon] = useState(true);
  const [showPolygon, setShowPolygon] = useState(true);
  const [savingPolygon, setSavingPolygon] = useState(false);

  const [countPerObject, setCountPerObject] = useState(10);
  const [testPerTier, setTestPerTier] = useState(3);
  const [runningSuggest, setRunningSuggest] = useState(false);
  const [recomputingDist, setRecomputingDist] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"plan" | "points">("plan");
  const [newRoundCount, setNewRoundCount] = useState<number | null>(null);
  const [objectsPerRound, setObjectsPerRound] = useState<number | null>(null);
  const [selectedRoundId, setSelectedRoundId] = useState<number | null>(null);
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const [runningPlan, setRunningPlan] = useState(false);

  const [banner, setBanner] = useState<{
    kind: "info" | "ok" | "error";
    title: string;
    command?: string;
    output?: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [visibleObjects, setVisibleObjects] = useState<Record<string, boolean>>(
    {},
  );
  const [showPlacements, setShowPlacements] = useState(true);
  const [visibleTiers, setVisibleTiers] = useState<Record<string, boolean>>({
    dense: true,
    edge: true,
    empty: true,
  });
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const plan = state?.plan;
  const round =
    plan?.rounds.find(({ id }) => id === selectedRoundId) ??
    plan?.rounds[0] ??
    null;
  const reviewKey = plan ? `${plan.plan_id}:${plan.generation}` : null;
  const camera =
    workspaceMode === "plan" ? (plan?.camera ?? state?.camera) : state?.camera;

  const fetchState = useCallback(
    async (keepDraft = false) => {
      if (!encodedPath) {
        setLoading(false);
        setState(null);
        return;
      }
      if (!keepDraft) setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(
          `/api/local-datasets/${encodedPath}/collection`,
          {
            cache: "no-store",
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setLoadError(
            String((body as { error?: string }).error ?? `HTTP ${res.status}`),
          );
          setState(null);
          return;
        }
        const next = body as CollectionStatePayload;
        setState(next);
        if (!keepDraft) {
          setDraftPolygon(next.targets?.polygon ?? []);
          setPolygonDirty(false);
        }
        if (next.distribution.annotatedEpisodes.length > 0) {
          setRefEpisode((prev) =>
            prev >= 0 && prev < totalEpisodes
              ? prev
              : next.distribution.annotatedEpisodes[0],
          );
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [encodedPath, totalEpisodes],
  );

  useEffect(() => {
    setBanner(null);
    void fetchState();
  }, [fetchState]);

  // Fetch head-camera frame metadata for selected reference episode.
  useEffect(() => {
    if (!encodedPath || !camera) return;
    let cancelled = false;
    setMediaLoading(true);
    setMediaError(null);
    const params = new URLSearchParams({
      episode: String(refEpisode),
      camera,
      includeTcp: "0",
    });
    fetch(`/api/local-datasets/${encodedPath}/calibration/episode?${params}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setMediaError(
            String((body as { error?: string }).error ?? `HTTP ${res.status}`),
          );
          setEpisodeMedia(null);
          return;
        }
        setEpisodeMedia(body as CalibrationEpisodeMediaPayload);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMediaError(err instanceof Error ? err.message : String(err));
        setEpisodeMedia(null);
      })
      .finally(() => {
        if (!cancelled) setMediaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [encodedPath, refEpisode, camera]);

  const objectList = useMemo(() => {
    if (!state?.suggestions) return [];
    const names = new Set<string>();
    for (const o of state.suggestions.objects) names.add(o.object);
    for (const p of state.suggestions.placements) names.add(p.object);
    for (const tp of state.suggestions.test_points) names.add(tp.object);
    return [...names].map((name, idx) => ({
      name,
      color: OBJECT_COLORS[idx % OBJECT_COLORS.length],
    }));
  }, [state]);

  const objectColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of objectList) map.set(o.name, o.color);
    return map;
  }, [objectList]);

  useEffect(() => {
    setVisibleObjects((prev) => {
      const next: Record<string, boolean> = {};
      for (const o of objectList) {
        next[o.name] = prev[o.name] ?? true;
      }
      return next;
    });
  }, [objectList]);

  const visibleMarkers = useMemo<CollectionMarkerEntry[]>(() => {
    const suggestions = state?.suggestions;
    if (!suggestions) return [];
    const entries: CollectionMarkerEntry[] = [];

    if (showPlacements) {
      suggestions.placements.forEach((item) => {
        if (visibleObjects[item.object] === false) return;
        entries.push({
          key: collectionTargetKey("placement", item),
          kind: "placement",
          item,
          color: objectColorMap.get(item.object) ?? OBJECT_COLORS[0],
          code: markerCodeForItem("placement", item),
        });
      });
    }

    suggestions.test_points.forEach((item) => {
      if (visibleObjects[item.object] === false) return;
      if (visibleTiers[item.tier] === false) return;
      entries.push({
        key: collectionTargetKey("test_point", item),
        kind: "test_point",
        item,
        color: objectColorMap.get(item.object) ?? OBJECT_COLORS[0],
        code: markerCodeForItem("test_point", item),
      });
    });

    return entries;
  }, [
    objectColorMap,
    showPlacements,
    state?.suggestions,
    visibleObjects,
    visibleTiers,
  ]);

  const plansObjects = state?.distribution.objects ?? [];
  const planColorOf = (name: string) =>
    OBJECT_COLORS[
      Math.max(0, plansObjects.indexOf(name)) % OBJECT_COLORS.length
    ];
  const planMarkers: CollectionMarkerEntry[] =
    round?.targets.map((item, index) => ({
      key: collectionTargetKey("placement", item),
      kind: "placement",
      item,
      outline: item.outline,
      code: String(index + 1),
      color: planColorOf(item.object),
    })) ?? [];

  const handlePlanEdit = async (edit: CollectionPlanAction) => {
    if (!encodedPath || !state) return;
    if (
      edit.action === "delete" &&
      !window.confirm(t("collect.plan.deleteConfirm", { id: edit.roundId }))
    )
      return;
    if (
      edit.action !== "delete" &&
      polygonDirty &&
      !(await handleSavePolygon())
    )
      return;
    setRunningPlan(true);
    setBanner(null);
    try {
      const res = await fetch(
        `/api/local-datasets/${encodedPath}/collection/plan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...edit,
            planId: plan?.plan_id ?? null,
            generation: plan?.generation ?? null,
          }),
        },
      );
      const result = (await res.json()) as {
        error?: string;
        command?: string;
        configured?: boolean;
      };
      if (!res.ok) {
        setBanner({
          kind: result.configured === false ? "info" : "error",
          title: result.error ?? `HTTP ${res.status}`,
          command: result.command,
        });
        return;
      }
      setReviewedKey(null);
      setSelectedRoundId(
        edit.action === "replace" ? (plan?.next_round_id ?? null) : null,
      );
      await fetchState(true);
      setBanner({ kind: "ok", title: t("collect.plan.updated") });
    } catch (err) {
      setBanner({ kind: "error", title: String(err) });
    } finally {
      setRunningPlan(false);
    }
  };

  const handleDownloadPlan = async () => {
    if (!encodedPath || !plan || reviewedKey !== reviewKey) return;
    try {
      const params = new URLSearchParams({
        planId: plan.plan_id,
        generation: String(plan.generation),
      });
      const res = await fetch(
        `/api/local-datasets/${encodedPath}/collection/plan?${params}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const { error } = await res.json();
        setBanner({
          kind: "error",
          title: String(error ?? `HTTP ${res.status}`),
        });
        return;
      }
      const slug = plan.repo_id.replace(/\//g, "__");
      triggerDownload(
        `${slug}@${plan.revision}.plan.json`,
        URL.createObjectURL(await res.blob()),
        true,
      );
    } catch (err) {
      setBanner({ kind: "error", title: String(err) });
    }
  };

  const handleCopy = async (key: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1800);
    }
  };

  const handlePolygonChange = (next: TargetPolygonVertex[]) => {
    setDraftPolygon(next);
    setPolygonDirty(true);
  };

  const handleSavePolygon = async (): Promise<boolean> => {
    if (!encodedPath || !state) return false;
    if (draftPolygon.length < 3) {
      setBanner({ kind: "error", title: t("collect.minVerticesError") });
      return false;
    }
    setSavingPolygon(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/local-datasets/${encodedPath}/collection`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          camera: state.camera,
          image_size: state.imageSize,
          polygon: draftPolygon,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBanner({
          kind: "error",
          title: String(
            (body as { error?: string }).error ?? `HTTP ${res.status}`,
          ),
        });
        return false;
      }
      const next = body as CollectionStatePayload;
      setState(next);
      setDraftPolygon(next.targets?.polygon ?? []);
      setPolygonDirty(false);
      setBanner({ kind: "ok", title: t("collect.polygonSaved") });
      return true;
    } catch (err) {
      setBanner({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      setSavingPolygon(false);
    }
  };

  const handleDeleteSavedPolygon = async () => {
    if (!encodedPath) return;
    setSavingPolygon(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/local-datasets/${encodedPath}/collection`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBanner({
          kind: "error",
          title: String(
            (body as { error?: string }).error ?? `HTTP ${res.status}`,
          ),
        });
        return;
      }
      const next = body as CollectionStatePayload;
      setState(next);
      setDraftPolygon([]);
      setPolygonDirty(false);
      setBanner({ kind: "info", title: t("collect.polygonDeleted") });
    } catch (err) {
      setBanner({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingPolygon(false);
    }
  };

  const handleRecomputeDistribution = async () => {
    if (!encodedPath || !state) return;
    if (!state.cli.configured) {
      setBanner({
        kind: "info",
        title: t("dist.cliUnconfigured"),
        command: state.cli.distributionCommand,
      });
      return;
    }
    setRecomputingDist(true);
    setBanner(null);
    try {
      const res = await fetch(
        `/api/local-datasets/${encodedPath}/distribution/recompute`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as Partial<
        DistributionRecomputeResult & { error?: string }
      >;
      await fetchState();
      if (!res.ok || !body.ok) {
        setBanner({
          kind: "error",
          title: body.error ?? `HTTP ${res.status}`,
          command: body.command ?? state.cli.distributionCommand,
          output: [body.stdout, body.stderr].filter(Boolean).join("\n").trim(),
        });
        return;
      }
      setBanner({ kind: "ok", title: t("dist.recomputeOk") });
    } catch (err) {
      setBanner({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRecomputingDist(false);
    }
  };

  const handleRunSuggest = async () => {
    if (!encodedPath || !state) return;
    if (!state.cli.configured) {
      setBanner({
        kind: "info",
        title: t("dist.cliUnconfigured"),
        command: state.cli.suggestCommand,
      });
      return;
    }

    // Save dirty valid polygon first so suggest uses what is drawn on screen.
    if (polygonDirty && draftPolygon.length >= 3) {
      const saved = await handleSavePolygon();
      if (!saved) return;
    }

    setRunningSuggest(true);
    setBanner(null);
    try {
      const res = await fetch(
        `/api/local-datasets/${encodedPath}/collection/suggest`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            count: countPerObject,
            testPerTier,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as Partial<
        CollectionSuggestResult & { error?: string }
      >;
      if (body.state) {
        setState(body.state);
      }
      if (!res.ok || !body.ok) {
        setBanner({
          kind: body.configured === false ? "info" : "error",
          title: body.error ?? `HTTP ${res.status}`,
          command: body.command ?? state.cli.suggestCommand,
          output: [body.stdout, body.stderr].filter(Boolean).join("\n").trim(),
        });
        return;
      }
      setBanner({
        kind: "ok",
        title: t("collect.suggestOk"),
        output: body.stdout?.trim() || undefined,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningSuggest(false);
    }
  };

  const selected = visibleMarkers.find((entry) => entry.key === selectedKey);
  const selectedMask =
    selected &&
    state?.masks?.targets.find(
      (target) => collectionTargetKey(target.kind, target) === selected.key,
    );

  const handleExportMasks = () => {
    if (!state?.masks) return;
    const blob = new Blob([JSON.stringify(state.masks)], {
      type: "application/json",
    });
    const slug = state.repoId.replace(/\//g, "__");
    triggerDownload(
      `${slug}@${state.revision}.json`,
      URL.createObjectURL(blob),
      true,
    );
  };

  const handleExportPng = () => {
    if (!state || !canvasRef.current) return;
    const dataUrl = canvasRef.current.exportAnnotatedPngDataUrl({
      title: `${state.repoId} · ep ${refEpisode}${workspaceMode === "plan" && round ? ` · ${t("collect.plan.round", { id: round.id })}` : ""}`,
      objects:
        workspaceMode === "plan"
          ? planMarkers.map(({ item, color }) => ({ name: item.object, color }))
          : objectList.filter((o) => visibleObjects[o.name] !== false),
      note:
        workspaceMode === "points"
          ? state.suggestions?.provenance.note
          : undefined,
    });
    if (!dataUrl) return;
    const slug = state.repoId.replace(/\//g, "__");
    triggerDownload(`${slug}_collection.png`, dataUrl);
  };

  const handleExportCsv = () => {
    if (!state?.suggestions) return;
    const enabledObjects = new Set(
      objectList
        .filter((o) => visibleObjects[o.name] !== false)
        .map((o) => o.name),
    );
    const enabledTiers = new Set(
      TEST_TIERS.filter((tier) => visibleTiers[tier] !== false),
    );
    const csv = formatSuggestionsCsv(state.suggestions, {
      objects: enabledObjects,
      includePlacements: showPlacements,
      includeTestTiers: enabledTiers,
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const slug = state.repoId.replace(/\//g, "__");
    triggerDownload(`${slug}_collection.csv`, url, true);
  };

  if (loading) {
    return (
      <div className="panel p-6 text-sm text-slate-400">
        {t("collect.loading")}
      </div>
    );
  }

  if (loadError || !state || !encodedPath) {
    return (
      <div className="panel border-rose-500/40 p-6 text-sm text-rose-200">
        {loadError ?? t("collect.loadError")}
      </div>
    );
  }

  const fileErrors = [
    state.targetsError,
    state.suggestionsError,
    state.calibration.error,
    state.distribution.error,
  ].filter((v): v is string => Boolean(v));

  const needsDistRecompute =
    state.calibration.exists && state.distribution.positionPoint === "tcp";

  const planMode = workspaceMode === "plan";
  const availableObjects = plansObjects.length;
  const roundCount = newRoundCount ?? plan?.settings.round_count ?? 10;
  const perRound = Math.min(
    objectsPerRound ?? plan?.settings.objects_per_round ?? 1,
    Math.max(1, availableObjects),
  );
  const planEditable = !runningPlan && !state.planError;
  const actionClass =
    "rounded border border-white/15 px-2.5 py-1.5 text-slate-200 hover:border-cyan-400/50 disabled:opacity-40";

  return (
    <div className="flex flex-col gap-3 pb-6">
      {/* Header & primary action bar */}
      <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-xs">
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold text-slate-100"
            title={datasetName}
          >
            {t("collect.title")} · {state.repoId}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-400">
            <span>{state.camera}</span>
            <span>
              {state.imageSize[0]}×{state.imageSize[1]}
            </span>
            {state.suggestions && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-cyan-200">
                {state.suggestions.provenance.region_source}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={actionClass}
            aria-pressed={planMode}
            onClick={() => setWorkspaceMode("plan")}
          >
            {t("collect.plan.mode")}
          </button>
          <button
            type="button"
            className={actionClass}
            aria-pressed={!planMode}
            onClick={() => setWorkspaceMode("points")}
          >
            {t("collect.plan.suggestions")}
          </button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {planMode ? (
            <>
              <label className="inline-flex items-center gap-1 text-slate-300">
                {t("collect.plan.roundCount")}
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={roundCount}
                  onChange={(e) =>
                    setNewRoundCount(
                      Math.min(
                        500,
                        Math.max(1, Math.trunc(Number(e.target.value) || 1)),
                      ),
                    )
                  }
                  className="w-14 rounded border border-white/10 bg-black/40 px-1.5 py-1 text-center"
                />
              </label>
              <label className="inline-flex items-center gap-1 text-slate-300">
                {t("collect.plan.objectsPerRound")}
                <select
                  value={perRound}
                  disabled={!availableObjects}
                  onChange={(e) => setObjectsPerRound(Number(e.target.value))}
                  className="rounded border border-white/10 bg-[var(--surface-1)] px-1.5 py-1"
                >
                  {Array.from(
                    { length: Math.max(1, availableObjects) },
                    (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {i + 1}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <button
                type="button"
                disabled={
                  !planEditable ||
                  !availableObjects ||
                  !state.calibration.exists
                }
                className={`${actionClass} bg-cyan-500/15`}
                onClick={() =>
                  void handlePlanEdit({
                    action: "generate",
                    roundCount,
                    objectsPerRound: perRound,
                  })
                }
              >
                {runningPlan
                  ? t("collect.generating")
                  : t(
                      plan
                        ? "collect.plan.regenerate"
                        : "collect.plan.generate",
                    )}
              </button>
              {plan && (
                <label className="inline-flex items-center gap-1 text-slate-300">
                  <input
                    type="checkbox"
                    checked={reviewedKey === reviewKey}
                    disabled={runningPlan}
                    onChange={(e) =>
                      setReviewedKey(e.target.checked ? reviewKey : null)
                    }
                    className="accent-cyan-400"
                  />
                  {t("collect.plan.reviewed")}
                </label>
              )}
              <button
                type="button"
                className={actionClass}
                disabled={
                  runningPlan ||
                  !plan?.rounds.some((item) => item.status === "pending") ||
                  reviewedKey !== reviewKey
                }
                onClick={() => void handleDownloadPlan()}
              >
                {t("collect.plan.download")}
              </button>
            </>
          ) : (
            <>
              <label className="inline-flex items-center gap-1 text-slate-300">
                <span>{t("collect.countLabel")}</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={countPerObject}
                  onChange={(e) =>
                    setCountPerObject(Math.max(1, Number(e.target.value) || 1))
                  }
                  className="w-14 rounded border border-white/10 bg-black/40 px-1.5 py-1 text-center font-mono text-slate-100"
                />
              </label>

              <label className="inline-flex items-center gap-1 text-slate-300">
                <span>{t("collect.testPerTierLabel")}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={testPerTier}
                  onChange={(e) =>
                    setTestPerTier(Math.max(0, Number(e.target.value) || 0))
                  }
                  className="w-12 rounded border border-white/10 bg-black/40 px-1.5 py-1 text-center font-mono text-slate-100"
                />
              </label>

              <button
                type="button"
                disabled={runningSuggest}
                onClick={() => void handleRunSuggest()}
                className="rounded-md border border-cyan-400/40 bg-cyan-500/15 px-3 py-1.5 font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50"
              >
                {runningSuggest
                  ? t("collect.generating")
                  : t("collect.generate")}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleExportPng}
            className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-slate-200 hover:border-cyan-400/40"
          >
            {t("collect.exportPng")}
          </button>

          {!planMode && (
            <button
              type="button"
              disabled={!state.suggestions}
              onClick={handleExportCsv}
              className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-slate-200 hover:border-cyan-400/40 disabled:opacity-40"
            >
              {t("collect.exportCsv")}
            </button>
          )}

          {!planMode && state.masks && (
            <button
              type="button"
              onClick={handleExportMasks}
              className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-slate-200 hover:border-cyan-400/40"
            >
              {t("collect.exportMasks")}
            </button>
          )}

          <button
            type="button"
            disabled={runningPlan}
            onClick={() => void fetchState(true)}
            className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-slate-300 hover:border-cyan-400/40"
          >
            {t("dist.refresh")}
          </button>
        </div>
      </div>

      {planMode && (state.planError || (plan && !plan.camera_serial)) && (
        <p
          role="alert"
          className="rounded border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-200"
        >
          {t(
            state.planError
              ? `collect.plan.${state.planError}`
              : "collect.plan.noSerial",
          )}
        </p>
      )}
      {/* State notices */}
      {!state.calibration.exists && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          <span>{t("collect.noCalibNotice")}</span>
          <button
            type="button"
            onClick={onOpenCalibrationTab}
            className="rounded border border-amber-300/40 bg-amber-500/20 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-500/30"
          >
            {t("collect.goCalibration")} →
          </button>
        </div>
      )}

      {needsDistRecompute && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          <span>{t("collect.tcpDistNotice")}</span>
          <button
            type="button"
            disabled={recomputingDist}
            onClick={() => void handleRecomputeDistribution()}
            className="rounded border border-amber-300/40 bg-amber-500/20 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
          >
            {recomputingDist ? t("dist.recomputing") : t("dist.recompute")}
          </button>
        </div>
      )}

      {!state.distribution.exists && (
        <div className="rounded-md border border-amber-400/35 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          {t("collect.noDistNotice")}
        </div>
      )}

      {state.calibration.hasNonZeroDistortion && (
        <div className="rounded-md border border-amber-400/35 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          {t("calib.distortionWarning")}
        </div>
      )}

      {fileErrors.length > 0 && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs text-rose-200 space-y-1">
          {fileErrors.map((msg, i) => (
            <p key={i} className="font-mono break-all">
              {msg}
            </p>
          ))}
        </div>
      )}

      {banner && (
        <div
          className={`rounded-md border px-4 py-2.5 text-xs space-y-2 ${
            banner.kind === "ok"
              ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
              : banner.kind === "error"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-100"
                : "border-cyan-400/35 bg-cyan-500/10 text-cyan-100"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span>{banner.title}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-slate-400 hover:text-slate-100"
            >
              ×
            </button>
          </div>
          {banner.command && (
            <div className="flex items-center gap-2">
              <pre className="flex-1 overflow-x-auto rounded border border-white/10 bg-black/50 px-2.5 py-1.5 font-mono text-[11px] text-cyan-200">
                {banner.command}
              </pre>
              <button
                type="button"
                onClick={() => void handleCopy("banner", banner.command!)}
                className="shrink-0 rounded border border-white/15 bg-[var(--surface-1)]/80 px-2 py-1 text-slate-200 hover:border-cyan-400/50"
              >
                {copiedKey === "banner" ? t("dist.copied") : t("common.copy")}
              </button>
            </div>
          )}
          {banner.output && (
            <pre className="max-h-28 overflow-auto rounded border border-white/10 bg-black/40 p-2 font-mono text-[10px] text-slate-300 whitespace-pre-wrap">
              {banner.output}
            </pre>
          )}
        </div>
      )}

      {/* Main 2-column workspace: Head image + numbered list */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/* Left: Head camera frame + polygon controls + layer toggles */}
        <div className="panel flex flex-col gap-3 p-3.5 text-xs">
          {/* Reference episode & polygon toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-slate-300">
              <span>{t("dist.refEpisode")}</span>
              <input
                type="number"
                min={0}
                max={Math.max(0, totalEpisodes - 1)}
                value={refEpisode}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (
                    Number.isInteger(val) &&
                    val >= 0 &&
                    val < Math.max(1, totalEpisodes)
                  ) {
                    setRefEpisode(val);
                  }
                }}
                className="w-16 rounded border border-white/10 bg-black/40 px-1.5 py-1 text-center font-mono text-slate-100"
              />
            </label>

            <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300 ml-2">
              <input
                type="checkbox"
                checked={editPolygon}
                onChange={(e) => setEditPolygon(e.target.checked)}
                className="accent-cyan-400"
              />
              {t("collect.editPolygon")}
            </label>

            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11px] text-slate-400 tabular">
                {draftPolygon.length} pts
              </span>
              <button
                type="button"
                disabled={draftPolygon.length === 0}
                onClick={() => handlePolygonChange(draftPolygon.slice(0, -1))}
                className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-slate-300 hover:border-cyan-400/40 disabled:opacity-40"
              >
                {t("collect.undoVertex")}
              </button>
              <button
                type="button"
                disabled={draftPolygon.length === 0}
                onClick={() => handlePolygonChange([])}
                className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-slate-300 hover:border-rose-400/40 disabled:opacity-40"
              >
                {t("collect.clearPolygon")}
              </button>
              <button
                type="button"
                disabled={savingPolygon || draftPolygon.length < 3}
                onClick={() => void handleSavePolygon()}
                className={`rounded border px-2.5 py-1 font-medium transition-colors disabled:opacity-40 ${
                  polygonDirty
                    ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30"
                    : "border-white/10 bg-[var(--surface-1)]/60 text-slate-200 hover:border-cyan-400/40"
                }`}
              >
                {t("collect.savePolygon")}
              </button>
              {state.targetsExists && (
                <button
                  type="button"
                  disabled={savingPolygon}
                  onClick={() => void handleDeleteSavedPolygon()}
                  className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-slate-400 hover:border-rose-400/40 hover:text-rose-200 disabled:opacity-40"
                >
                  {t("collect.deletePolygon")}
                </button>
              )}
            </div>
          </div>

          {/* Interactive head camera canvas */}
          <CollectionCanvas
            ref={canvasRef}
            imageSize={planMode && plan ? plan.image_size : state.imageSize}
            video={episodeMedia?.video ?? null}
            fps={episodeMedia?.fps ?? fps}
            loading={mediaLoading}
            error={mediaError}
            polygon={draftPolygon}
            showPolygon={showPolygon}
            editPolygon={editPolygon}
            onPolygonChange={handlePolygonChange}
            markers={planMode ? planMarkers : visibleMarkers}
            highlightedKey={
              planMode
                ? highlightedKey
                : (highlightedKey ?? selected?.key ?? null)
            }
            selectedOutline={planMode ? null : (selectedMask?.outline ?? null)}
            calibratedMarkersOnly={planMode}
            onHoverMarker={setHighlightedKey}
          />
          {!planMode && (
            <>
              <p role="status" className="text-[11px] text-slate-300">
                {state.masksError
                  ? t(`collect.masks.${state.masksError}`)
                  : !state.masks
                    ? t("collect.masks.missing")
                    : !selected
                      ? t("collect.masks.select")
                      : selectedMask?.reason
                        ? t("collect.masks.unavailable", {
                            target: `${selected.item.object} ${selected.code}`,
                            reason: selectedMask.reason,
                          })
                        : t("collect.masks.active", {
                            target: `${selected.item.object} ${selected.code}`,
                          })}
              </p>

              {/* Layer & Object toggles */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/10 pt-2.5 text-[11px]">
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300">
                  <input
                    type="checkbox"
                    checked={showPolygon}
                    onChange={(e) => setShowPolygon(e.target.checked)}
                    className="accent-cyan-400"
                  />
                  {t("collect.layerPolygon")}
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300">
                  <input
                    type="checkbox"
                    checked={showPlacements}
                    onChange={(e) => setShowPlacements(e.target.checked)}
                    className="accent-cyan-400"
                  />
                  ● {t("collect.layerPlacements")}
                </label>
                {TEST_TIERS.map((tier) => (
                  <label
                    key={tier}
                    className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300"
                  >
                    <input
                      type="checkbox"
                      checked={visibleTiers[tier] !== false}
                      onChange={(e) =>
                        setVisibleTiers((prev) => ({
                          ...prev,
                          [tier]: e.target.checked,
                        }))
                      }
                      className="accent-cyan-400"
                    />
                    {tier === "dense"
                      ? `▲ ${t("collect.tierDense")}`
                      : tier === "edge"
                        ? `◆ ${t("collect.tierEdge")}`
                        : `■ ${t("collect.tierEmpty")}`}
                  </label>
                ))}

                {objectList.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3 ml-auto">
                    {objectList.map((obj) => (
                      <label
                        key={obj.name}
                        className="inline-flex cursor-pointer items-center gap-1.5"
                      >
                        <input
                          type="checkbox"
                          checked={visibleObjects[obj.name] !== false}
                          onChange={(e) =>
                            setVisibleObjects((prev) => ({
                              ...prev,
                              [obj.name]: e.target.checked,
                            }))
                          }
                          className="accent-cyan-400"
                        />
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: obj.color }}
                        />
                        <span className="font-mono text-slate-200">
                          {obj.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {planMode ? (
          <CollectionPlanRounds
            plan={plan ?? null}
            selected={round}
            busy={runningPlan}
            colorOf={planColorOf}
            onSelect={setSelectedRoundId}
            onReplace={(roundId) =>
              void handlePlanEdit({ action: "replace", roundId })
            }
            onDelete={(roundId) =>
              void handlePlanEdit({ action: "delete", roundId })
            }
          />
        ) : (
          <div className="panel flex flex-col gap-2.5 p-3.5 text-xs">
            <div className="flex items-baseline justify-between">
              <h3 className="font-semibold text-slate-100">
                {t("collect.tableTitle")}
              </h3>
              <span className="font-mono text-[11px] text-slate-400 tabular">
                {visibleMarkers.length}
              </span>
            </div>

            {!state.suggestions ? (
              <div className="flex flex-1 items-center justify-center rounded border border-white/10 bg-black/25 p-6 text-center text-slate-400">
                {t("collect.noSuggestions")}
              </div>
            ) : (
              <>
                <div className="max-h-[64vh] overflow-y-auto pr-0.5">
                  <table className="w-full border-collapse text-left font-mono text-[11px] tabular">
                    <thead className="sticky top-0 bg-[var(--surface-1)]">
                      <tr className="border-b border-white/10 font-sans text-[10px] text-slate-400">
                        <th className="py-1.5 pr-1.5 font-medium">
                          {t("collect.colNo")}
                        </th>
                        <th className="py-1.5 px-1.5 font-medium">
                          {t("collect.colObject")}
                        </th>
                        <th className="py-1.5 px-1.5 font-medium">
                          {t("collect.colKind")}
                        </th>
                        <th className="py-1.5 px-1 text-right font-medium">
                          x
                        </th>
                        <th className="py-1.5 px-1 text-right font-medium">
                          y
                        </th>
                        <th className="py-1.5 pl-1 text-right font-medium">
                          yaw
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleMarkers.map((entry) => {
                        const active =
                          entry.key === (highlightedKey ?? selectedKey);
                        return (
                          <tr
                            key={entry.key}
                            onClick={() => setSelectedKey(entry.key)}
                            onMouseEnter={() => setHighlightedKey(entry.key)}
                            onMouseLeave={() => setHighlightedKey(null)}
                            className={`border-b border-white/5 cursor-pointer transition-colors ${
                              active ? "bg-cyan-500/20" : "hover:bg-white/5"
                            }`}
                          >
                            <td className="py-1 pr-1.5 font-semibold">
                              <button
                                type="button"
                                aria-pressed={selectedKey === entry.key}
                                aria-label={`${entry.item.object} ${entry.code}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedKey(entry.key);
                                }}
                                className="inline-block rounded px-1 py-0.5 text-[10px] text-slate-950"
                                style={{ backgroundColor: entry.color }}
                              >
                                {entry.code}
                              </button>
                            </td>
                            <td className="py-1 px-1.5 text-slate-200 truncate max-w-[6.5rem]">
                              {entry.item.object}
                            </td>
                            <td className="py-1 px-1.5 font-sans text-[10px] text-slate-400">
                              {entry.kind === "placement"
                                ? t("collect.kindPlacement")
                                : entry.item.tier === "dense"
                                  ? t("collect.tierDense")
                                  : entry.item.tier === "edge"
                                    ? t("collect.tierEdge")
                                    : t("collect.tierEmpty")}
                            </td>
                            <td className="py-1 px-1 text-right text-slate-300">
                              {entry.item.x_m.toFixed(3)}
                            </td>
                            <td className="py-1 px-1 text-right text-slate-300">
                              {entry.item.y_m.toFixed(3)}
                            </td>
                            <td className="py-1 pl-1 text-right text-cyan-200">
                              {entry.item.yaw_deg.toFixed(0)}°
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {state.suggestions.omitted_objects.length > 0 && (
                  <p className="rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                    {t("collect.omittedObjects", {
                      objects: state.suggestions.omitted_objects.join(", "),
                    })}
                  </p>
                )}
                {state.suggestions.provenance.note && (
                  <p className="text-[10px] text-slate-500">
                    {state.suggestions.provenance.note}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
