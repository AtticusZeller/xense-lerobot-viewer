"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTime } from "@/context/time-context";
import { useLocale } from "@/context/locale-context";
import type {
  SubtaskAnnotationRow,
  SubtaskEpisodePayload,
  SubtaskSaveResponse,
  TaskSpec,
} from "@/types/subtask-annotation.types";
import { resolveDraftAnnotators } from "@/utils/subtaskCsv";
import {
  activeSubtaskIndexAt,
  addBoundaryAtFrame,
  colorForSubtask,
  createRowsFromTaskSpec,
  frameToTime,
  moveRowEnd,
  moveRowStart,
  removeRowAndAbsorb,
  timeToFrame,
  validateEpisodeSubtasks,
} from "@/utils/subtaskEditor";
import {
  blocksAllShortcuts,
  describeShortcutTarget,
} from "@/utils/viewerShortcuts";

interface SubtaskPanelProps {
  encodedPath: string;
  episodeId: number;
  fps: number;
  episodeLengthFallback?: number;
  onSubtaskStateChange?: (state: {
    rows: SubtaskAnnotationRow[];
    taskSpec: TaskSpec | null;
    episodeLength: number;
  }) => void;
}

const ANNOTATOR_BADGE: Record<string, string> = {
  human: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
  agent: "border-amber-400/40 bg-amber-500/15 text-amber-200",
  converted: "border-sky-400/40 bg-sky-500/15 text-sky-200",
};

export function SubtaskPanel({
  encodedPath,
  episodeId,
  fps,
  episodeLengthFallback,
  onSubtaskStateChange,
}: SubtaskPanelProps) {
  const { t, tp } = useLocale();
  const { currentTime, duration, seek, setIsPlaying } = useTime();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [payload, setPayload] = useState<SubtaskEpisodePayload | null>(null);
  const [persistedRows, setPersistedRows] = useState<SubtaskAnnotationRow[]>(
    [],
  );
  const [draftRows, setDraftRows] = useState<SubtaskAnnotationRow[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const [jumpFrameInput, setJumpFrameInput] = useState("");
  const userToggledRef = useRef(false);

  const onStateChangeRef = useRef(onSubtaskStateChange);
  onStateChangeRef.current = onSubtaskStateChange;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveMessage(null);

    fetch(`/api/local-datasets/${encodedPath}/subtasks?episode=${episodeId}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(
            String((body as { error?: string }).error ?? `HTTP ${res.status}`),
          );
          setPayload(null);
          setPersistedRows([]);
          setDraftRows([]);
          return;
        }
        const loaded = body as SubtaskEpisodePayload;
        setPayload(loaded);
        setPersistedRows(loaded.rows);
        setDraftRows(loaded.rows);
        if (!userToggledRef.current) {
          setExpanded(loaded.csvExists || loaded.taskSpec !== null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [encodedPath, episodeId]);

  const episodeLength = useMemo(() => {
    if (payload && payload.episodeLength > 0) return payload.episodeLength;
    if (episodeLengthFallback && episodeLengthFallback > 0)
      return episodeLengthFallback;
    if (fps > 0 && duration > 0) return Math.max(1, Math.round(duration * fps));
    return 0;
  }, [payload, episodeLengthFallback, fps, duration]);

  const taskSpec = payload?.taskSpec ?? null;

  useEffect(() => {
    onStateChangeRef.current?.({
      rows: draftRows,
      taskSpec,
      episodeLength,
    });
  }, [draftRows, taskSpec, episodeLength]);

  const currentFrame = useMemo(
    () => timeToFrame(currentTime, fps, episodeLength),
    [currentTime, fps, episodeLength],
  );

  const activeRowIndex = useMemo(
    () => activeSubtaskIndexAt(draftRows, currentFrame),
    [draftRows, currentFrame],
  );

  const { rows: resolvedDraftRows, changedIndices } = useMemo(
    () => resolveDraftAnnotators(persistedRows, draftRows),
    [persistedRows, draftRows],
  );

  const isDirty = useMemo(() => {
    if (draftRows.length !== persistedRows.length) return true;
    return changedIndices.size > 0;
  }, [draftRows.length, persistedRows.length, changedIndices.size]);

  const issues = useMemo(() => {
    if (draftRows.length === 0 && persistedRows.length === 0) return [];
    return validateEpisodeSubtasks(resolvedDraftRows, episodeLength, taskSpec);
  }, [
    resolvedDraftRows,
    draftRows.length,
    persistedRows.length,
    episodeLength,
    taskSpec,
  ]);

  const canSave =
    !saving &&
    draftRows.length > 0 &&
    issues.length === 0 &&
    (isDirty || !payload?.csvExists);

  const seekToFrame = useCallback(
    (frame: number) => {
      if (episodeLength <= 0 || fps <= 0) return;
      const clamped = Math.max(0, Math.min(episodeLength - 1, frame));
      setIsPlaying(false);
      seek(frameToTime(clamped, fps), "external");
    },
    [episodeLength, fps, seek, setIsPlaying],
  );

  const stepFrames = useCallback(
    (delta: number) => {
      seekToFrame(currentFrame + delta);
    },
    [currentFrame, seekToFrame],
  );

  const handleSave = useCallback(async () => {
    if (!canSave || !payload) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch(`/api/local-datasets/${encodedPath}/subtasks`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episodeIndex: episodeId,
          rows: resolvedDraftRows,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveMessage({
          kind: "error",
          text: String(
            (body as { error?: string }).error ?? `HTTP ${res.status}`,
          ),
        });
        return;
      }
      const saved = body as SubtaskSaveResponse;
      setPayload(saved);
      setPersistedRows(saved.rows);
      setDraftRows(saved.rows);
      setSaveMessage({
        kind: "ok",
        text:
          saved.changedRowCount > 0
            ? tp("subtask.savedChanged", saved.changedRowCount)
            : t("subtask.savedNoDiff"),
      });
    } catch (err: unknown) {
      setSaveMessage({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }, [canSave, payload, encodedPath, episodeId, resolvedDraftRows, t, tp]);

  const shortcutStateRef = useRef({
    currentFrame,
    episodeLength,
    canSave,
    stepFrames,
    handleSave,
  });
  shortcutStateRef.current = {
    currentFrame,
    episodeLength,
    canSave,
    stepFrames,
    handleSave,
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = shortcutStateRef.current;
      if (state.episodeLength <= 0) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (!state.canSave) return;
        e.preventDefault();
        void state.handleSave();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const focus = describeShortcutTarget(e.target);
      if (blocksAllShortcuts(focus)) return;

      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft" || e.key === ",") {
        e.preventDefault();
        state.stepFrames(-step);
      } else if (e.key === "ArrowRight" || e.key === ".") {
        e.preventDefault();
        state.stepFrames(step);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const updateRow = (idx: number, patch: Partial<SubtaskAnnotationRow>) => {
    setSaveMessage(null);
    setDraftRows((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );
  };

  const handleSetStart = (idx: number, frame: number) => {
    setSaveMessage(null);
    setDraftRows((prev) => moveRowStart(prev, idx, frame));
  };

  const handleSetEnd = (idx: number, frame: number) => {
    setSaveMessage(null);
    setDraftRows((prev) => moveRowEnd(prev, idx, frame));
  };

  const handleSplitAtCurrentFrame = () => {
    if (!payload) return;
    setSaveMessage(null);
    setDraftRows((prev) =>
      addBoundaryAtFrame(prev, currentFrame, taskSpec, {
        repoId: payload.repoId,
        revision: payload.revision,
        episodeIndex: episodeId,
      }),
    );
  };

  const handleRemoveRow = (idx: number) => {
    setSaveMessage(null);
    setDraftRows((prev) => removeRowAndAbsorb(prev, idx));
  };

  const handleCreateFromSpec = (startIdx?: number, endIdx?: number) => {
    if (!payload || !taskSpec || episodeLength <= 0) return;
    setSaveMessage(null);
    setDraftRows(
      createRowsFromTaskSpec(taskSpec, {
        repoId: payload.repoId,
        revision: payload.revision,
        episodeIndex: episodeId,
        episodeLength,
        startSubtaskIndex: startIdx,
        endSubtaskIndex: endIdx,
      }),
    );
  };

  const handleCreateManualRow = () => {
    if (!payload || episodeLength <= 0) return;
    setSaveMessage(null);
    setDraftRows([
      {
        repo_id: payload.repoId,
        revision: payload.revision,
        episode_index: episodeId,
        subtask: taskSpec?.subtasks[0]?.name ?? "subtask_0",
        start: 0,
        end: episodeLength,
        contact: null,
        grasp: null,
        success: true,
        annotator: "human",
        note: "",
      },
    ]);
  };

  const handleRevert = () => {
    setSaveMessage(null);
    setDraftRows(persistedRows);
  };

  const canSplitAtCurrent = draftRows.some(
    (row) => currentFrame > row.start && currentFrame < row.end,
  );

  const activeRow = activeRowIndex >= 0 ? draftRows[activeRowIndex] : null;
  const activePrompt = activeRow
    ? taskSpec?.subtasks.find((s) => s.name === activeRow.subtask)?.prompt
    : null;

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number.parseInt(jumpFrameInput.trim(), 10);
    if (Number.isInteger(parsed)) {
      seekToFrame(parsed);
      setJumpFrameInput("");
    }
  };

  return (
    <section className="panel shrink-0 overflow-hidden">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/5 bg-[var(--surface-1)]/40 px-4 py-2.5">
        <button
          type="button"
          onClick={() => {
            userToggledRef.current = true;
            setExpanded((v) => !v);
          }}
          className="inline-flex items-center gap-2 text-sm font-semibold text-slate-100 hover:text-cyan-200 transition-colors"
        >
          <span className="text-[10px] text-slate-400">
            {expanded ? "▼" : "▶"}
          </span>
          <span>{t("subtask.title")}</span>
        </button>

        {activeRow && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-medium text-slate-100">
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: colorForSubtask(
                  activeRow.subtask,
                  taskSpec,
                  activeRowIndex,
                ),
              }}
            />
            {activeRow.subtask}
          </span>
        )}

        {activePrompt && (
          <span
            className="hidden xl:inline max-w-md truncate text-xs text-slate-400"
            title={activePrompt}
          >
            {activePrompt}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <span className="tabular font-mono text-slate-300">
            {t("subtask.currentFrame", {
              frame: currentFrame,
              total: episodeLength,
              time: currentTime.toFixed(2),
            })}
          </span>
          {isDirty && (
            <span className="rounded bg-amber-500/20 border border-amber-400/30 px-1.5 py-0.5 text-[11px] text-amber-200">
              {t("subtask.unsaved")}
            </span>
          )}
          {payload && (
            <span
              className="hidden sm:inline font-mono text-[11px] text-slate-500"
              title={payload.csvPath}
            >
              @{payload.revision.slice(0, 8)}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 p-4">
          {loading ? (
            <p className="text-xs text-slate-400">{t("subtask.loading")}</p>
          ) : loadError ? (
            <p className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {loadError}
            </p>
          ) : (
            <>
              {payload?.taskSpecError && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  {t("subtask.taskSpecError", { error: payload.taskSpecError })}
                </div>
              )}

              {/* Frame-stepping toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center overflow-hidden rounded-md border border-white/10 bg-[var(--surface-1)]/60 text-xs">
                  <button
                    type="button"
                    onClick={() => stepFrames(-10)}
                    title="Shift+←"
                    className="px-2 py-1 tabular text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
                  >
                    -10f
                  </button>
                  <button
                    type="button"
                    onClick={() => stepFrames(-1)}
                    title="← / ,"
                    className="border-l border-white/10 px-2.5 py-1 tabular text-slate-200 hover:bg-white/10 hover:text-white transition-colors"
                  >
                    -1f
                  </button>
                  <button
                    type="button"
                    onClick={() => stepFrames(1)}
                    title="→ / ."
                    className="border-l border-white/10 px-2.5 py-1 tabular text-slate-200 hover:bg-white/10 hover:text-white transition-colors"
                  >
                    +1f
                  </button>
                  <button
                    type="button"
                    onClick={() => stepFrames(10)}
                    title="Shift+→"
                    className="border-l border-white/10 px-2 py-1 tabular text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
                  >
                    +10f
                  </button>
                </div>

                <form
                  onSubmit={handleJumpSubmit}
                  className="inline-flex items-center gap-1"
                >
                  <input
                    type="number"
                    min={0}
                    max={Math.max(0, episodeLength - 1)}
                    value={jumpFrameInput}
                    onChange={(e) => setJumpFrameInput(e.target.value)}
                    placeholder={t("subtask.jumpPlaceholder")}
                    className="w-24 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs tabular text-slate-200 placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-xs text-slate-300 hover:border-cyan-400/40 hover:text-cyan-100"
                  >
                    {t("subtask.jump")}
                  </button>
                </form>

                {draftRows.length > 0 && (
                  <button
                    type="button"
                    disabled={!canSplitAtCurrent}
                    onClick={handleSplitAtCurrentFrame}
                    className="rounded-md border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {t("subtask.addBoundary", { frame: currentFrame })}
                  </button>
                )}

                <span className="ml-auto hidden lg:inline text-[11px] text-slate-500">
                  {t("subtask.shortcutsHint")}
                </span>
              </div>

              {/* Empty episode creation controls */}
              {draftRows.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/15 bg-black/20 p-4 text-xs text-slate-300 space-y-3">
                  <p>{t("subtask.emptyEpisode")}</p>
                  {taskSpec ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleCreateFromSpec()}
                        className="rounded-md bg-cyan-500/20 border border-cyan-400/40 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-500/30 transition-colors"
                      >
                        {t("subtask.createAllFromSpec", {
                          count: taskSpec.subtasks.length,
                        })}
                      </button>
                      {taskSpec.subtasks.map((spec, idx) => (
                        <button
                          key={spec.name}
                          type="button"
                          onClick={() => handleCreateFromSpec(idx, idx)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1.5 text-xs text-slate-200 hover:border-cyan-400/40 hover:text-cyan-100 transition-colors"
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{
                              backgroundColor: colorForSubtask(
                                spec.name,
                                taskSpec,
                                idx,
                              ),
                            }}
                          />
                          {t("subtask.createSingle", { name: spec.name })}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2 text-slate-400">
                      <p>{t("subtask.noTaskSpecHint")}</p>
                      {payload && (
                        <div className="space-y-1 font-mono text-[11px] text-slate-500 break-all">
                          <div>CSV: {payload.csvPath}</div>
                          <div>Spec: {payload.taskSpecPath}</div>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={handleCreateManualRow}
                        className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-slate-200 hover:border-cyan-400/40"
                      >
                        {t("subtask.createManual")}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                /* Editable rows table */
                <div className="overflow-x-auto rounded-lg border border-white/10">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/[0.03] text-[11px] uppercase tracking-wide text-slate-400">
                        <th className="px-2.5 py-2">
                          {t("subtask.colSubtask")}
                        </th>
                        <th className="px-2.5 py-2">{t("subtask.colStart")}</th>
                        <th className="px-2.5 py-2">{t("subtask.colEnd")}</th>
                        <th className="px-2.5 py-2">{t("subtask.contact")}</th>
                        <th className="px-2.5 py-2">{t("subtask.grasp")}</th>
                        <th className="px-2.5 py-2">
                          {t("subtask.colSuccess")}
                        </th>
                        <th className="px-2.5 py-2">
                          {t("subtask.colAnnotator")}
                        </th>
                        <th className="px-2.5 py-2">{t("subtask.colNote")}</th>
                        <th className="px-2.5 py-2 text-right">
                          {t("subtask.colActions")}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {draftRows.map((row, idx) => {
                        const isActive = idx === activeRowIndex;
                        const willBecomeHuman = changedIndices.has(idx);
                        const color = colorForSubtask(
                          row.subtask,
                          taskSpec,
                          idx,
                        );
                        const prompt = taskSpec?.subtasks.find(
                          (s) => s.name === row.subtask,
                        )?.prompt;
                        const canSetStartHere =
                          idx > 0 &&
                          currentFrame > draftRows[idx - 1].start &&
                          currentFrame < row.end;
                        const canSetEndHere =
                          idx < draftRows.length - 1 &&
                          currentFrame > row.start &&
                          currentFrame < draftRows[idx + 1].end;
                        const inRowRange =
                          currentFrame >= row.start && currentFrame < row.end;

                        return (
                          <tr
                            key={idx}
                            className={
                              isActive
                                ? "bg-cyan-400/[0.08]"
                                : "hover:bg-white/[0.02]"
                            }
                          >
                            {/* Subtask */}
                            <td className="px-2.5 py-2 align-middle">
                              <div className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: color }}
                                />
                                {taskSpec ? (
                                  <select
                                    value={row.subtask}
                                    onChange={(e) =>
                                      updateRow(idx, {
                                        subtask: e.target.value,
                                      })
                                    }
                                    className="rounded border border-white/10 bg-[var(--surface-1)] px-2 py-1 text-xs font-medium text-slate-100 focus:border-cyan-400/50 focus:outline-none"
                                  >
                                    {!taskSpec.subtasks.some(
                                      (s) => s.name === row.subtask,
                                    ) && (
                                      <option value={row.subtask}>
                                        {row.subtask}
                                      </option>
                                    )}
                                    {taskSpec.subtasks.map((s) => (
                                      <option key={s.name} value={s.name}>
                                        {s.name}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type="text"
                                    value={row.subtask}
                                    onChange={(e) =>
                                      updateRow(idx, {
                                        subtask: e.target.value,
                                      })
                                    }
                                    className="w-32 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-slate-100 focus:border-cyan-400/50 focus:outline-none"
                                  />
                                )}
                              </div>
                              {prompt && (
                                <p
                                  className="mt-0.5 max-w-[220px] truncate text-[10px] text-slate-500"
                                  title={prompt}
                                >
                                  {prompt}
                                </p>
                              )}
                            </td>

                            {/* Start */}
                            <td className="px-2.5 py-2 align-middle">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={row.start}
                                  min={0}
                                  max={Math.max(0, episodeLength)}
                                  onChange={(e) => {
                                    const val = Number.parseInt(
                                      e.target.value,
                                      10,
                                    );
                                    if (Number.isInteger(val)) {
                                      handleSetStart(idx, val);
                                    }
                                  }}
                                  className="w-16 rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs tabular text-slate-100 focus:border-cyan-400/50 focus:outline-none"
                                  aria-label={`${row.subtask} start`}
                                />
                                <button
                                  type="button"
                                  onClick={() => seekToFrame(row.start)}
                                  title={t("subtask.seekTo", {
                                    frame: row.start,
                                  })}
                                  className="rounded border border-white/10 px-1.5 py-1 text-[10px] text-slate-400 hover:text-cyan-200 hover:border-cyan-400/40"
                                >
                                  ↗
                                </button>
                                {idx > 0 && (
                                  <button
                                    type="button"
                                    disabled={!canSetStartHere}
                                    onClick={() =>
                                      handleSetStart(idx, currentFrame)
                                    }
                                    title={t("subtask.setBoundaryTitle", {
                                      frame: currentFrame,
                                    })}
                                    className="rounded border border-cyan-400/30 bg-cyan-500/10 px-1.5 py-1 text-[10px] font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-35 disabled:cursor-not-allowed"
                                  >
                                    {t("subtask.setHere")}
                                  </button>
                                )}
                              </div>
                            </td>

                            {/* End */}
                            <td className="px-2.5 py-2 align-middle">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={row.end}
                                  min={1}
                                  max={Math.max(1, episodeLength)}
                                  onChange={(e) => {
                                    const val = Number.parseInt(
                                      e.target.value,
                                      10,
                                    );
                                    if (Number.isInteger(val)) {
                                      handleSetEnd(idx, val);
                                    }
                                  }}
                                  className="w-16 rounded border border-white/10 bg-black/30 px-1.5 py-1 text-xs tabular text-slate-100 focus:border-cyan-400/50 focus:outline-none"
                                  aria-label={`${row.subtask} end`}
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    seekToFrame(
                                      Math.min(
                                        Math.max(0, episodeLength - 1),
                                        row.end,
                                      ),
                                    )
                                  }
                                  title={t("subtask.seekTo", {
                                    frame: row.end,
                                  })}
                                  className="rounded border border-white/10 px-1.5 py-1 text-[10px] text-slate-400 hover:text-cyan-200 hover:border-cyan-400/40"
                                >
                                  ↗
                                </button>
                                {idx < draftRows.length - 1 && (
                                  <button
                                    type="button"
                                    disabled={!canSetEndHere}
                                    onClick={() =>
                                      handleSetEnd(idx, currentFrame)
                                    }
                                    title={t("subtask.setBoundaryTitle", {
                                      frame: currentFrame,
                                    })}
                                    className="rounded border border-cyan-400/30 bg-cyan-500/10 px-1.5 py-1 text-[10px] font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-35 disabled:cursor-not-allowed"
                                  >
                                    {t("subtask.setHere")}
                                  </button>
                                )}
                              </div>
                            </td>

                            {/* Contact */}
                            <td className="px-2.5 py-2 align-middle">
                              <div className="flex items-center gap-1">
                                {row.contact !== null ? (
                                  <button
                                    type="button"
                                    onClick={() => seekToFrame(row.contact!)}
                                    className="tabular font-mono text-amber-200 hover:underline"
                                  >
                                    {row.contact}
                                  </button>
                                ) : (
                                  <span className="text-slate-600">—</span>
                                )}
                                <button
                                  type="button"
                                  disabled={!inRowRange}
                                  onClick={() =>
                                    updateRow(idx, { contact: currentFrame })
                                  }
                                  title={t("subtask.setContactTitle", {
                                    frame: currentFrame,
                                  })}
                                  className="rounded border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-500/20 disabled:opacity-35 disabled:cursor-not-allowed"
                                >
                                  {t("subtask.setHere")}
                                </button>
                                {row.contact !== null && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateRow(idx, { contact: null })
                                    }
                                    title={t("common.clear")}
                                    className="rounded px-1 py-0.5 text-[10px] text-slate-400 hover:bg-white/10 hover:text-slate-100"
                                  >
                                    ×
                                  </button>
                                )}
                              </div>
                            </td>

                            {/* Grasp */}
                            <td className="px-2.5 py-2 align-middle">
                              <div className="flex items-center gap-1">
                                {row.grasp !== null ? (
                                  <button
                                    type="button"
                                    onClick={() => seekToFrame(row.grasp!)}
                                    className="tabular font-mono text-emerald-200 hover:underline"
                                  >
                                    {row.grasp}
                                  </button>
                                ) : (
                                  <span className="text-slate-600">—</span>
                                )}
                                <button
                                  type="button"
                                  disabled={!inRowRange}
                                  onClick={() =>
                                    updateRow(idx, { grasp: currentFrame })
                                  }
                                  title={t("subtask.setGraspTitle", {
                                    frame: currentFrame,
                                  })}
                                  className="rounded border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-35 disabled:cursor-not-allowed"
                                >
                                  {t("subtask.setHere")}
                                </button>
                                {row.grasp !== null && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateRow(idx, { grasp: null })
                                    }
                                    title={t("common.clear")}
                                    className="rounded px-1 py-0.5 text-[10px] text-slate-400 hover:bg-white/10 hover:text-slate-100"
                                  >
                                    ×
                                  </button>
                                )}
                              </div>
                            </td>

                            {/* Success */}
                            <td className="px-2.5 py-2 align-middle">
                              <button
                                type="button"
                                onClick={() =>
                                  updateRow(idx, { success: !row.success })
                                }
                                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                                  row.success
                                    ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                                    : "border-rose-400/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25"
                                }`}
                              >
                                {row.success
                                  ? t("subtask.successTrue")
                                  : t("subtask.successFalse")}
                              </button>
                            </td>

                            {/* Annotator */}
                            <td className="px-2.5 py-2 align-middle whitespace-nowrap">
                              <span
                                className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-mono ${
                                  ANNOTATOR_BADGE[
                                    resolvedDraftRows[idx].annotator
                                  ] ?? "border-white/10 text-slate-300"
                                }`}
                              >
                                {willBecomeHuman && row.annotator !== "human"
                                  ? `${row.annotator} → human`
                                  : resolvedDraftRows[idx].annotator}
                              </span>
                            </td>

                            {/* Note */}
                            <td className="px-2.5 py-2 align-middle">
                              <input
                                type="text"
                                value={row.note}
                                onChange={(e) =>
                                  updateRow(idx, { note: e.target.value })
                                }
                                placeholder={t("subtask.notePlaceholder")}
                                className="w-28 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none"
                              />
                            </td>

                            {/* Remove boundary */}
                            <td className="px-2.5 py-2 align-middle text-right">
                              {draftRows.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveRow(idx)}
                                  title={t("subtask.removeBoundaryTitle")}
                                  className="rounded border border-white/10 px-2 py-1 text-[10px] text-slate-400 hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200 transition-colors"
                                >
                                  {t("subtask.removeBoundary")}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Validation issues */}
              {issues.length > 0 && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-100">
                  <p className="font-semibold text-rose-200">
                    {tp("subtask.validationIssues", issues.length)}
                  </p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-rose-100/90">
                    {issues.map((issue, idx) => (
                      <li key={`${issue.rule}-${idx}`}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Footer action bar */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {draftRows.length > 0 && issues.length === 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] text-emerald-200">
                    {t("subtask.valid")}
                  </span>
                )}

                {saveMessage && (
                  <span
                    className={`text-xs ${
                      saveMessage.kind === "ok"
                        ? "text-emerald-300"
                        : "text-rose-300"
                    }`}
                  >
                    {saveMessage.text}
                  </span>
                )}

                <div className="ml-auto flex items-center gap-2">
                  {isDirty && (
                    <button
                      type="button"
                      onClick={handleRevert}
                      className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:border-white/20 transition-colors"
                    >
                      {t("subtask.revert")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!canSave}
                    onClick={() => void handleSave()}
                    className="rounded-md bg-cyan-500/90 px-3.5 py-1.5 text-xs font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? t("tags.saving") : t("subtask.save")}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
