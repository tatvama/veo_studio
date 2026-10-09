import { ArrowUpRight, Cpu, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import { Button, Meter, Panel, Skeleton, StatusDot, Tag } from "../ui";

/** One row per AI provider: live key, placeholder mode, or not set up. */
export function Engines({ index, className }: { index?: number; className?: string }) {
  const t = useT();
  const q = useSettings();
  // keys that run no generation themselves (the BytePlus asset library) are not engines
  const list = (q.data?.providers ?? []).filter((p) => p.engine !== false);
  const live = list.filter((p) => p.mode === "live").length;
  const allMock = list.length > 0 && live === 0;

  return (
    <Panel index={index} className={className} flush tone={allMock ? "warn" : undefined}
      eyebrow={t("Engines")} icon={<Cpu />}
      actions={list.length ? <Tag k={t("live")} tone={live ? "ok" : "warn"}>{live}/{list.length}</Tag> : undefined}>
      <div className="pt-2.5">
        {q.isLoading ? (
          <div aria-busy="true" className="space-y-2.5 px-4 pb-4 pt-1">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-4 w-full" />)}
          </div>
        ) : q.isError || !list.length ? (
          <div className="flex items-center justify-between gap-3 px-4 pb-4 pt-1 text-sm text-mute">
            <span>{t("Couldn't load the engines")}</span>
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>{t("Try again")}</Button>
          </div>
        ) : (
          <>
            <ul className="border-t border-line">
              {list.map((p) => {
                const tone = p.mode === "live" ? "ok" : p.mode === "mock" ? "warn" : "neutral";
                return (
                  <li key={p.provider} className="flex items-center gap-2.5 border-b border-line px-4 py-2 last:border-b-0">
                    <StatusDot tone={tone} live={p.mode === "live"} />
                    <span className="min-w-0 flex-1 truncate text-sm">{p.label.split(" (")[0]}</span>
                    <span className={`mono shrink-0 text-2xs uppercase tracking-wider ${p.mode === "live" ? "text-ok" : p.mode === "mock" ? "text-warn" : "text-dim"}`}>
                      {p.mode === "live" ? t("live") : p.mode === "mock" ? t("placeholder") : t("no key")}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="space-y-2.5 border-t border-line px-4 py-3">
              <Meter filled={live} total={list.length} tone={allMock ? "warn" : "ok"} />
              {allMock && (
                <p className="flex items-start gap-2 text-2xs leading-relaxed text-mute">
                  <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
                  {t("Running on free placeholder media until a key is added.")}
                </p>
              )}
              <Link to="/settings" className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink transition-colors hover:text-ink">
                {allMock ? t("Add keys in Settings") : t("Settings")}<ArrowUpRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
