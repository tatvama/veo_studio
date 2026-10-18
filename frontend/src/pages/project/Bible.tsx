import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, MapPin, Palette, Sparkles, UserRound, Users, Wand2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { FaceList, PlaceList } from "../../components/room/CastList";
import { CharacterDetail } from "../../components/room/CharacterDetail";
import { RoomEmpty } from "../../components/room/kit";
import { PlaceDetail, useAddPlace } from "../../components/room/Locations";
import { NewCharacterModal } from "../../components/room/NewCharacter";
import { useCastImpact } from "../../components/room/redo";
import { StyleEditor } from "../../components/room/StyleEditor";
import { ViewSwitch } from "../../components/room/workspace";
import { useGenerate } from "../../components/Generate";
import { PriceSuffix } from "../../components/kit/Price";
import { useElementWidth } from "../../components/review/utils";
import { Button, IconButton, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import { useBatchEstimate } from "../../lib/estimates";
import { useCharacters, useEpisode, useLocations } from "../../lib/queries";
import type { Character } from "../../lib/types";
import { useProjectCtx } from "./context";

export { AudioButton } from "../../components/room/AudioButton";

type Tab = "cast" | "locations" | "style";
/** phone: the list, or one open face full screen · two: list + the face (panel under the pictures) · three: list, pictures, panel */
type Mode = "phone" | "two" | "three";

/**
 * Cast, faces first: on the left the list of faces (picture, name, voice, "look out of date"), in the middle the open
 * character's big pictures (Approve / Redo, "Make pictures · price", "Redo these shots · price" after a look change), on
 * the right a details panel (voice, look lock, outfits, Advanced). Places work the same way. On a phone the list comes
 * first and a tap opens the character full screen with the panel under the pictures. ?char= / ?loc= name the open one.
 */
export default function BiblePage() {
  const t = useT();
  const { project, eid, lang, canEdit } = useProjectCtx();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: chars, isLoading, isError: charsError, refetch: refetchChars } = useCharacters(project.id);
  const { data: locs, isLoading: locsLoading, isError: locsError, refetch: refetchLocs } = useLocations(project.id);
  const [busy, setBusy] = useState("");
  const [newChar, setNewChar] = useState<string | null>(null);
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const w = width || window.innerWidth;
  const mode: Mode = w < 640 ? "phone" : w < 1000 ? "two" : "three";

  const raw = params.get("tab");
  const tab: Tab = raw === "locations" || raw === "style" ? raw : "cast";
  const charParam = Number(params.get("char")) || null;
  const locParam = Number(params.get("loc")) || null;
  // on a laptop someone is always open (the first face until you pick one); on a phone the list comes first
  const charId = tab !== "cast" ? null : charParam ?? (mode !== "phone" ? chars?.[0]?.id ?? null : null);
  const locId = tab !== "locations" ? null : locParam ?? (mode !== "phone" ? locs?.[0]?.id ?? null : null);

  /** Update the URL (tab / open character / open place). On a phone opening one pushes history, so Back returns to the list. */
  const go = (next: { tab?: Tab; char?: number | null; loc?: number | null }, push = false) => {
    const p = new URLSearchParams(params);
    const apply = (k: string, v: string | number | null | undefined) => { if (v === null || v === undefined || v === "") p.delete(k); else p.set(k, String(v)); };
    if ("tab" in next) apply("tab", next.tab === "cast" ? null : next.tab);
    if ("char" in next) apply("char", next.char);
    if ("loc" in next) apply("loc", next.loc);
    setParams(p, { replace: !push });
  };
  const openChar = (id: number) => go({ char: id }, mode === "phone");
  const openLoc = (id: number) => go({ loc: id }, mode === "phone");

  const stale = useCastImpact((chars ?? []).map((c) => c.id), project.id);

  const propose = async () => {
    setBusy("propose");
    try {
      const r = await api.post<{ characters_created: string[] }>(`/api/projects/${project.id}/bible/propose`, { episode_id: eid });
      toast.success(r.characters_created.length ? tr("Added {names}", { names: r.characters_created.join(", ") }) : tr("Bible is up to date"));
      qc.invalidateQueries({ queryKey: ["characters"] });
      qc.invalidateQueries({ queryKey: ["locations"] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
    } catch { /* api toasts */ } finally { setBusy(""); }
  };
  // "+ Add" under the list opens the full form (photos, look) with the typed name filled in
  const created = (c: Character) => {
    setNewChar(null);
    qc.invalidateQueries({ queryKey: ["project", project.id] });
    go({ tab: "cast", char: c.id }, mode === "phone");
  };
  const place = useAddPlace((l) => go({ tab: "locations", loc: l.id }, mode === "phone"));

  // ── next: make the cast (pictures and voices for whoever has none), priced on the button ──
  const nav = useNavigate();
  const loc = useLocation();
  const fromImport = !!(loc.state as { fromImport?: boolean } | null)?.fromImport;
  const [hideImportNote, setHideImportNote] = useState(false);
  const { generate } = useGenerate();
  const { data: ep } = useEpisode(eid, lang);
  const shotCount = (ep?.shots ?? []).filter((s) => s.include).length;
  const pictured = (chars ?? []).filter((c) => c.avatar_url).length;
  const { data: castEst } = useBatchEstimate(eid, canEdit && shotCount > 0 ? { action: "produce", steps: ["cast"] } : null, [shotCount, pictured, (chars ?? []).length]);
  const castTodo = !!castEst && castEst.count > 0;
  const makeCast = async () => {
    setBusy("cast");
    try { await generate(eid, { action: "produce", steps: ["cast"] }, tr("Make the cast")); } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const phoneDetail = mode === "phone" && (charId || locId) && tab !== "style";
  // a phone's detail starts at the top
  useEffect(() => { if (phoneDetail) document.getElementById("cast-phone-detail")?.scrollTo({ top: 0 }); }, [phoneDetail, charId, locId]);

  const list = tab === "cast" ? (
    <FaceList chars={chars} loading={isLoading} error={charsError && !chars} onRetry={() => void refetchChars()} selected={charId} onSelect={openChar}
      canEdit={canEdit} languages={project.languages} stale={stale} onAdd={(name) => setNewChar(name)} adding={false} onPropose={() => void propose()} proposing={busy === "propose"}
      className="h-full" />
  ) : (
    <PlaceList places={locs} loading={locsLoading} error={locsError && !locs} onRetry={() => void refetchLocs()} selected={locId} onSelect={openLoc}
      canEdit={canEdit} onAdd={(name) => void place.add(name)} adding={place.adding} onPropose={() => void propose()} proposing={busy === "propose"} className="h-full" />
  );
  const waiting = tab === "cast" ? isLoading && !chars : locsLoading && !locs;
  const nothing = waiting ? (
    <div className="space-y-4 p-5" aria-busy="true">
      <Skeleton className="h-6 w-48" />
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,10rem),1fr))]">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] !rounded-xl" />)}
      </div>
    </div>
  ) : (
    <div className="grid h-full place-items-center p-6">
      <RoomEmpty icon={tab === "cast" ? <UserRound /> : <MapPin />} title={tab === "cast" ? t("No cast yet") : t("No places yet")}
        sub={t("Build the cast and the places from your script, or add them by name on the left.")}
        action={canEdit ? <Button variant="primary" loading={busy === "propose"} icon={<Sparkles className="size-4" />} onClick={() => void propose()}>{t("Build from script")}</Button> : undefined} />
    </div>
  );
  const detail = (columns: boolean, showBack: boolean) => tab === "cast"
    ? (charId ? <CharacterDetail key={charId} cid={charId} chars={chars ?? []} columns={columns} showBack={showBack} onBack={() => go({ char: null })} onOpen={openChar} /> : nothing)
    : (locId ? <PlaceDetail key={locId} locId={locId} columns={columns} showBack={showBack} onBack={() => go({ loc: null })} onOpen={openLoc} /> : nothing);

  return (
    <div ref={rootRef} className="hud-bg flex h-full min-w-0 flex-col">
      {!phoneDetail && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel/60 px-3 py-2 sm:px-4">
          <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight"><Users aria-hidden className="size-4 text-accent-ink" />{t("Cast")}</h1>
          <ViewSwitch<Tab> size={mode === "phone" ? "md" : "sm"} label={t("Cast view")} value={tab} onChange={(v) => go({ tab: v, char: null, loc: null })}
            className="max-sm:[&_[role=tab]]:h-10"
            items={[
              { value: "cast", label: t("People"), icon: <UserRound />, count: chars?.length || undefined },
              { value: "locations", label: t("Places"), icon: <MapPin />, count: locs?.length || undefined },
              { value: "style", label: t("Style"), icon: <Palette /> },
            ]} />
          <span className="flex-1" />
          {canEdit && tab !== "style" && ((tab === "cast" && !!chars?.length) || (tab === "locations" && !!locs?.length)) && (
            <Button size="sm" variant="ghost" className="max-sm:h-10" icon={<Sparkles className="size-3.5" />} loading={busy === "propose"} onClick={() => void propose()}
              title={t("Add everyone and every place the script names that isn't here yet")}>{t("Build from script")}</Button>
          )}
          {canEdit && castTodo ? (
            <Button size="sm" variant="primary" className="max-sm:h-10" icon={<Wand2 className="size-3.5" />} loading={busy === "cast"} disabled={!!busy} onClick={() => void makeCast()}
              title={t("A picture of every character and place, and a voice for everyone who speaks: only what is missing is made")}>
              {t("Make the cast")}<PriceSuffix usd={castEst?.total_usd} />
            </Button>
          ) : canEdit && fromImport && shotCount > 0 ? (
            <Button size="sm" variant="primary" className="max-sm:h-10" iconRight={<ArrowRight className="size-3.5" />} onClick={() => nav(`/p/${project.id}/shots`)}>{t("Go to the shots")}</Button>
          ) : null}
        </div>
      )}
      {canEdit && fromImport && castTodo && !hideImportNote && !phoneDetail && (
        <div className="flex shrink-0 items-center gap-2 border-b border-accent/25 bg-accent/8 px-3 py-1.5 text-xs sm:px-4" role="status">
          <p className="min-w-0 flex-1"><span className="font-medium text-accent-ink">{t("Story imported.")}</span>{" "}
            {t("Next: make the cast, so everyone looks and sounds the same in every shot. Want your own photos? Open a character and upload them first.")}</p>
          <Button size="sm" variant="ghost" className="max-sm:h-10" onClick={() => nav(`/p/${project.id}/shots`)}>{t("Skip for now")}</Button>
          <IconButton title={t("Dismiss")} onClick={() => setHideImportNote(true)} className="max-sm:!size-10"><X className="size-4" /></IconButton>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {tab === "style" ? (
          <div className="h-full overflow-y-auto overscroll-contain" data-page-scroller>
            <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-5 @container"><StyleEditor /></div>
          </div>
        ) : mode === "phone" ? (
          phoneDetail ? (
            <div id="cast-phone-detail" className="h-full overflow-y-auto overscroll-contain px-4 pb-16 pt-3" data-page-scroller>{detail(false, true)}</div>
          ) : list
        ) : (
          <div className="grid h-full" style={{ gridTemplateColumns: `${mode === "three" ? "15rem" : "13.5rem"} minmax(0,1fr)` }}>
            <div className="min-h-0 border-r border-line bg-panel/40">{list}</div>
            {mode === "three" ? <div className="min-h-0 min-w-0">{detail(true, false)}</div>
              : <div key={`${tab}-${charId ?? locId ?? ""}`} className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 pb-16 pt-4" data-page-scroller>{detail(false, false)}</div>}
          </div>
        )}
      </div>
      <NewCharacterModal open={newChar !== null} initialName={newChar ?? ""} projectId={project.id} onClose={() => setNewChar(null)} onCreated={created} />
    </div>
  );
}
