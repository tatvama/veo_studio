import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye, RotateCcw, Settings2, ShieldAlert, UserRound } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useGenerate } from "../../../components/Generate";
import { Alert, Badge, Button, Menu, Skeleton, Tooltip } from "../../../components/ui";
import { api } from "../../../lib/api";
import { usd } from "../../../lib/format";
import { tr, useT } from "../../../lib/i18n";
import { useCharacters, useShotAlternatives } from "../../../lib/queries";
import type { Shot, ShotOption, SubmitResult } from "../../../lib/types";
import { useProjectCtx } from "../context";

const LINK = "font-medium text-accent-ink hover:underline";

/** "Veo 3.1", "Veo 3.1 and Kling 2.1", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${tr("and")} ${names[names.length - 1]}`;
}

/** A translated sentence with React nodes (links) in its {slots}. */
function fill(text: string, slots: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={i}>{key && key in slots ? slots[key] : part}</Fragment>;
  });
}

/** The shot's other engines; re-priced when what the price depends on (length, quality, cast) is saved. */
function useAlternatives(shot: Shot, purpose: "recover" | "draft", enabled: boolean) {
  const qc = useQueryClient();
  const q = useShotAlternatives(shot.id, purpose, enabled);
  const sig = `${shot.duration_s}|${shot.effective_quality}|${(shot.characters ?? []).join(",")}`;
  const seen = useRef({ id: shot.id, sig });
  useEffect(() => {
    const was = seen.current;
    seen.current = { id: shot.id, sig };
    if (was.id === shot.id && was.sig !== sig) qc.invalidateQueries({ queryKey: ["shot-alternatives", shot.id, purpose] });
  }, [shot.id, sig, purpose, qc]);
  return q;
}

/** Starts a recover / draft job on one engine through the shared submit flow (approval and budget rules apply). */
function useShotJob(shot: Shot) {
  const qc = useQueryClient();
  const { submit } = useGenerate();
  const [busy, setBusy] = useState<string | null>(null);
  const start = async (path: "recover" | "draft", o: ShotOption, what: string) => {
    setBusy(o.id);
    try {
      const r = await submit(() => api.post<SubmitResult>(`/api/shots/${shot.id}/${path}`, { engine: o.id }), what);
      if (!r) return;
      qc.invalidateQueries({ queryKey: ["shot", shot.id] });
      qc.invalidateQueries({ queryKey: ["episode"] });
      qc.invalidateQueries({ queryKey: ["shot-alternatives", shot.id] });
    } finally { setBusy(null); }
  };
  return { busy, start };
}

/** Green tag: the engine takes the shot's characters as registered references, so they keep their look. */
function CastTag() {
  const t = useT();
  return (
    <Badge tone="ok" title={t("Uses the characters registered with BytePlus, so Seedance keeps their look")}>
      <UserRound className="size-3" />{t("Keeps the cast")}
    </Badge>
  );
}

function OptionTags({ o }: { o: ShotOption }) {
  const t = useT();
  return (
    <>
      {o.uses_registered && <CastTag />}
      {o.provider_mode === "mock" && <Badge tone="warn" title={t("Provider is in mock mode — no real generation")}>{t("placeholder")}</Badge>}
    </>
  );
}

/**
 * A safety filter blocked the shot's latest video and nothing replaced it: who blocked it and why, then a retry on
 * the best other engine (options come best first) or any other one, each priced for this shot.
 */
export function Recovery({ shot, canEdit }: { shot: Shot; canEdit: boolean }) {
  const t = useT();
  const { project } = useProjectCtx();
  const b = shot.blocked;
  const { data, isLoading } = useAlternatives(shot, "recover", !!b);
  const { data: chars } = useCharacters(project.id);
  const { busy, start } = useShotJob(shot);
  if (!b) return null;

  const who = joinNames(b.engine_labels ?? []) || t("A safety filter");
  const opts = data?.options ?? [];
  const [top, ...rest] = opts;
  const missing = data?.cast.missing ?? [];
  const retry = (o: ShotOption) => void start("recover", o, tr("Retry {code} on {engine}", { code: shot.code, engine: o.display_name }));
  const names = missing.map((n, i) => {
    const c = chars?.find((x) => x.name === n);
    return (
      <Fragment key={n}>
        {i > 0 && (i === missing.length - 1 ? ` ${t("and")} ` : ", ")}
        {c ? <Link to={`/p/${project.id}/bible?char=${c.id}`} className={LINK}>{n}</Link> : <span className="font-medium text-ink">{n}</span>}
      </Fragment>
    );
  });

  return (
    <Alert tone="bad" icon={<ShieldAlert className="size-4" />} title={t("{engine} blocked this shot", { engine: who })}>
      {b.error && <p className="line-clamp-2 break-words text-xs leading-snug" title={b.error}>{b.error}</p>}

      {canEdit && (isLoading ? <Skeleton className="mt-2.5 h-7 w-56" /> : top ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="primary" className="min-w-0 max-w-full" icon={<RotateCcw className="size-3.5" />}
            loading={busy === top.id} disabled={!!busy} onClick={() => retry(top)}>
            <span className="truncate">{t("Retry with {engine} · {price}", { engine: top.display_name, price: usd(top.est_usd) })}</span>
          </Button>
          <OptionTags o={top} />
          {rest.length > 0 && (
            <Menu width={320} placement="bottom-start" items={rest.map((o) => ({
              label: <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{o.display_name}</span><OptionTags o={o} /></span>,
              shortcut: <span className="mono text-2xs text-money">{usd(o.est_usd)}</span>,
              disabled: !!busy,
              onClick: () => retry(o),
            }))} trigger={(p) => (
              <Button size="sm" variant="ghost" iconRight={<ChevronDown className="size-3.5" />} loading={!!busy && busy !== top.id} {...p}>
                {t("Other engines ({n})", { n: rest.length })}
              </Button>
            )} />
          )}
        </div>
      ) : data ? (
        <p className="mt-2 text-xs leading-snug">
          {t("No other engine can make this shot.")}{" "}
          {fill(t("Switch one on in {hub} or add a key in {settings}."), {
            hub: <Link to="/models" className={LINK}>{t("Model Hub")}</Link>,
            settings: <Link to="/settings#keys" className={LINK}>{t("Settings")}</Link>,
          })}
        </p>
      ) : null)}

      {canEdit && top?.asset_refs && missing.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-2xs leading-snug">
          <UserRound className="mt-px size-3 shrink-0" />
          <span>{fill(t("Register {names} with BytePlus so Seedance keeps their look."), { names })}</span>
        </p>
      )}
      {canEdit && data && !data.safety_fallback && (
        <p className="mt-1.5 flex items-start gap-1.5 text-2xs leading-snug text-dim">
          <Settings2 className="mt-px size-3 shrink-0" />
          <span>{fill(t("Turn on “On a safety block, try another model” in {settings} and this happens by itself."), {
            settings: <Link to="/settings" className={LINK}>{t("Settings")}</Link>,
          })}</span>
        </p>
      )}
    </Alert>
  );
}

/** "Draft 480p": a cheap low-resolution preview on the cheapest engine that renders 480p. Hidden when none can. */
export function DraftButton({ shot }: { shot: Shot }) {
  const t = useT();
  const { data } = useAlternatives(shot, "draft", true);
  const { busy, start } = useShotJob(shot);
  const o = data?.options[0];
  if (!o) return null;
  const price = usd(o.est_usd);
  return (
    <Tooltip side="left" content={
      <span className="block space-y-0.5">
        <span className="block">{t("A cheap low-resolution preview before the final render. It doesn't replace a finished clip.")}</span>
        <span className="mono block text-2xs text-dim">{o.display_name} · {price}</span>
      </span>
    }>
      <Button size="sm" variant="ghost" icon={<Eye className="size-3.5" />} loading={!!busy}
        onClick={() => void start("draft", o, tr("Draft {code} 480p", { code: shot.code }))}>
        <span className="@md:hidden">{t("Draft 480p")}</span>
        <span className="hidden @md:inline">{t("Draft 480p · {price}", { price })}</span>
      </Button>
    </Tooltip>
  );
}
