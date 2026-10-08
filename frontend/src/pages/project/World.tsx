import { BookMarked, Globe, Package, Shirt } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useSearchParams } from "react-router-dom";
import { RoomHeader, RoomPage } from "../../components/room/kit";
import { Tabs } from "../../components/ui";
import { BibleTab } from "../../components/world/BibleTab";
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
  // counts for the tab badges (the tabs themselves fetch the same queries, so this costs nothing extra)
  const { data: props } = useProps(project.id);
  const { data: wardrobe } = useWardrobe(eid);
  const { data: bible } = useContinuityBible(eid);
  const inProject = props?.filter((p) => p.in_project).length;

  return (
    <RoomPage width="wide">
      <RoomHeader icon={<Globe />} title={t("World")} description={t("Props, wardrobe through the episode, and the state of every scene.")} />
      <div className="mb-5">
        <Tabs value={tab} onChange={go} tabs={[
          { value: "props", label: <span className="flex items-center gap-1.5"><Package className="size-4" />{t("Props")}</span>, count: inProject || undefined },
          { value: "wardrobe", label: <span className="flex items-center gap-1.5"><Shirt className="size-4" />{t("Wardrobe")}</span>, count: wardrobe?.breaks ? `${wardrobe.breaks} !` : undefined },
          { value: "bible", label: <span className="flex items-center gap-1.5"><BookMarked className="size-4" />{t("Continuity Bible")}</span>, count: bible?.scenes.length || undefined },
        ]} />
      </div>
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
