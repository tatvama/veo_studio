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
import { useConsentRows } from "../../components/room/util";
import { Button, Tabs } from "../../components/ui";
import { api } from "../../lib/api";
import { tr, useT } from "../../lib/i18n";
import { useCharacters, useLocations } from "../../lib/queries";
import type { Character } from "../../lib/types";
import { useProjectCtx } from "./context";

export { AudioButton } from "../../components/room/AudioButton";

type Tab = "cast" | "locations" | "style";

/** The bible: cast, locations and visual style. Cast and locations are card grids; opening one shows its own page (?char= / ?loc=). */
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

  return (
    <RoomPage width="wide" scrollRef={scroller}>
      {listing && (
        <>
          <RoomHeader icon={<Users />} title={t("Bible")}
            description={t("The cast, places and look of your film. Lock each one once it is approved so every shot matches.")}
            actions={showBuild && (
              <Button icon={<Sparkles className="size-4" />} loading={busy === "propose"} onClick={propose}>{t("Build from script")}</Button>
            )} />

          <div className="mb-5">
            <Tabs value={tab} onChange={(v) => go({ tab: v, char: null, loc: null })} tabs={[
              { value: "cast", label: <span className="flex items-center gap-1.5"><UserRound className="size-4" />{t("Cast")}</span>, count: chars?.length || undefined },
              { value: "locations", label: <span className="flex items-center gap-1.5"><MapPin className="size-4" />{t("Locations")}</span>, count: locs?.length || undefined },
              { value: "style", label: <span className="flex items-center gap-1.5"><Palette className="size-4" />{t("Style")}</span> },
            ]} />
          </div>
        </>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
          {tab === "cast" && (charId ? (
            <div className="mx-auto max-w-4xl">
              <CharacterDetail cid={charId} chars={chars ?? []} onBack={() => go({ char: null })} onOpen={(id) => go({ char: id })} />
            </div>
          ) : (
            <CastGrid chars={chars} loading={isLoading} error={charsError && !chars} onRetry={() => refetchChars()} canEdit={canEdit} languages={project.languages} consents={consents}
              onOpen={(id) => go({ char: id }, true)} onAdd={addCharacter} adding={busy === "add"} onPropose={propose} proposing={busy === "propose"} />
          ))}
          {tab === "locations" && (
            <div className={locId ? "mx-auto max-w-4xl" : undefined}>
              <LocationsTab locId={locId} onOpen={(id) => go({ loc: id }, true)} onBack={() => go({ loc: null })} onPropose={propose} proposing={busy === "propose"} />
            </div>
          )}
          {tab === "style" && <StyleEditor />}
        </motion.div>
      </AnimatePresence>
      <NewCharacterModal open={newChar !== null} initialName={newChar ?? ""} projectId={project.id} onClose={() => setNewChar(null)} onCreated={created} />
    </RoomPage>
  );
}
