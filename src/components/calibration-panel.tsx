"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "@/context/locale-context";
import { CalibrationFrameCanvas } from "@/components/calibration-frame-canvas";
import { CalibrationOverlayPlayer } from "@/components/calibration-overlay-player";
import type {
  CalibrationEpisodeMediaPayload,
  CalibrationPixel,
  CalibrationPointEntry,
  CalibrationPointUpdate,
  CalibrationRunResult,
  CalibrationStatePayload,
} from "@/types/calibration.types";
import {
  groupCalibrationFramesByArm,
  isFrameClicked,
  isFrameSkipped,
  pickNewlyAddedFrameId,
  rankCalibrationResiduals,
  summarizeCalibrationProgress,
} from "@/utils/calibrationData";
import {
  hasNonZeroDistortion,
  projectTcpToPixel,
} from "@/utils/calibrationMath";
import { copyTextToClipboard } from "@/utils/clipboard";
import {
  blocksAllShortcuts,
  describeShortcutTarget,
} from "@/utils/viewerShortcuts";

interface CalibrationPanelProps {
  encodedPath: string | null;
  datasetName: string;
  totalEpisodes: number;
  currentEpisodeId: number;
  fps: number;
}

type PanelMode = "annotate" | "overlay";

export default function CalibrationPanel({
  encodedPath,
  datasetName,
  totalEpisodes,
  currentEpisodeId,
  fps,
}: CalibrationPanelProps) {
  const t = useT();

  const [state, setState] = useState<CalibrationStatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<PanelMode>("annotate");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftUpdates, setDraftUpdates] = useState<
    Record<string, CalibrationPointUpdate>
  >({});

  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [cliBanner, setCliBanner] = useState<{
    kind: "info" | "ok" | "error";
    title: string;
    command?: string;
    output?: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Per-episode head video metadata cache for fast switching between frames.
  const episodeMediaCacheRef = useRef<
    Map<string, CalibrationEpisodeMediaPayload>
  >(new Map());
  const stateFetchSeqRef = useRef(0);
  const canvasSectionRef = useRef<HTMLDivElement | null>(null);
  const [activeEpisodeMedia, setActiveEpisodeMedia] =
    useState<CalibrationEpisodeMediaPayload | null>(null);
  const [episodeMediaLoading, setEpisodeMediaLoading] = useState(false);
  const [episodeMediaError, setEpisodeMediaError] = useState<string | null>(
    null,
  );

  const fetchState = useCallback(async () => {
    const requestSeq = ++stateFetchSeqRef.current;
    if (!encodedPath) {
      setLoading(false);
      setState(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/local-datasets/${encodedPath}/calibration`,
        {
          cache: "no-store",
        },
      );
      const body = await res.json().catch(() => ({}));
      if (requestSeq !== stateFetchSeqRef.current) return;
      if (!res.ok) {
        setLoadError(
          String((body as { error?: string }).error ?? `HTTP ${res.status}`),
        );
        setState(null);
        return;
      }
      const next = body as CalibrationStatePayload;
      setState(next);
      setSelectedId((prev) => {
        if (prev && next.frames.some((f) => f.id === prev)) return prev;
        return next.frames[0]?.id ?? null;
      });
    } catch (err) {
      if (requestSeq !== stateFetchSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestSeq === stateFetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, [encodedPath]);

  useEffect(() => {
    episodeMediaCacheRef.current.clear();
    setActiveEpisodeMedia(null);
    setEpisodeMediaError(null);
    setDraftUpdates({});
    setSaveFeedback(null);
    setCliBanner(null);
    void fetchState();
  }, [fetchState]);

  // Apply unsaved local edits over loaded frames.
  const effectiveFrames = useMemo<CalibrationPointEntry[]>(() => {
    if (!state) return [];
    return state.frames.map((frame) => {
      const draft = draftUpdates[frame.id];
      if (!draft) return frame;
      const copy: CalibrationPointEntry = { ...frame };
      if (draft.pixel) {
        copy.pixel = draft.pixel;
        delete copy.skipped;
      } else if (draft.skipped === true) {
        copy.skipped = true;
        delete copy.pixel;
      } else {
        delete copy.pixel;
        delete copy.skipped;
      }
      return copy;
    });
  }, [draftUpdates, state]);

  const progress = useMemo(
    () => summarizeCalibrationProgress(effectiveFrames),
    [effectiveFrames],
  );
  const armGroups = useMemo(
    () => groupCalibrationFramesByArm(effectiveFrames),
    [effectiveFrames],
  );

  const selectedIndex = useMemo(
    () => effectiveFrames.findIndex((f) => f.id === selectedId),
    [effectiveFrames, selectedId],
  );
  const selectedFrame =
    selectedIndex >= 0 ? effectiveFrames[selectedIndex] : null;

  const unsavedCount = Object.keys(draftUpdates).length;

  const selectedEpisodeIndex = selectedFrame?.episode_index ?? null;
  const selectedCamera = state?.camera ?? null;

  const matchedEpisodeMedia = useMemo(() => {
    if (
      !activeEpisodeMedia ||
      selectedEpisodeIndex === null ||
      selectedCamera === null
    ) {
      return null;
    }
    if (
      activeEpisodeMedia.episodeIndex !== selectedEpisodeIndex ||
      activeEpisodeMedia.camera !== selectedCamera
    ) {
      return null;
    }
    return activeEpisodeMedia;
  }, [activeEpisodeMedia, selectedCamera, selectedEpisodeIndex]);

  // Fetch head camera segment metadata for the currently selected frame's episode.
  useEffect(() => {
    if (
      !encodedPath ||
      selectedEpisodeIndex === null ||
      selectedCamera === null ||
      mode !== "annotate"
    ) {
      return;
    }
    const cacheKey = `${selectedEpisodeIndex}:${selectedCamera}`;
    const cached = episodeMediaCacheRef.current.get(cacheKey);
    if (cached) {
      setActiveEpisodeMedia(cached);
      setEpisodeMediaLoading(false);
      setEpisodeMediaError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setActiveEpisodeMedia(null);
    setEpisodeMediaLoading(true);
    setEpisodeMediaError(null);
    const params = new URLSearchParams({
      episode: String(selectedEpisodeIndex),
      camera: selectedCamera,
      includeTcp: "0",
    });

    fetch(`/api/local-datasets/${encodedPath}/calibration/episode?${params}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setEpisodeMediaError(
            String((body as { error?: string }).error ?? `HTTP ${res.status}`),
          );
          setActiveEpisodeMedia(null);
          return;
        }
        const payload = body as CalibrationEpisodeMediaPayload;
        episodeMediaCacheRef.current.set(cacheKey, payload);
        setActiveEpisodeMedia(payload);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setEpisodeMediaError(err instanceof Error ? err.message : String(err));
        setActiveEpisodeMedia(null);
      })
      .finally(() => {
        if (!cancelled) setEpisodeMediaLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [encodedPath, mode, selectedCamera, selectedEpisodeIndex]);

  const setFrameDraft = useCallback(
    (id: string, update: CalibrationPointUpdate) => {
      setSaveFeedback(null);
      setDraftUpdates((prev) => ({ ...prev, [id]: update }));
    },
    [],
  );

  const handleSetPixel = useCallback(
    (pixel: CalibrationPixel) => {
      if (!selectedFrame) return;
      setFrameDraft(selectedFrame.id, {
        id: selectedFrame.id,
        pixel,
        skipped: null,
      });
    },
    [selectedFrame, setFrameDraft],
  );

  const handleToggleSkip = useCallback(() => {
    if (!selectedFrame) return;
    const currentlySkipped = isFrameSkipped(selectedFrame);
    setFrameDraft(selectedFrame.id, {
      id: selectedFrame.id,
      pixel: null,
      skipped: currentlySkipped ? null : true,
    });
  }, [selectedFrame, setFrameDraft]);

  const handleClearAnnotation = useCallback(() => {
    if (!selectedFrame) return;
    setFrameDraft(selectedFrame.id, {
      id: selectedFrame.id,
      pixel: null,
      skipped: null,
    });
  }, [selectedFrame, setFrameDraft]);

  const selectRelative = useCallback(
    (delta: number) => {
      if (effectiveFrames.length === 0) return;
      const base = selectedIndex >= 0 ? selectedIndex : 0;
      const next = Math.max(
        0,
        Math.min(effectiveFrames.length - 1, base + delta),
      );
      setSelectedId(effectiveFrames[next].id);
    },
    [effectiveFrames, selectedIndex],
  );

  const selectNextRemaining = useCallback(() => {
    if (effectiveFrames.length === 0) return;
    const start = selectedIndex >= 0 ? selectedIndex + 1 : 0;
    for (let offset = 0; offset < effectiveFrames.length; offset += 1) {
      const candidate =
        effectiveFrames[(start + offset) % effectiveFrames.length];
      if (!isFrameClicked(candidate) && !isFrameSkipped(candidate)) {
        setSelectedId(candidate.id);
        return;
      }
    }
  }, [effectiveFrames, selectedIndex]);

  const handleSave = useCallback(
    async (
      extraUpdates?: readonly CalibrationPointUpdate[],
    ): Promise<boolean> => {
      if (!encodedPath || !state) return false;
      setSaving(true);
      setSaveFeedback(null);
      try {
        const merged = new Map<string, CalibrationPointUpdate>();
        for (const update of Object.values(draftUpdates)) {
          merged.set(update.id, update);
        }
        if (extraUpdates) {
          for (const update of extraUpdates) {
            merged.set(update.id, update);
          }
        }
        const updates = [...merged.values()];
        const res = await fetch(
          `/api/local-datasets/${encodedPath}/calibration`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ updates }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSaveFeedback({
            kind: "error",
            text: String(
              (body as { error?: string }).error ?? `HTTP ${res.status}`,
            ),
          });
          return false;
        }
        const nextState = body as CalibrationStatePayload;
        setState(nextState);
        setDraftUpdates({});
        setSaveFeedback({
          kind: "ok",
          text: t("calib.savedPoints", { count: updates.length }),
        });
        return true;
      } catch (err) {
        setSaveFeedback({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [draftUpdates, encodedPath, state, t],
  );

  const handleCopy = async (key: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1800);
    }
  };

  const handleRunCli = async (
    action: "calib-frames" | "calibrate",
    append?: number,
  ) => {
    if (!encodedPath || !state) return;

    const copyCommand =
      action === "calibrate"
        ? state.cli.commands.calibrate
        : append
          ? state.cli.commands.appendFrames
          : state.cli.commands.initFrames;

    // If LEROBOT_CHECK_DIR is unset, surface the exact copyable command directly.
    if (!state.cli.configured) {
      setCliBanner({
        kind: "info",
        title: t("calib.cliUnconfiguredTitle"),
        command: copyCommand,
      });
      return;
    }

    // Save pending point edits before running calibrate so CLI sees latest points.json.
    if (action === "calibrate" && unsavedCount > 0) {
      const savedOk = await handleSave();
      if (!savedOk) return;
    }

    const actionKey = append ? `${action}-${append}` : action;
    setRunningAction(actionKey);
    setCliBanner(null);

    try {
      const res = await fetch(
        `/api/local-datasets/${encodedPath}/calibration/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            ...(append ? { append } : {}),
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as Partial<
        CalibrationRunResult & { error?: string }
      >;

      if (body.state) {
        setState(body.state);
        setSelectedId((prev) => {
          if (prev && body.state!.frames.some((f) => f.id === prev))
            return prev;
          return body.state!.frames[0]?.id ?? null;
        });
      }

      if (!res.ok || !body.ok) {
        setCliBanner({
          kind: body.configured === false ? "info" : "error",
          title: body.error ?? `HTTP ${res.status}`,
          command: body.command ?? copyCommand,
          output: [body.stdout, body.stderr].filter(Boolean).join("\n").trim(),
        });
        return;
      }

      setCliBanner({
        kind: "ok",
        title:
          action === "calibrate"
            ? t("calib.calibrateSucceeded")
            : t("calib.framesUpdated"),
        command: body.command,
        output: [body.stdout, body.stderr].filter(Boolean).join("\n").trim(),
      });
    } catch (err) {
      setCliBanner({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
        command: copyCommand,
      });
    } finally {
      setRunningAction(null);
    }
  };

  const handleReplaceFrame = async () => {
    if (!encodedPath || !state || !selectedFrame || runningAction !== null) {
      return;
    }

    const targetArm = selectedFrame.arm;
    const replaceCommand = `${state.cli.commands.initFrames} --append 1 --arms ${targetArm}`;

    if (!state.cli.configured) {
      setCliBanner({
        kind: "info",
        title: t("calib.cliUnconfiguredTitle"),
        command: replaceCommand,
      });
      return;
    }

    const oldFrameIds = state.frames.map((frame) => frame.id);
    const skipUpdate: CalibrationPointUpdate = {
      id: selectedFrame.id,
      pixel: null,
      skipped: true,
    };

    setRunningAction("replace-frame");
    setCliBanner(null);
    setFrameDraft(selectedFrame.id, skipUpdate);

    try {
      const savedOk = await handleSave([skipUpdate]);
      if (!savedOk) return;

      const res = await fetch(
        `/api/local-datasets/${encodedPath}/calibration/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "calib-frames",
            append: 1,
            arms: [targetArm],
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as Partial<
        CalibrationRunResult & { error?: string }
      >;

      if (body.state) {
        setState(body.state);
      }

      if (!res.ok || !body.ok) {
        setCliBanner({
          kind: body.configured === false ? "info" : "error",
          title: body.error ?? `HTTP ${res.status}`,
          command: body.command ?? replaceCommand,
          output: [body.stdout, body.stderr].filter(Boolean).join("\n").trim(),
        });
        return;
      }

      if (body.state) {
        const nextId = pickNewlyAddedFrameId(
          oldFrameIds,
          body.state.frames,
          selectedFrame.id,
        );
        setSelectedId(nextId);
      }

      setCliBanner({
        kind: "ok",
        title: t("calib.frameReplaced"),
        command: body.command ?? replaceCommand,
        output: [body.stdout, body.stderr].filter(Boolean).join("\n").trim(),
      });
    } catch (err) {
      setCliBanner({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
        command: replaceCommand,
      });
    } finally {
      setRunningAction(null);
    }
  };

  // Keyboard shortcuts for Annotate mode: prev / next / skip / clear / save.
  useEffect(() => {
    if (mode !== "annotate") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (blocksAllShortcuts(describeShortcutTarget(e.target))) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const lower = e.key.toLowerCase();
      if (e.key === "ArrowLeft" || lower === "p" || e.key === "[") {
        e.preventDefault();
        selectRelative(-1);
      } else if (e.key === "ArrowRight" || lower === "n" || e.key === "]") {
        e.preventDefault();
        selectRelative(1);
      } else if (lower === "s") {
        e.preventDefault();
        handleToggleSkip();
      } else if (lower === "u") {
        e.preventDefault();
        selectNextRemaining();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        handleClearAnnotation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    handleClearAnnotation,
    handleSave,
    handleToggleSkip,
    mode,
    selectNextRemaining,
    selectRelative,
  ]);

  const reviewFrameIds = useMemo(() => {
    const flagged = new Set<string>();
    if (!state?.head) return flagged;
    for (const arm of Object.values(state.head.arms)) {
      const { items } = rankCalibrationResiduals(arm.residuals);
      for (const item of items) {
        if (item.needsReview) flagged.add(item.id);
      }
    }
    return flagged;
  }, [state]);

  const selectedReprojection = useMemo(() => {
    if (!selectedFrame || !state?.head) return null;
    const armCalib = state.head.arms[selectedFrame.arm];
    if (!armCalib) return null;
    return projectTcpToPixel(
      selectedFrame.tcp,
      armCalib,
      state.head.intrinsics,
    );
  }, [selectedFrame, state]);

  const distortionWarning =
    hasNonZeroDistortion(state?.head?.intrinsics) ||
    hasNonZeroDistortion(state?.intrinsics);

  if (loading) {
    return (
      <div className="panel p-6 text-sm text-slate-400">
        {t("calib.loading")}
      </div>
    );
  }

  if (loadError || !state || !encodedPath) {
    return (
      <div className="panel border-rose-500/40 p-6 text-sm text-rose-200">
        {loadError ?? t("calib.loadError")}
      </div>
    );
  }

  const fileErrors = [
    state.framesFileError,
    state.pointsFileError,
    state.headFileError,
    state.intrinsicsFileError,
  ].filter((item): item is string => Boolean(item));

  const initialOverlayEpisode =
    selectedFrame?.episode_index ?? currentEpisodeId ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Header & action bar */}
      <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-xs">
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold text-slate-100"
            title={datasetName}
          >
            {t("calib.title")} · {state.repoId}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span className="font-mono">{state.camera}</span>
            <span className="font-mono">
              {state.imageSize[0]}×{state.imageSize[1]}
            </span>
            <span
              className={`rounded px-1.5 py-0.5 ${
                state.intrinsicsExists && !state.intrinsicsFileError
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-amber-500/15 text-amber-300"
              }`}
            >
              {state.intrinsicsExists
                ? t("calib.intrinsicsPresent")
                : t("calib.intrinsicsMissing")}
            </span>
          </div>
        </div>

        {/* Mode toggle */}
        <div
          role="tablist"
          className="inline-flex overflow-hidden rounded-md border border-white/10"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "annotate"}
            onClick={() => setMode("annotate")}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === "annotate"
                ? "bg-cyan-500/20 text-cyan-100"
                : "bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
            }`}
          >
            {t("calib.modeAnnotate")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "overlay"}
            disabled={!state.head}
            title={!state.head ? t("calib.overlayNeedsHead") : undefined}
            onClick={() => setMode("overlay")}
            className={`px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
              mode === "overlay"
                ? "bg-cyan-500/20 text-cyan-100"
                : "bg-[var(--surface-1)]/60 text-slate-300 hover:text-slate-100"
            }`}
          >
            {t("calib.modeOverlay")}
          </button>
        </div>

        {/* Action buttons */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {effectiveFrames.length > 0 && (
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className={`rounded-md border px-2.5 py-1.5 font-medium transition-colors disabled:opacity-50 ${
                unsavedCount > 0
                  ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30"
                  : "border-white/10 bg-[var(--surface-1)]/60 text-slate-200 hover:border-cyan-400/40"
              }`}
            >
              {saving
                ? t("calib.saving")
                : unsavedCount > 0
                  ? t("calib.saveWithCount", { count: unsavedCount })
                  : t("calib.savePoints")}
            </button>
          )}

          <button
            type="button"
            disabled={runningAction !== null}
            onClick={() =>
              void handleRunCli(
                "calib-frames",
                state.framesExists ? 5 : undefined,
              )
            }
            className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-slate-200 hover:border-cyan-400/40 hover:text-cyan-100 disabled:opacity-50"
          >
            {runningAction?.startsWith("calib-frames")
              ? t("calib.running")
              : state.framesExists
                ? t("calib.appendFrames")
                : t("calib.initFrames")}
          </button>

          <button
            type="button"
            disabled={runningAction !== null}
            onClick={() => void handleRunCli("calibrate")}
            className="rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2.5 py-1.5 font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {runningAction === "calibrate"
              ? t("calib.running")
              : t("calib.runCalibrate")}
          </button>

          <button
            type="button"
            onClick={() => void fetchState()}
            className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-100"
          >
            {t("dist.refresh")}
          </button>
        </div>
      </div>

      {/* Malformed file errors */}
      {fileErrors.length > 0 && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200 space-y-1">
          {fileErrors.map((msg, i) => (
            <p key={i} className="font-mono break-all">
              {msg}
            </p>
          ))}
        </div>
      )}

      {/* Stale points.json merge notices */}
      {state.mergeNotice.fileIdentityMismatch && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
          {t("calib.mergeIdentityMismatch", {
            pointsRepo: state.mergeNotice.fileIdentityMismatch.pointsRepoId,
            pointsRev:
              state.mergeNotice.fileIdentityMismatch.pointsRevision.slice(
                0,
                8,
              ) || "unknown",
            framesRepo: state.mergeNotice.fileIdentityMismatch.framesRepoId,
            framesRev:
              state.mergeNotice.fileIdentityMismatch.framesRevision.slice(
                0,
                8,
              ) || "unknown",
            count: state.mergeNotice.droppedByIdentityMismatchCount,
          })}
        </div>
      )}
      {state.mergeNotice.droppedFrameMismatchCount > 0 && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
          {t("calib.mergeFrameMismatch", {
            count: state.mergeNotice.droppedFrameMismatchCount,
            ids: state.mergeNotice.droppedFrameMismatchIds.join(", "),
          })}
        </div>
      )}

      {/* Non-zero distortion warning */}
      {distortionWarning && mode === "annotate" && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          {t("calib.distortionWarning")}
        </div>
      )}

      {/* Save feedback */}
      {saveFeedback && (
        <div
          className={`rounded-md border px-4 py-2 text-xs ${
            saveFeedback.kind === "ok"
              ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          {saveFeedback.text}
        </div>
      )}

      {/* CLI execution banner or copyable command */}
      {cliBanner && (
        <div
          className={`rounded-md border px-4 py-3 text-xs space-y-2 ${
            cliBanner.kind === "ok"
              ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
              : cliBanner.kind === "error"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-100"
                : "border-cyan-400/35 bg-cyan-500/10 text-cyan-100"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">{cliBanner.title}</p>
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
              <pre className="flex-1 overflow-x-auto rounded border border-white/10 bg-black/50 px-3 py-2 font-mono text-[11px] text-cyan-200">
                {cliBanner.command}
              </pre>
              <button
                type="button"
                onClick={() => void handleCopy("banner", cliBanner.command!)}
                className="shrink-0 rounded border border-white/15 bg-[var(--surface-1)]/80 px-2.5 py-1.5 text-slate-200 hover:border-cyan-400/50"
              >
                {copiedKey === "banner" ? t("dist.copied") : t("common.copy")}
              </button>
            </div>
          )}
          {cliBanner.output && (
            <pre className="max-h-36 overflow-auto rounded border border-white/10 bg-black/40 p-2.5 font-mono text-[11px] text-slate-300 whitespace-pre-wrap">
              {cliBanner.output}
            </pre>
          )}
        </div>
      )}

      {/* Overlay verification mode */}
      {mode === "overlay" && state.head && (
        <CalibrationOverlayPlayer
          encodedPath={encodedPath}
          head={state.head}
          totalEpisodes={totalEpisodes}
          initialEpisode={initialOverlayEpisode}
        />
      )}

      {/* Annotate mode */}
      {mode === "annotate" && (
        <>
          {effectiveFrames.length === 0 ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-6">
              <div className="panel-raised space-y-4 p-6">
                <h2 className="text-base font-semibold text-slate-100">
                  {t("calib.missingFramesTitle")}
                </h2>
                <p className="text-sm text-slate-300">
                  {t("calib.missingFramesDesc")}
                </p>
                <div className="rounded-md border border-white/10 bg-black/30 p-3 text-xs">
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                    {t("calib.expectedPath")}
                  </p>
                  <p className="break-all font-mono text-slate-300">
                    {state.paths.framesPath}
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-300">
                      {t("calib.cliCommandLabel")}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopy("init", state.cli.commands.initFrames)
                      }
                      className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-slate-200 hover:border-cyan-400/40"
                    >
                      {copiedKey === "init"
                        ? t("dist.copied")
                        : t("common.copy")}
                    </button>
                  </div>
                  <pre className="overflow-x-auto rounded-md border border-cyan-400/20 bg-black/50 p-3 font-mono text-xs text-cyan-200">
                    {state.cli.commands.initFrames}
                  </pre>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
              {/* Left: Head camera canvas + frame controls */}
              <div className="flex flex-col gap-3">
                {selectedFrame && (
                  <>
                    <div ref={canvasSectionRef} className="panel p-3.5">
                      <CalibrationFrameCanvas
                        frame={selectedFrame}
                        imageSize={state.imageSize}
                        video={matchedEpisodeMedia?.video ?? null}
                        mediaEpisodeIndex={
                          matchedEpisodeMedia?.episodeIndex ?? null
                        }
                        episodeLength={
                          matchedEpisodeMedia?.episodeLength ?? null
                        }
                        fps={matchedEpisodeMedia?.fps ?? fps}
                        loading={
                          episodeMediaLoading ||
                          (matchedEpisodeMedia === null &&
                            episodeMediaError === null)
                        }
                        error={episodeMediaError}
                        reprojected={selectedReprojection}
                        onSetPixel={handleSetPixel}
                      />

                      {/* Frame metadata & navigation bar */}
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3 text-xs">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={selectedIndex <= 0}
                            onClick={() => selectRelative(-1)}
                            className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-slate-200 disabled:opacity-40 hover:border-cyan-400/40"
                          >
                            {t("calib.prevFrame")}
                          </button>
                          <button
                            type="button"
                            disabled={
                              selectedIndex >= effectiveFrames.length - 1
                            }
                            onClick={() => selectRelative(1)}
                            className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-slate-200 disabled:opacity-40 hover:border-cyan-400/40"
                          >
                            {t("calib.nextFrame")}
                          </button>
                          <button
                            type="button"
                            onClick={selectNextRemaining}
                            className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-slate-300 hover:border-cyan-400/40"
                          >
                            {t("calib.nextRemaining")}
                          </button>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={handleToggleSkip}
                            className={`rounded border px-2.5 py-1 transition-colors ${
                              isFrameSkipped(selectedFrame)
                                ? "border-amber-400/50 bg-amber-500/20 text-amber-100"
                                : "border-white/10 bg-[var(--surface-1)]/60 text-slate-300 hover:border-amber-400/40"
                            }`}
                          >
                            {isFrameSkipped(selectedFrame)
                              ? t("calib.unskip")
                              : t("calib.skipFrame")}
                          </button>
                          <button
                            type="button"
                            disabled={runningAction !== null}
                            title={t("calib.replaceFrameTitle")}
                            onClick={() => void handleReplaceFrame()}
                            className="rounded border border-cyan-400/35 bg-cyan-500/10 px-2.5 py-1 text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
                          >
                            {runningAction === "replace-frame"
                              ? t("calib.running")
                              : t("calib.replaceFrame")}
                          </button>
                          {(isFrameClicked(selectedFrame) ||
                            isFrameSkipped(selectedFrame)) && (
                            <button
                              type="button"
                              onClick={handleClearAnnotation}
                              className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-slate-400 hover:border-rose-400/40 hover:text-rose-200"
                            >
                              {t("calib.clearPoint")}
                            </button>
                          )}
                        </div>

                        <div className="ml-auto flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400">
                          <span className="text-slate-100 font-semibold">
                            {selectedFrame.id}
                          </span>
                          <span>
                            ep {selectedFrame.episode_index} · frame{" "}
                            {selectedFrame.frame_index}
                          </span>
                          {typeof selectedFrame.speed_mps === "number" && (
                            <span>
                              {selectedFrame.speed_mps.toFixed(3)} m/s
                            </span>
                          )}
                          <span>
                            tcp ({selectedFrame.tcp[0].toFixed(3)},{" "}
                            {selectedFrame.tcp[1].toFixed(3)},{" "}
                            {selectedFrame.tcp[2].toFixed(3)})
                          </span>
                        </div>
                      </div>

                      <p className="mt-2 text-[11px] text-slate-500">
                        {t("calib.shortcutsHint")}
                      </p>
                    </div>
                  </>
                )}

                {/* Copyable CLI commands helper when LEROBOT_CHECK_DIR is unset */}
                {!state.cli.configured && (
                  <div className="panel space-y-2 p-3.5 text-xs">
                    <p className="text-slate-400">
                      {t("calib.cliUnconfiguredHint")}
                    </p>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      {(
                        [
                          {
                            key: "append",
                            label: t("calib.appendFrames"),
                            cmd: state.cli.commands.appendFrames,
                          },
                          {
                            key: "calibrate",
                            label: t("calib.runCalibrate"),
                            cmd: state.cli.commands.calibrate,
                          },
                        ] as const
                      ).map((item) => (
                        <div
                          key={item.key}
                          className="rounded border border-white/10 bg-black/35 p-2 space-y-1"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-slate-300">
                              {item.label}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                void handleCopy(item.key, item.cmd)
                              }
                              className="text-[11px] text-cyan-300 hover:text-cyan-100"
                            >
                              {copiedKey === item.key
                                ? t("dist.copied")
                                : t("common.copy")}
                            </button>
                          </div>
                          <pre className="overflow-x-auto font-mono text-[10px] text-cyan-200/90">
                            {item.cmd}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right sidebar: Progress, frame list by arm, and calibration results */}
              <div className="flex flex-col gap-3">
                {/* Progress & frames grouped by arm */}
                <div className="panel flex flex-col gap-3 p-3.5">
                  <div className="flex items-baseline justify-between text-xs">
                    <h3 className="font-semibold text-slate-100">
                      {t("calib.framesListTitle")}
                    </h3>
                    <span className="font-mono text-[11px] text-slate-400 tabular">
                      {t("calib.progressSummary", {
                        clicked: progress.clicked,
                        skipped: progress.skipped,
                        remaining: progress.remaining,
                      })}
                    </span>
                  </div>

                  <div className="max-h-[46vh] space-y-3 overflow-y-auto pr-1">
                    {armGroups.map((group) => {
                      const armStat = progress.byArm.find(
                        (s) => s.arm === group.arm,
                      );
                      const donePct = armStat?.total
                        ? Math.round(
                            ((armStat.clicked + armStat.skipped) /
                              armStat.total) *
                              100,
                          )
                        : 0;
                      return (
                        <div key={group.arm} className="space-y-1.5">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-mono font-semibold uppercase tracking-wide text-cyan-300">
                              {group.arm}
                            </span>
                            {armStat && (
                              <span className="font-mono text-slate-400 tabular">
                                {armStat.clicked}/{armStat.total} ·{" "}
                                {t("calib.armCounts", {
                                  skipped: armStat.skipped,
                                  remaining: armStat.remaining,
                                })}
                              </span>
                            )}
                          </div>
                          <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                            <div
                              className="h-full bg-emerald-400 transition-all"
                              style={{ width: `${donePct}%` }}
                            />
                          </div>
                          <div className="space-y-1">
                            {group.frames.map((frame) => {
                              const active = frame.id === selectedId;
                              const clicked = isFrameClicked(frame);
                              const skipped = isFrameSkipped(frame);
                              const dirty = Boolean(draftUpdates[frame.id]);
                              const needsReview = reviewFrameIds.has(frame.id);
                              return (
                                <button
                                  key={frame.id}
                                  type="button"
                                  onClick={() => setSelectedId(frame.id)}
                                  className={`flex w-full items-center justify-between rounded border px-2.5 py-1.5 text-left text-xs transition-colors ${
                                    active
                                      ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-50"
                                      : "border-white/5 bg-[var(--surface-1)]/40 text-slate-300 hover:border-white/20"
                                  }`}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                                        clicked
                                          ? "bg-emerald-400"
                                          : skipped
                                            ? "bg-slate-500"
                                            : "border border-amber-400 bg-transparent"
                                      }`}
                                    />
                                    <span className="font-mono truncate">
                                      {frame.id}
                                    </span>
                                    {needsReview && (
                                      <span className="shrink-0 rounded border border-rose-400/40 bg-rose-500/20 px-1 py-0.5 text-[10px] leading-none font-medium text-rose-200">
                                        {t("calib.reviewBadge")}
                                      </span>
                                    )}
                                    {dirty && (
                                      <span className="text-[10px] text-amber-300">
                                        *
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 font-mono text-[10px] text-slate-400 tabular shrink-0">
                                    <span>
                                      ep{frame.episode_index}:f
                                      {frame.frame_index}
                                    </span>
                                    {clicked && frame.pixel ? (
                                      <span className="text-emerald-300">
                                        {frame.pixel[0].toFixed(0)},
                                        {frame.pixel[1].toFixed(0)}
                                      </span>
                                    ) : skipped ? (
                                      <span className="text-slate-500">
                                        {t("calib.statusSkippedShort")}
                                      </span>
                                    ) : (
                                      <span className="text-amber-300/80">
                                        --
                                      </span>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Calibration result metrics & clickable residuals */}
                {state.head && (
                  <div className="panel flex flex-col gap-3 p-3.5 text-xs">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-100">
                        {t("calib.resultsTitle")}
                      </h3>
                      <button
                        type="button"
                        onClick={() => setMode("overlay")}
                        className="text-[11px] font-medium text-cyan-300 hover:text-cyan-100"
                      >
                        {t("calib.openOverlay")} →
                      </button>
                    </div>

                    <div className="space-y-3">
                      {Object.entries(state.head.arms).map(([armName, arm]) => {
                        const { thresholdPx, items: sortedResiduals } =
                          rankCalibrationResiduals(arm.residuals);
                        return (
                          <div
                            key={armName}
                            className="rounded border border-white/10 bg-black/25 p-2.5 space-y-2"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-mono font-semibold uppercase text-cyan-300">
                                {armName}
                              </span>
                              <span className="font-mono text-[11px] text-slate-400">
                                n={arm.n_points}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 gap-2 font-mono text-[11px] tabular">
                              <div className="rounded bg-white/5 px-2 py-1">
                                <span className="block text-[10px] text-slate-500">
                                  RMS
                                </span>
                                <span
                                  className={
                                    arm.rms_px <= 5
                                      ? "text-emerald-300"
                                      : "text-amber-300"
                                  }
                                >
                                  {arm.rms_px.toFixed(2)} px
                                </span>
                              </div>
                              <div className="rounded bg-white/5 px-2 py-1">
                                <span className="block text-[10px] text-slate-500">
                                  LOO RMS
                                </span>
                                <span
                                  className={
                                    arm.loo_rms_px <= 8
                                      ? "text-emerald-300"
                                      : "text-amber-300"
                                  }
                                >
                                  {arm.loo_rms_px.toFixed(2)} px
                                </span>
                              </div>
                            </div>

                            <p className="font-mono text-[10px] text-slate-500">
                              tool_offset: [
                              {arm.tool_offset
                                .map((v) => `${(v * 1000).toFixed(1)}mm`)
                                .join(", ")}
                              ]
                            </p>

                            {sortedResiduals.length > 0 && (
                              <div className="space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-[10px] uppercase tracking-wide text-slate-500">
                                    {t("calib.residualsTitle")}
                                  </p>
                                  <span className="shrink-0 font-mono text-[10px] text-slate-500 tabular">
                                    {t("calib.reviewThreshold", {
                                      px: thresholdPx.toFixed(1),
                                    })}
                                  </span>
                                </div>
                                <div className="max-h-36 space-y-1 overflow-y-auto pr-0.5">
                                  {sortedResiduals.map((res) => {
                                    const active = res.id === selectedId;
                                    return (
                                      <button
                                        key={res.id}
                                        type="button"
                                        onClick={() => {
                                          setMode("annotate");
                                          setSelectedId(res.id);
                                          canvasSectionRef.current?.scrollIntoView(
                                            {
                                              behavior: "smooth",
                                              block: "nearest",
                                            },
                                          );
                                        }}
                                        className={`flex w-full items-center justify-between gap-1.5 rounded px-2 py-1 font-mono text-[11px] transition-colors ${
                                          active
                                            ? "bg-cyan-500/20 text-cyan-100"
                                            : res.needsReview
                                              ? "border border-rose-500/35 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20"
                                              : "bg-white/5 text-slate-300 hover:bg-white/10"
                                        }`}
                                      >
                                        <span className="flex items-center gap-1.5 min-w-0">
                                          <span className="truncate">
                                            {res.id}
                                          </span>
                                          {res.needsReview && (
                                            <span className="shrink-0 rounded border border-rose-400/50 bg-rose-500/25 px-1 py-0.5 font-sans text-[10px] leading-none font-medium text-rose-100">
                                              {t("calib.reviewBadge")}
                                            </span>
                                          )}
                                        </span>
                                        <span className="text-slate-400 shrink-0">
                                          ({res.du >= 0 ? "+" : ""}
                                          {res.du.toFixed(1)},{" "}
                                          {res.dv >= 0 ? "+" : ""}
                                          {res.dv.toFixed(1)})
                                        </span>
                                        <span
                                          className={`shrink-0 ${
                                            res.needsReview
                                              ? "font-semibold text-rose-300"
                                              : res.normPx <= 5
                                                ? "text-emerald-300"
                                                : "text-amber-300"
                                          }`}
                                        >
                                          {res.normPx.toFixed(1)} px
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
