"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useT } from "@/context/locale-context";
import type { DistributionReportStatus } from "@/types/subtask-annotation.types";
import { formatBytes } from "@/utils/byteSize";
import { copyTextToClipboard } from "@/utils/clipboard";

interface DistributionPanelProps {
  encodedPath: string | null;
  datasetName: string;
}

export default function DistributionPanel({
  encodedPath,
  datasetName,
}: DistributionPanelProps) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DistributionReportStatus | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(() => {
    if (!encodedPath) {
      setLoading(false);
      setStatus(null);
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
          setStatus(null);
          return;
        }
        setStatus(body as DistributionReportStatus);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [encodedPath]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus, refreshNonce]);

  const handleCopyCommand = async () => {
    if (!status) return;
    const ok = await copyTextToClipboard(status.suggestedCommand);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  if (loading) {
    return (
      <div className="panel p-6 text-sm text-slate-400">
        {t("dist.loading")}
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="panel border-rose-500/40 p-6 text-sm text-rose-200">
        {error ?? t("dist.loadError")}
      </div>
    );
  }

  if (!status.exists) {
    return (
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-4 py-6">
        <div className="panel-raised space-y-4 p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-100">
              {t("dist.missingTitle")}
            </h2>
            <span className="font-mono text-xs text-slate-500">
              {status.repoId}@{status.revision.slice(0, 8)}
            </span>
          </div>
          <p className="text-sm text-slate-300">{t("dist.missingDesc")}</p>
          <div className="rounded-md border border-white/10 bg-black/30 p-3 text-xs">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
              {t("dist.expectedPath")}
            </p>
            <p className="break-all font-mono text-slate-300">
              {status.reportPath}
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-slate-300">
                {t("dist.runCommand")}
              </p>
              <button
                type="button"
                onClick={() => void handleCopyCommand()}
                className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-xs text-slate-200 hover:border-cyan-400/40 hover:text-cyan-100 transition-colors"
              >
                {copied ? t("dist.copied") : t("common.copy")}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-md border border-cyan-400/20 bg-black/50 p-3 font-mono text-xs text-cyan-200">
              {status.suggestedCommand}
            </pre>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setRefreshNonce((n) => n + 1)}
              className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400/40 hover:text-cyan-100 transition-colors"
            >
              {t("dist.refresh")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const reportSrc = `${status.reportUrl}?v=${status.mtimeMs ?? refreshNonce}`;
  const updatedText = status.mtimeMs
    ? new Date(status.mtimeMs).toLocaleString()
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 panel px-4 py-2.5 text-xs">
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold text-slate-100"
            title={datasetName}
          >
            {t("dist.title")} · {status.repoId}
          </p>
          <p
            className="truncate font-mono text-[11px] text-slate-500"
            title={status.reportPath}
          >
            {status.reportPath}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-slate-400">
          {status.sizeBytes !== null && (
            <span className="tabular">{formatBytes(status.sizeBytes)}</span>
          )}
          {updatedText && (
            <span className="hidden md:inline text-slate-500">
              {updatedText}
            </span>
          )}
          <button
            type="button"
            onClick={() => setRefreshNonce((n) => n + 1)}
            className="rounded-md border border-white/10 bg-[var(--surface-1)]/60 px-2.5 py-1 text-xs text-slate-200 hover:border-cyan-400/40 hover:text-cyan-100 transition-colors"
          >
            {t("dist.refresh")}
          </button>
          <a
            href={reportSrc}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 transition-colors"
          >
            {t("dist.openNewTab")}
          </a>
        </div>
      </div>

      <iframe
        key={reportSrc}
        src={reportSrc}
        title={`${t("dist.title")} - ${status.repoId}`}
        sandbox="allow-scripts allow-downloads"
        className="min-h-[75vh] w-full flex-1 rounded-lg border border-white/10 bg-white"
      />
    </div>
  );
}
