import { useQueryClient } from "@tanstack/react-query";
import { MapPin, Palette, Sparkles, UserRound, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { CastGrid } from "../../components/room/CastGrid";
import { CharacterDetail } from "../../components/room/CharacterDetail";
import { RoomHeader, RoomPage } from "../../components/room/kit";
import { LocationsTab } from "../../components/room/Locations";
import { NewCharacterModal } from "../../components/room/NewCharacter";
import { StyleEditor } from "../../components/room/StyleEditor";
import { scaleMeter, voicedLanguages } from "../../components/room/cast";
import { useConsentRows } from "../../components/room/util";
import { StatStrip, ViewSwitch } from "../../components/room/workspace";
import { Button, Meter } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_SHORT } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useCharacters, useLocations } from "../../lib/queries";
import type { Character } from "../../lib/types";
import { useProjectCtx } from "./context";

export { AudioButton } from "../../components/room/AudioButton";

type Tab = "cast" | "locations" | "style";

/** The bible: cast, locations and visual style. Cast and locations are ID-card grids; opening one shows its own file (?char= / ?loc=). */
export default function BiblePage() {
  const t = useT();
  const { project, eid, canEdit, canProduce } = useProjectCtx();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: chars, isLoading, isError: charsError, refetch: refetchChars } = useCharacters(project.id);
  const { data: locs } = useLocations(project.id);
  const { data: consents } = useConsentRows(canProduce);
  const [busy, setBusy] = useState("");
  const [newChar, setNewChar] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const raw = params.get("tab");
  const tab: Tab = raw === "locations" || raw === "style" ? raw : "cast";
  const charId = tab === "cast" ? Number(params.get("char")) || null : null;
  const locId = tab === "locations" ? Number(params.get("loc")) || null : null;
  const view = `${tab}:${charId ?? locId ?? "list"}`;

  /** Update the URL (tab / open character / open location). Opening something pushes history so Back returns to the grid. */
  const go = (next: { tab?: Tab; char?: number | null; loc?: number | null }, push = false) => {
    const p = new URLSearchParams(params);
    const apply = (k: string, v: string | number | null | undefined) => { if (v === null || v === undefined || v === "") p.delete(k); else p.set(k, String(v)); };
    if ("tab" in next) apply("tab", next.tab === "cast" ? null : next.tab);
    if ("char" in next) apply("char", next.char);
    if ("loc" in next) apply("loc", next.loc);
    setParams(p, { replace: !push });
  };

  // A new view always starts at the top.
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [view]);

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

  // the "New character" tile opens the full form (photos, look) with the typed name filled in
  const addCharacter = (name: string) => setNewChar(name);
  const created = (c: Character) => {
    setNewChar(null);
    qc.invalidateQueries({ queryKey: ["project", project.id] });
    go({ tab: "cast", char: c.id }, true);
  };

  const listing = !charId && !locId;
  const showBuild = canEdit && listing && ((tab === "cast" && !!chars?.length) || (tab === "locations" && !!locs?.length));

  // ── the bible at a glance ────────────────────────────────────────────────
  const cast = chars ?? [];
  const langs = project.languages;
  const lockedChars = cast.filter((c) => c.locked).length;
  const voicedMap = cast.map((c) => voicedLanguages(c.voices));
  const voicedPairs = voicedMap.reduce((n, v) => n + langs.filter((l) => v.has(l)).length, 0);
  const totalPairs = cast.length * langs.length;
  const voicePct = totalPairs ? Math.round((voicedPairs / totalPairs) * 100) : 0;
  const langsDone = cast.length ? langs.filter((l) => voicedMap.every((v) => v.has(l))).length : 0;
  const trained = cast.filter((c) => c.identity?.status === "ready").length;
  const training = cast.filter((c) => c.identity?.status === "training" || c.identity?.status === "preparing").length;
  const failed = cast.filter((c) => c.identity?.status === "failed").length;
  const places = locs ?? [];
  const lockedPlaces = places.filter((l) => l.locked).length;
  const withImages = places.filter((l) => (l.assets?.length ?? 0) > 0 || !!l.thumb_url).length;
  const castMeter = scaleMeter(lockedChars, cast.length, 10);
  const placeMeter = scaleMeter(lockedPlaces, places.length, 10);
  const waiting = isLoading && !chars;

  return (
    <RoomPage width="wide" scrollRef={scroller}>
      {listing && (
        <>
          <RoomHeader icon={<Users />} title={t("Characters & places")}
            description={t("Your film's bible: the cast, places and look. Lock each one once it is approved so every shot matches.")}
            actions={showBuild && (
              <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy === "propose"} onClick={propose}>{t("Build from script")}</Button>
            )} />

          <StatStrip index={1} className="mb-6" cells={[
            {
              key: "cast", label: t("Characters"), value: waiting ? "—" : cast.length, wide: true,
              sub: cast.length ? t("{n} locked", { n: lockedChars }) : t("none yet"),
              visual: cast.length ? <Meter filled={castMeter.filled} total={castMeter.total} tone={lockedChars === cast.length ? "ok" : "accent"} /> : undefined,
            },
            {
              key: "places", label: t("Locations"), value: places.length, sub: places.length ? t("{n} locked · {m} with images", { n: lockedPlaces, m: withImages }) : t("none yet"),
              visual: places.length ? <Meter filled={placeMeter.filled} total={placeMeter.total} tone={lockedPlaces === places.length ? "ok" : "accent"} /> : undefined,
            },
            {
              key: "voices", label: t("Voice coverage"), value: totalPairs ? voicePct : "—", unit: totalPairs ? "%" : undefined, tone: totalPairs && voicePct === 100 ? "ok" : "neutral",
              sub: totalPairs ? <span className="mono">{langs.map((l) => LANG_SHORT[l] ?? l).join(" · ")} · {voicedPairs}/{totalPairs}</span> : t("add a character first"),
              visual: totalPairs ? <Meter filled={langsDone} total={Math.max(1, langs.length)} tone={voicePct === 100 ? "ok" : "accent"} /> : undefined,
            },
            {
              key: "identity", label: t("Identity trained"), value: trained, unit: cast.length ? `/ ${cast.length}` : undefined, tone: cast.length && trained === cast.length ? "ok" : "neutral",
              sub: failed ? <span className="text-red-300">{t("{n} failed", { n: failed })}</span> : training ? t("{n} training", { n: training }) : cast.length ? t("face model per character") : t("none yet"),
            },
          ]} />

          <ViewSwitch<Tab> className="mb-6" label={t("Bible view")} value={tab} onChange={(v) => go({ tab: v, char: null, loc: null })}
            items={[
              { value: "cast", label: t("Cast"), icon: <UserRound />, count: chars?.length || undefined },
              { value: "locations", label: t("Locations"), icon: <MapPin />, count: locs?.length || undefined },
              { value: "style", label: t("Style"), icon: <Palette /> },
            ]} />
        </>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
          {tab === "cast" && (charId ? (
            <CharacterDetail cid={charId} chars={chars ?? []} onBack={() => go({ char: null })} onOpen={(id) => go({ char: id })} />
          ) : (
            <CastGrid chars={chars} loading={isLoading} error={charsError && !chars} onRetry={() => refetchChars()} canEdit={canEdit} languages={project.languages} consents={consents}
              onOpen={(id) => go({ char: id }, true)} onAdd={addCharacter} adding={busy === "add"} onPropose={propose} proposing={busy === "propose"} />
          ))}
          {tab === "locations" && (
            <LocationsTab locId={locId} onOpen={(id) => go({ loc: id }, true)} onBack={() => go({ loc: null })} onPropose={propose} proposing={busy === "propose"} />
          )}
          {tab === "style" && <StyleEditor />}
        </motion.div>
      </AnimatePresence>
      <NewCharacterModal open={newChar !== null} initialName={newChar ?? ""} projectId={project.id} onClose={() => setNewChar(null)} onCreated={created} />
    </RoomPage>
  );
}
