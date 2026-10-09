import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Attention } from "../components/home/Attention";
import { Composer, type ComposerHandle } from "../components/home/Composer";
import { Engines } from "../components/home/Engines";
import { Feed } from "../components/home/Feed";
import { Greeting } from "../components/home/Greeting";
import { Kpis } from "../components/home/Kpis";
import { ProjectsSection } from "../components/home/Projects";
import { LiveQueue } from "../components/home/Queue";
import { Templates } from "../components/home/Templates";
import { getTemplates, type ProjectTemplate } from "../components/shell/templates";
import { Alert, IconButton, Page } from "../components/ui";
import { useT } from "../lib/i18n";
import { useAuthStatus, useSettings } from "../lib/queries";
import { ROLE_RANK } from "../lib/types";

const MOCK_NOTE_KEY = "veo-mock-note-dismissed";

function readDismissed(): boolean {
  try { return sessionStorage.getItem(MOCK_NOTE_KEY) === "1"; } catch { return false; }
}

/**
 * The Command Center: greeting and a KPI strip on top, then a 12-column bento.
 * Left (8): the New production console with its template rail, and the productions. Right (4): live queue, what needs
 * attention, activity and engine health. Container queries decide the layout: 12 columns wide, 2 medium, 1 narrow.
 * Viewers and reviewers get the same dashboard without the console.
 */
export default function Home() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const composer = useRef<ComposerHandle>(null);
  const templates = getTemplates(t);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [noteDismissed, setNoteDismissed] = useState(readDismissed);
  const role = auth?.user?.role;
  const canCreate = !!role && ROLE_RANK[role] >= ROLE_RANK.creator;
  const canDecide = !!role && ROLE_RANK[role] >= ROLE_RANK.producer;
  const mock = settings?.providers.some((p) => p.provider === "gemini" && p.mode === "mock");

  const dismissNote = () => {
    setNoteDismissed(true);
    try { sessionStorage.setItem(MOCK_NOTE_KEY, "1"); } catch { /* private mode */ }
  };

  const pickTemplate = (tpl: ProjectTemplate) => composer.current?.applyTemplate(tpl);

  // Deep links from the command palette / PWA shortcuts: /?new=1 and /?template=<id>
  useEffect(() => {
    const tplId = params.get("template");
    const isNew = params.get("new");
    if (!tplId && !isNew) return;
    const tpl = tplId ? templates.find((x) => x.id === tplId) : undefined;
    if (tpl && canCreate) composer.current?.applyTemplate(tpl);
    else if (canCreate) composer.current?.focus();
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, canCreate]);

  return (
    <Page width="wide">
      <Greeting user={auth?.user} canCreate={canCreate} onNew={() => composer.current?.focus()} />
      <Kpis canDecide={canDecide} />

      {/* Bento. On narrow containers the two columns dissolve (display: contents) so `order` can put urgent things before the long list. */}
      <div className="@container mt-4">
        <div className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-12">
          <div className="contents @5xl:col-span-8 @5xl:flex @5xl:min-w-0 @5xl:flex-col @5xl:gap-4">
            {canCreate && (
              <div className="order-1 min-w-0 @2xl:col-span-2 @5xl:order-none">
                <AnimatePresence initial={false}>
                  {mock && !noteDismissed && (
                    <motion.div key="mock" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }} className="overflow-hidden">
                      <Alert tone="warn" className="mb-4" title={t("Mock mode")}
                        action={<IconButton title={t("Dismiss")} onClick={dismissNote} className="-my-1 -mr-1.5"><X className="size-4" /></IconButton>}>
                        <span className="text-xs leading-relaxed">
                          {t("No Gemini key yet, so the studio makes free placeholder images, video and voices — try the whole flow.")}{" "}
                          <Link to="/settings" className="whitespace-nowrap font-medium text-ink underline underline-offset-2 hover:text-accent-ink">{t("Add keys in Settings")}</Link>
                        </span>
                      </Alert>
                    </motion.div>
                  )}
                </AnimatePresence>
                <Composer ref={composer} index={2} onTemplateChange={(tpl) => setAppliedId(tpl?.id ?? null)}
                  rail={<Templates items={templates} appliedId={appliedId} onPick={pickTemplate} />} />
              </div>
            )}
            <ProjectsSection index={3} className="order-4 @2xl:order-2 @2xl:col-span-2 @5xl:order-none"
              canCreate={canCreate} onWrite={() => composer.current?.focus()} onTemplate={() => pickTemplate(templates[0])} />
          </div>

          <div className="contents @5xl:col-span-4 @5xl:flex @5xl:min-w-0 @5xl:flex-col @5xl:gap-4 @5xl:self-start">
            <LiveQueue index={2} className="order-3 @5xl:order-none" />
            <Attention index={3} className="order-2 @2xl:order-4 @5xl:order-none" />
            <Feed index={4} className="order-5 @5xl:order-none" />
            <Engines index={5} className="order-6 @5xl:order-none" />
          </div>
        </div>
      </div>
    </Page>
  );
}
