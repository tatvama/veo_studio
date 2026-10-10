import { BookMarked, Globe, Package, Shirt } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useSearchParams } from "react-router-dom";
import { RoomHeader, RoomPage } from "../../components/room/kit";
import { StatStrip, ViewSwitch } from "../../components/room/workspace";
import { Meter } from "../../components/ui";
import { BibleTab } from "../../components/world/BibleTab";
import { endStateEmpty } from "../../components/world/EndState";
import { PropsTab } from "../../components/world/PropsTab";
import { WardrobeTab } from "../../components/world/WardrobeTab";
import { useT } from "../../lib/i18n";
import { useCharacters } from "../../lib/queries";
import { useContinuityBible, useProps, useWardrobe } from "../../lib/v3";
import { useProjectCtx } from "./context";

type Tab = "props" | "wardrobe" | "bible";

/** World: props, the wardrobe timeline and the Continuity Bible. The tab lives in the URL (?tab=) so links can deep-link. */
export default function WorldPage() {
  const t = useT();
  const { project, eid, canEdit } = useProjectCtx();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = raw === "wardrobe" || raw === "bible" ? raw : "props";
  const go = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === "props") p.delete("tab"); else p.set("tab", next);
    setParams(p, { replace: true });
  };
  const { data: cast } = useCharacters(project.id);
  // counts for the view badges and the status strip (the views fetch the same queries, so this costs nothing extra)
  const { data: props } = useProps(project.id);
  const { data: wardrobe } = useWardrobe(eid);
  const { data: bible } = useContinuityBible(eid);
  const inProject = props?.filter((p) => p.in_project).length;
  const scenesTotal = bible?.scenes.length ?? 0;
  const written = bible?.scenes.filter((s) => !endStateEmpty(s.end_state)).length ?? 0;
  const breaks = wardrobe?.breaks;
  // the end-state meter never has more than 16 cells; at least one is lit while any scene has a state
  const cells = Math.max(1, Math.min(scenesTotal, 16));
  const lit = !scenesTotal || !written ? 0 : Math.max(1, Math.round((written / scenesTotal) * cells));

  return (
    <RoomPage width="wide">
      <RoomHeader icon={<Globe />} title={t("Props & wardrobe")} description={t("Props, wardrobe through the episode, and the state of every scene.")} />

      <StatStrip index={1} className="mb-6" cells={[
        { key: "props", label: t("Props in project"), value: inProject ?? "—", sub: props ? t("{n} more in the library", { n: props.length - (inProject ?? 0) }) : undefined },
        { key: "cast", label: t("Characters in wardrobe"), value: wardrobe ? wardrobe.characters.length : "—", sub: cast?.length ? t("{n} in the cast", { n: cast.length }) : undefined },
        {
          key: "breaks", label: t("Wardrobe breaks"), value: breaks ?? "—", tone: breaks ? "warn" : breaks === 0 ? "ok" : "neutral",
          sub: breaks ? t("Changed without the script saying so") : breaks === 0 ? t("Every outfit change is in the script") : undefined,
        },
        {
          key: "end", label: t("Scenes with an end state"), value: bible ? written : "—", unit: bible ? `/ ${scenesTotal}` : undefined, wide: true,
          tone: bible && scenesTotal > 0 && written === scenesTotal ? "ok" : "neutral",
          visual: bible && scenesTotal > 0 ? <Meter filled={lit} total={cells} tone={written === scenesTotal ? "ok" : "accent"} /> : undefined,
        },
      ]} />

      <ViewSwitch className="mb-6" label={t("World views")} value={tab} onChange={go} items={[
        { value: "props", label: t("Props"), icon: <Package />, count: inProject || undefined },
        { value: "wardrobe", label: t("Wardrobe"), icon: <Shirt />, count: breaks || undefined, warn: !!breaks },
        { value: "bible", label: t("Continuity Bible"), icon: <BookMarked />, count: bible?.scenes.length || undefined },
      ]} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
          {tab === "props" && <PropsTab pid={project.id} canEdit={canEdit} />}
          {tab === "wardrobe" && <WardrobeTab eid={eid} pid={project.id} cast={cast ?? []} />}
          {tab === "bible" && <BibleTab eid={eid} pid={project.id} cast={cast ?? []} canEdit={canEdit} />}
        </motion.div>
      </AnimatePresence>
    </RoomPage>
  );
}
