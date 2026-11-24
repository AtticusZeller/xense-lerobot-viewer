import React from "react";
import { useTime } from "../context/time-context";
import { useT } from "@/context/locale-context";
import {
  FaPlay,
  FaPause,
  FaBackward,
  FaForward,
  FaUndoAlt,
  FaArrowDown,
  FaArrowUp,
  FaStepBackward,
  FaStepForward,
} from "react-icons/fa";
import type {
  SubtaskAnnotationRow,
  TaskSpec,
} from "@/types/subtask-annotation.types";
import {
  colorForSubtask,
  frameToTime,
  timeToFrame,
} from "@/utils/subtaskEditor";

interface PlaybackBarProps {
  fps?: number;
  episodeLength?: number;
  subtaskRows?: readonly SubtaskAnnotationRow[];
  taskSpec?: TaskSpec | null;
}

const PlaybackBar: React.FC<PlaybackBarProps> = ({
  fps,
  episodeLength,
  subtaskRows,
  taskSpec = null,
}) => {
  const t = useT();
  const { duration, isPlaying, setIsPlaying, currentTime, seek } = useTime();

  const sliderActiveRef = React.useRef(false);
  const wasPlayingRef = React.useRef(false);
  const sliderValueRef = React.useRef(currentTime);
  const [sliderValue, setSliderValue] = React.useState(currentTime);

  React.useEffect(() => {
    if (!sliderActiveRef.current) {
      sliderValueRef.current = currentTime;
      setSliderValue(currentTime);
    }
  }, [currentTime]);

  const effectiveLength =
    episodeLength && episodeLength > 0
      ? episodeLength
      : fps && fps > 0 && duration > 0
        ? Math.max(1, Math.round(duration * fps))
        : 0;
  const hasFrameControl = Boolean(fps && fps > 0 && effectiveLength > 0);
  const currentFrame = hasFrameControl
    ? timeToFrame(sliderValue, fps!, effectiveLength)
    : 0;

  const seekToFrame = (frame: number) => {
    if (!hasFrameControl || !fps) return;
    const clamped = Math.max(0, Math.min(effectiveLength - 1, frame));
    const targetTime = frameToTime(clamped, fps);
    setIsPlaying(false);
    sliderValueRef.current = targetTime;
    setSliderValue(targetTime);
    seek(targetTime, "external");
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    sliderValueRef.current = next;
    setSliderValue(next);
    seek(next);
  };

  const handleSliderMouseDown = () => {
    sliderActiveRef.current = true;
    wasPlayingRef.current = isPlaying;
    setIsPlaying(false);
  };

  const handleSliderMouseUp = () => {
    sliderActiveRef.current = false;
    seek(sliderValueRef.current);
    if (wasPlayingRef.current) {
      setIsPlaying(true);
    }
  };

  const hasSubtasks = Boolean(
    subtaskRows && subtaskRows.length > 0 && effectiveLength > 0,
  );

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!hasFrameControl) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    seekToFrame(Math.round(ratio * Math.max(0, effectiveLength - 1)));
  };

  return (
    <div className="sticky bottom-0 z-20 mt-auto w-full max-w-5xl mx-auto flex items-center gap-2 md:gap-3 panel-raised bg-[var(--surface-0)]/95 backdrop-blur px-3 py-2">
      <button
        title={t("player.back5")}
        onClick={() => seek(Math.max(0, currentTime - 5))}
        className="hidden md:flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
      >
        <FaBackward size={13} />
      </button>
      {hasFrameControl && (
        <button
          title={t("subtask.prevFrame")}
          onClick={() => seekToFrame(currentFrame - 1)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
        >
          <FaStepBackward size={12} />
        </button>
      )}
      <button
        className="flex h-9 w-9 items-center justify-center rounded-md bg-cyan-400/10 border border-cyan-400/30 text-cyan-300 hover:bg-cyan-400/15 transition-colors"
        title={isPlaying ? t("player.pause") : t("player.play")}
        onClick={() => setIsPlaying(!isPlaying)}
      >
        {isPlaying ? <FaPause size={14} /> : <FaPlay size={14} />}
      </button>
      {hasFrameControl && (
        <button
          title={t("subtask.nextFrame")}
          onClick={() => seekToFrame(currentFrame + 1)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
        >
          <FaStepForward size={12} />
        </button>
      )}
      <button
        title={t("player.forward5")}
        onClick={() => seek(Math.min(duration, currentTime + 5))}
        className="hidden md:flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
      >
        <FaForward size={13} />
      </button>
      <button
        title={t("player.rewind")}
        onClick={() => seek(0)}
        className="hidden md:flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
      >
        <FaUndoAlt size={13} />
      </button>

      <div className="flex-1 mx-1 flex flex-col gap-1.5 min-w-0">
        {hasSubtasks && subtaskRows && (
          <div
            onClick={handleTimelineClick}
            className="relative h-4 w-full rounded bg-white/5 border border-white/10 overflow-visible cursor-pointer select-none"
            title={t("subtask.timelineClickHint")}
          >
            {subtaskRows.map((row, idx) => {
              const leftPct = (100 * Math.max(0, row.start)) / effectiveLength;
              const widthPct =
                (100 * Math.max(0, row.end - row.start)) / effectiveLength;
              const color = colorForSubtask(row.subtask, taskSpec, idx);
              return (
                <div
                  key={`${row.subtask}-${idx}`}
                  className="absolute top-0 bottom-0 flex items-center justify-center overflow-hidden border-r border-black/40 first:rounded-l last:rounded-r last:border-r-0"
                  style={{
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    backgroundColor: color,
                    opacity: row.success ? 0.78 : 0.35,
                  }}
                  title={`${row.subtask} [${row.start}, ${row.end})`}
                >
                  {widthPct >= 10 && (
                    <span className="truncate px-1 text-[10px] font-semibold text-slate-950/90 drop-shadow-[0_1px_0_rgba(255,255,255,0.25)]">
                      {row.subtask}
                    </span>
                  )}
                </div>
              );
            })}

            {subtaskRows.map((row, idx) => (
              <React.Fragment key={`markers-${idx}`}>
                {row.contact !== null && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      seekToFrame(row.contact!);
                    }}
                    title={t("subtask.markerContact", {
                      subtask: row.subtask,
                      frame: row.contact,
                    })}
                    className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-2.5 w-2.5 rotate-45 border border-slate-950 bg-amber-300 shadow hover:scale-125 transition-transform"
                    style={{
                      left: `${(100 * row.contact) / effectiveLength}%`,
                    }}
                    aria-label={t("subtask.markerContact", {
                      subtask: row.subtask,
                      frame: row.contact,
                    })}
                  />
                )}
                {row.grasp !== null && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      seekToFrame(row.grasp!);
                    }}
                    title={t("subtask.markerGrasp", {
                      subtask: row.subtask,
                      frame: row.grasp,
                    })}
                    className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full border border-slate-950 bg-emerald-300 shadow hover:scale-125 transition-transform"
                    style={{
                      left: `${(100 * row.grasp) / effectiveLength}%`,
                    }}
                    aria-label={t("subtask.markerGrasp", {
                      subtask: row.subtask,
                      frame: row.grasp,
                    })}
                  />
                )}
              </React.Fragment>
            ))}

            <span
              className="pointer-events-none absolute -top-0.5 -bottom-0.5 w-0.5 bg-white shadow"
              style={{
                left: `${(100 * Math.min(currentFrame, effectiveLength)) / effectiveLength}%`,
              }}
            />
          </div>
        )}
        <input
          type="range"
          min={0}
          max={duration}
          step={fps && fps > 0 ? Number((1 / fps).toFixed(4)) : 0.01}
          value={sliderValue}
          onChange={handleSliderChange}
          onMouseDown={handleSliderMouseDown}
          onMouseUp={handleSliderMouseUp}
          onTouchStart={handleSliderMouseDown}
          onTouchEnd={handleSliderMouseUp}
          className="w-full h-1 accent-cyan-400 cursor-pointer focus:outline-none focus:ring-0"
          aria-label={t("player.seekAria")}
        />
      </div>

      <span className="text-right tabular text-[11px] text-slate-400 shrink-0">
        {hasFrameControl
          ? `f ${currentFrame}/${effectiveLength} · ${sliderValue.toFixed(1)}s`
          : `${Math.floor(sliderValue)} / ${Math.floor(duration)}`}
      </span>

      <div className="hidden lg:flex flex-col gap-y-0.5 ml-2 text-[10px] text-slate-500 select-none">
        <p className="inline-flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-slate-300 text-[10px]">
            Space
          </kbd>
          <span>{t("player.hintSpace")}</span>
        </p>
        <p className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-0.5 text-slate-300">
            <FaArrowUp size={10} />
            <FaArrowDown size={10} />
          </span>
          <span>{t("player.hintArrows")}</span>
        </p>
      </div>
    </div>
  );
};

export default PlaybackBar;
