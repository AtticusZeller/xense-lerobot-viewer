"use client";

import { useT } from "@/context/locale-context";
import type {
  CollectionPlan,
  CollectionPlanRound,
} from "@/types/collection.types";

export default function CollectionPlanRounds({
  plan,
  selected,
  busy,
  colorOf,
  onSelect,
  onReplace,
  onDelete,
}: {
  plan: CollectionPlan | null;
  selected: CollectionPlanRound | null;
  busy: boolean;
  colorOf: (name: string) => string;
  onSelect: (id: number) => void;
  onReplace: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const t = useT();
  const rounds = plan?.rounds ?? [];
  const counts = { pending: 0, collected: 0, skipped: 0 };
  for (const round of rounds) counts[round.status] += 1;
  return (
    <section
      className="panel flex flex-col gap-3 p-3.5 text-xs"
      aria-label={t("collect.plan.rounds")}
    >
      <h3 className="font-semibold text-slate-100">
        {t("collect.plan.rounds")}
      </h3>
      {rounds.length === 0 ? (
        <p className="text-slate-400">{t("collect.plan.empty")}</p>
      ) : (
        <>
          <p role="status" className="tabular text-slate-300">
            {t("collect.plan.progress", { ...counts, total: rounds.length })}
          </p>
          <progress
            className="h-1.5 w-full accent-emerald-400"
            max={rounds.length}
            value={counts.collected}
            aria-label={t("collect.plan.collected")}
          />
          <ol className="max-h-[30vh] space-y-1 overflow-y-auto pr-1">
            {rounds.map((round) => (
              <li key={round.id}>
                <button
                  type="button"
                  aria-pressed={round.id === selected?.id}
                  onClick={() => onSelect(round.id)}
                  className={`w-full rounded border px-2 py-1.5 text-left ${round.id === selected?.id ? "border-cyan-400/60 bg-cyan-500/15" : "border-white/10 hover:border-cyan-400/40"}`}
                >
                  <span className="flex justify-between gap-2">
                    <span className="font-semibold text-slate-100">
                      {t("collect.plan.round", { id: round.id })}
                    </span>
                    <span
                      className={
                        round.status === "collected"
                          ? "text-emerald-300"
                          : "text-slate-300"
                      }
                    >
                      {t(`collect.plan.${round.status}`)}
                      {round.episode_index !== null
                        ? ` · episode_${round.episode_index}`
                        : ""}
                    </span>
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {round.targets.map(({ object }) => object).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {selected && (
        <div className="space-y-2 border-t border-white/10 pt-2.5">
          <ul className="space-y-1 text-[11px] text-slate-300">
            {selected.targets.map((target, index) => (
              <li key={target.object}>
                <span
                  className="font-mono font-semibold"
                  style={{ color: colorOf(target.object) }}
                >
                  {index + 1}. {target.object}
                </span>
                <span className="ml-2 font-mono">
                  {target.x_m.toFixed(3)}, {target.y_m.toFixed(3)} m ·{" "}
                  {target.yaw_deg.toFixed(0)}°
                </span>
                {target.reason && (
                  <p className="text-amber-200">{target.reason}</p>
                )}
              </li>
            ))}
          </ul>
          {selected.status === "pending" && (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => onReplace(selected.id)}
                className="rounded border border-cyan-400/40 px-2.5 py-1 text-cyan-100 disabled:opacity-50"
              >
                {t("collect.plan.replace")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(selected.id)}
                className="rounded border border-rose-400/40 px-2.5 py-1 text-rose-200 disabled:opacity-50"
              >
                {t("collect.plan.delete")}
              </button>
            </div>
          )}
        </div>
      )}
      {plan &&
        Object.entries(plan.excluded_objects).map(([object, reason]) => (
          <p key={object} className="text-amber-200">
            {t("collect.plan.excluded", { object, reason })}
          </p>
        ))}
    </section>
  );
}
