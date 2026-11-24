"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "@/context/locale-context";
import type {
  CalibrationEpisodeMediaPayload,
  CalibrationHeadFile,
} from "@/types/calibration.types";
import {
  hasNonZeroDistortion,
  projectTcpToPixel,
  type ProjectedPixel,
} from "@/utils/calibrationMath";
import { frameToTime, timeToFrame } from "@/utils/subtaskEditor";
import {
  episodeTimeFromMediaTime,
  mediaTimeFromEpisodeTime,
} from "@/utils/videoSegments";
import {
  blocksAllShortcuts,
  describeShortcutTarget,
} from "@/utils/viewerShortcuts";

interface CalibrationOverlayPlayerProps {
  encodedPath: string;
  head: CalibrationHeadFile;
  totalEpisodes: number;
  initialEpisode: number;
}

const ARM_COLORS: Record<string, string> = {
  left: "#38bdf8", // sky-400
  right: "#fb7185", // rose-400
};
const FALLBACK_COLORS = ["#34d399", "#fbbf24", "#a78bfa", "#2dd4bf"];
const PLAYBACK_RATES = [0.25, 0.5, 1] as const;
const TRAIL_FRAMES = 15;

function colorForArm(arm: string, index: number): string {
  return ARM_COLORS[arm] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export function CalibrationOverlayPlayer({
  encodedPath,
  head,
  totalEpisodes,
  initialEpisode,
}: CalibrationOverlayPlayerProps) {
  const t = useT();
  const [episodeId, setEpisodeId] = useState(() =>
    Math.max(0, Math.min(Math.max(0, totalEpisodes - 1), initialEpisode)),
  );
  const [episodeInput, setEpisodeInput] = useState(String(episodeId));
  const [media, setMedia] = useState<CalibrationEpisodeMediaPayload | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] =
    useState<(typeof PLAYBACK_RATES)[number]>(0.5);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [showTrail, setShowTrail] = useState(true);
  const [visibleArms, setVisibleArms] = useState<Record<string, boolean>>({});

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const distortionWarning = hasNonZeroDistortion(head.intrinsics);

  const participatingArms = useMemo(() => {
    const calibrated = Object.keys(head.arms);
    if (!media?.armsTcp) return calibrated;
    return calibrated.filter((arm) => Boolean(media.armsTcp?.[arm]));
  }, [head.arms, media]);

  useEffect(() => {
    setVisibleArms((prev) => {
      const next: Record<string, boolean> = {};
      for (const arm of participatingArms) {
        next[arm] = prev[arm] ?? true;
      }
      return next;
    });
  }, [participatingArms]);

  useEffect(() => {
    setEpisodeInput(String(episodeId));
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIsPlaying(false);
    setCurrentFrame(0);

    const params = new URLSearchParams({
      episode: String(episodeId),
      camera: head.camera,
      includeTcp: "1",
    });
    fetch(`/api/local-datasets/${encodedPath}/calibration/episode?${params}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(
            String((body as { error?: string }).error ?? `HTTP ${res.status}`),
          );
          setMedia(null);
          return;
        }
        setMedia(body as CalibrationEpisodeMediaPayload);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setMedia(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [encodedPath, episodeId, head.camera]);

  const drawOverlayForFrame = useCallback(
    (frameIdx: number) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas || !media) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const [imgWidth, imgHeight] = head.image_size;
      if (canvas.width !== imgWidth || canvas.height !== imgHeight) {
        canvas.width = imgWidth;
        canvas.height = imgHeight;
      }
      ctx.clearRect(0, 0, imgWidth, imgHeight);

      if (!media.armsTcp) return;

      participatingArms.forEach((arm, armIdx) => {
        if (visibleArms[arm] === false) return;
        const armCalib = head.arms[arm];
        const series = media.armsTcp?.[arm];
        if (!armCalib || !series || series.length === 0) return;

        const color = colorForArm(arm, armIdx);

        if (showTrail) {
          const start = Math.max(0, frameIdx - TRAIL_FRAMES);
          ctx.save();
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.65;
          ctx.lineWidth = 2;
          ctx.beginPath();
          let started = false;
          for (let f = start; f <= frameIdx && f < series.length; f += 1) {
            const tcp = series[f];
            if (!tcp) {
              started = false;
              continue;
            }
            const proj = projectTcpToPixel(tcp, armCalib, head.intrinsics);
            if (!proj) {
              started = false;
              continue;
            }
            if (!started) {
              ctx.moveTo(proj.u, proj.v);
              started = true;
            } else {
              ctx.lineTo(proj.u, proj.v);
            }
          }
          ctx.stroke();
          ctx.restore();
        }

        const tcp = series[Math.min(frameIdx, series.length - 1)];
        if (!tcp) return;
        const proj = projectTcpToPixel(tcp, armCalib, head.intrinsics);
        if (!proj) return;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(proj.u, proj.v, 8, 0, Math.PI * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(proj.u - 13, proj.v);
        ctx.lineTo(proj.u - 3, proj.v);
        ctx.moveTo(proj.u + 3, proj.v);
        ctx.lineTo(proj.u + 13, proj.v);
        ctx.moveTo(proj.u, proj.v - 13);
        ctx.lineTo(proj.u, proj.v - 3);
        ctx.moveTo(proj.u, proj.v + 3);
        ctx.lineTo(proj.u, proj.v + 13);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(proj.u, proj.v, 2.2, 0, Math.PI * 2);
        ctx.fill();

        const label = `${arm} (${proj.u.toFixed(0)}, ${proj.v.toFixed(0)})`;
        ctx.font = "bold 11px monospace";
        const textW = ctx.measureText(label).width;
        const boxX = Math.max(4, Math.min(proj.u + 12, imgWidth - textW - 10));
        const boxY = Math.max(16, Math.min(proj.v - 10, imgHeight - 8));
        ctx.fillStyle = "rgba(2, 6, 23, 0.78)";
        ctx.fillRect(boxX - 3, boxY - 11, textW + 6, 14);
        ctx.fillStyle = color;
        ctx.fillText(label, boxX, boxY);
        ctx.restore();
      });
    },
    [
      head.arms,
      head.image_size,
      head.intrinsics,
      media,
      participatingArms,
      showTrail,
      visibleArms,
    ],
  );

  // Sync playback rate.
  useEffect(() => {
    const el = videoRef.current;
    if (el) {
      el.playbackRate = playbackRate;
    }
  }, [playbackRate, media]);

  // Seek video to segmentStart on media load.
  useEffect(() => {
    const el = videoRef.current;
    const videoInfo = media?.video;
    if (!el || !videoInfo) return;

    const seekStart = () => {
      el.pause();
      el.playbackRate = playbackRate;
      el.currentTime = mediaTimeFromEpisodeTime(
        videoInfo,
        frameToTime(0, media.fps),
      );
      setCurrentFrame(0);
      drawOverlayForFrame(0);
    };

    const handleSeeked = () => {
      const localTime = episodeTimeFromMediaTime(videoInfo, el.currentTime);
      const frame = timeToFrame(localTime, media.fps, media.episodeLength);
      setCurrentFrame(frame);
      drawOverlayForFrame(frame);
    };

    el.addEventListener("loadeddata", seekStart);
    el.addEventListener("seeked", handleSeeked);
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      seekStart();
    }
    return () => {
      el.removeEventListener("loadeddata", seekStart);
      el.removeEventListener("seeked", handleSeeked);
    };
  }, [drawOverlayForFrame, media, playbackRate]);

  // Redraw overlay immediately when toggles or currentFrame change while paused.
  useEffect(() => {
    drawOverlayForFrame(currentFrame);
  }, [currentFrame, drawOverlayForFrame]);

  // Drive smooth frame-by-frame overlay updates during playback.
  useEffect(() => {
    if (!isPlaying || !media?.video) return;
    const el = videoRef.current;
    const videoInfo = media.video;
    if (!el) return;

    let cancelled = false;
    let rafId = 0;

    const step = () => {
      if (cancelled) return;
      if (videoInfo.isSegmented && videoInfo.segmentEnd !== undefined) {
        if (el.currentTime >= videoInfo.segmentEnd - 0.04) {
          el.currentTime = mediaTimeFromEpisodeTime(
            videoInfo,
            frameToTime(0, media.fps),
          );
        }
      }
      const localTime = episodeTimeFromMediaTime(videoInfo, el.currentTime);
      const frame = timeToFrame(localTime, media.fps, media.episodeLength);
      setCurrentFrame(frame);
      drawOverlayForFrame(frame);
      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [drawOverlayForFrame, isPlaying, media]);

  const seekToFrame = useCallback(
    (nextFrame: number) => {
      const el = videoRef.current;
      if (!el || !media?.video) return;
      const clamped = Math.max(
        0,
        Math.min(Math.max(0, media.episodeLength - 1), nextFrame),
      );
      el.currentTime = mediaTimeFromEpisodeTime(
        media.video,
        frameToTime(clamped, media.fps),
      );
      setCurrentFrame(clamped);
      drawOverlayForFrame(clamped);
    },
    [drawOverlayForFrame, media],
  );

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el || !media?.video) return;
    if (isPlaying) {
      el.pause();
      setIsPlaying(false);
    } else {
      if (
        media.video.isSegmented &&
        media.video.segmentStart !== undefined &&
        media.video.segmentEnd !== undefined &&
        (el.currentTime < media.video.segmentStart ||
          el.currentTime >= media.video.segmentEnd - 0.04)
      ) {
        el.currentTime = media.video.segmentStart;
      }
      el.playbackRate = playbackRate;
      void el.play().then(
        () => setIsPlaying(true),
        () => setIsPlaying(false),
      );
    }
  }, [isPlaying, media, playbackRate]);

  // Space / Left / Right shortcuts in overlay mode.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (blocksAllShortcuts(describeShortcutTarget(e.target))) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (isPlaying) {
          videoRef.current?.pause();
          setIsPlaying(false);
        }
        seekToFrame(currentFrame - (e.shiftKey ? 10 : 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (isPlaying) {
          videoRef.current?.pause();
          setIsPlaying(false);
        }
        seekToFrame(currentFrame + (e.shiftKey ? 10 : 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentFrame, isPlaying, seekToFrame, togglePlay]);

  const liveProjections = useMemo(() => {
    const out: Array<{
      arm: string;
      color: string;
      proj: ProjectedPixel | null;
    }> = [];
    if (!media?.armsTcp) return out;
    participatingArms.forEach((arm, idx) => {
      const series = media.armsTcp?.[arm];
      const tcp = series?.[Math.min(currentFrame, (series?.length ?? 1) - 1)];
      const proj =
        tcp && head.arms[arm]
          ? projectTcpToPixel(tcp, head.arms[arm], head.intrinsics)
          : null;
      out.push({ arm, color: colorForArm(arm, idx), proj });
    });
    return out;
  }, [currentFrame, head.arms, head.intrinsics, media, participatingArms]);

  const handleEpisodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number.parseInt(episodeInput, 10);
    if (
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed < Math.max(1, totalEpisodes)
    ) {
      setEpisodeId(parsed);
    }
  };

  const [imgWidth, imgHeight] = head.image_size;

  return (
    <div className="flex flex-col gap-3">
      {distortionWarning && (
        <div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {t("calib.distortionWarning")}
        </div>
      )}

      {/* Episode picker and arm toggles */}
      <div className="panel flex flex-wrap items-center gap-3 px-4 py-2.5 text-xs">
        <form
          onSubmit={handleEpisodeSubmit}
          className="flex items-center gap-1.5"
        >
          <span className="text-slate-400">{t("calib.overlayEpisode")}</span>
          <button
            type="button"
            disabled={episodeId <= 0}
            onClick={() => setEpisodeId((id) => Math.max(0, id - 1))}
            className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-slate-200 disabled:opacity-40 hover:border-cyan-400/40"
          >
            ←
          </button>
          <input
            type="number"
            min={0}
            max={Math.max(0, totalEpisodes - 1)}
            value={episodeInput}
            onChange={(e) => setEpisodeInput(e.target.value)}
            className="w-16 rounded border border-white/10 bg-black/40 px-2 py-1 text-center font-mono text-slate-100"
          />
          <button
            type="submit"
            className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-slate-200 hover:border-cyan-400/40"
          >
            {t("subtask.jump")}
          </button>
          <button
            type="button"
            disabled={episodeId >= totalEpisodes - 1}
            onClick={() =>
              setEpisodeId((id) => Math.min(totalEpisodes - 1, id + 1))
            }
            className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-slate-200 disabled:opacity-40 hover:border-cyan-400/40"
          >
            →
          </button>
          <span className="text-slate-500 font-mono">
            / {Math.max(0, totalEpisodes - 1)}
          </span>
        </form>

        <div className="flex flex-wrap items-center gap-3 ml-auto">
          {participatingArms.map((arm, idx) => (
            <label
              key={arm}
              className="inline-flex cursor-pointer items-center gap-1.5"
            >
              <input
                type="checkbox"
                checked={visibleArms[arm] !== false}
                onChange={(e) =>
                  setVisibleArms((prev) => ({
                    ...prev,
                    [arm]: e.target.checked,
                  }))
                }
                className="accent-cyan-400"
              />
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: colorForArm(arm, idx) }}
              />
              <span className="font-mono text-slate-200">{arm}</span>
            </label>
          ))}
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-300">
            <input
              type="checkbox"
              checked={showTrail}
              onChange={(e) => setShowTrail(e.target.checked)}
              className="accent-cyan-400"
            />
            {t("calib.showTrail")}
          </label>
        </div>
      </div>

      {/* Video + projected TCP canvas */}
      <div className="mx-auto w-full max-w-4xl">
        <div
          className="relative overflow-hidden rounded-lg border border-white/10 bg-slate-950"
          style={{ aspectRatio: `${imgWidth} / ${imgHeight}` }}
        >
          {media?.video && (
            <video
              key={media.video.url}
              ref={videoRef}
              src={media.video.url}
              muted
              playsInline
              loop={!media.video.isSegmented}
              onEnded={() => setIsPlaying(false)}
              className="block h-full w-full object-fill"
            />
          )}
          <canvas
            ref={overlayCanvasRef}
            width={imgWidth}
            height={imgHeight}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 text-xs text-slate-300">
              {t("calib.overlayLoading")}
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 p-4 text-xs text-rose-300">
              {error}
            </div>
          )}
          {!loading && !error && !media?.video && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 p-4 text-xs text-amber-300">
              {t("calib.overlayNoVideo", { camera: head.camera })}
            </div>
          )}
        </div>

        {/* Transport controls */}
        <div className="mt-2.5 panel flex flex-col gap-2 px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!media?.video}
              onClick={togglePlay}
              className="rounded-md border border-cyan-400/40 bg-cyan-500/15 px-3 py-1 font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              {isPlaying ? t("calib.pause") : t("calib.play")}
            </button>
            <button
              type="button"
              disabled={!media?.video || currentFrame <= 0}
              onClick={() => {
                videoRef.current?.pause();
                setIsPlaying(false);
                seekToFrame(currentFrame - 1);
              }}
              className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-slate-200 disabled:opacity-40 hover:border-cyan-400/40"
            >
              -1
            </button>
            <button
              type="button"
              disabled={
                !media?.video || currentFrame >= (media?.episodeLength ?? 1) - 1
              }
              onClick={() => {
                videoRef.current?.pause();
                setIsPlaying(false);
                seekToFrame(currentFrame + 1);
              }}
              className="rounded border border-white/10 bg-[var(--surface-1)]/60 px-2 py-1 text-slate-200 disabled:opacity-40 hover:border-cyan-400/40"
            >
              +1
            </button>

            <span className="font-mono text-slate-300 tabular">
              frame {currentFrame} /{" "}
              {Math.max(0, (media?.episodeLength ?? 1) - 1)}
            </span>

            <div className="ml-auto flex items-center gap-1">
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => setPlaybackRate(rate)}
                  className={`rounded border px-2 py-0.5 font-mono transition-colors ${
                    playbackRate === rate
                      ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                      : "border-white/10 bg-[var(--surface-1)]/60 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>
          </div>

          <input
            type="range"
            min={0}
            max={Math.max(0, (media?.episodeLength ?? 1) - 1)}
            value={currentFrame}
            disabled={!media?.video}
            onChange={(e) => {
              if (isPlaying) {
                videoRef.current?.pause();
                setIsPlaying(false);
              }
              seekToFrame(Number(e.target.value));
            }}
            className="w-full accent-cyan-400"
          />

          <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-400">
            {liveProjections.map(({ arm, color, proj }) => (
              <span key={arm} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-slate-200">{arm}:</span>
                {proj ? (
                  <span>
                    u={proj.u.toFixed(1)}, v={proj.v.toFixed(1)}, z=
                    {proj.depth.toFixed(3)}m
                  </span>
                ) : (
                  <span className="text-slate-500">
                    {t("calib.behindCamera")}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
