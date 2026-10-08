import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Composer, type ComposerHandle } from "../components/home/Composer";
import { ProjectsSection } from "../components/home/Projects";
import { Templates } from "../components/home/Templates";
import { getTemplates, type ProjectTemplate } from "../components/shell/templates";
import { Alert, IconButton, Page, rise } from "../components/ui";
import { useT } from "../lib/i18n";
import { useAuthStatus, useSettings } from "../lib/queries";
import { ROLE_RANK } from "../lib/types";

const MOCK_NOTE_KEY = "veo-mock-note-dismissed";

function readDismissed(): boolean {
  try { return sessionStorage.getItem(MOCK_NOTE_KEY) === "1"; } catch { return false; }
}

export default function Home() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const composer = useRef<ComposerHandle>(null);
  const templates = getTemplates(t);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [noteDismissed, setNoteDismissed] = useState(readDismissed);
  const canCreate = !!auth?.user && ROLE_RANK[auth.user.role] >= ROLE_RANK.creator;
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

  const hero = rise(0);
  const body = rise(1);

  return (
    <Page width="wide">
      <div className="relative isolate">
        {/* a soft accent glow behind the hero */}
        {canCreate && (
          <div aria-hidden className="pointer-events-none absolute -inset-x-8 -top-10 -z-10 h-[28rem] bg-[radial-gradient(ellipse_55%_75%_at_50%_0%,color-mix(in_oklab,var(--color-accent)_12%,transparent),transparent_72%)]" />
        )}

        <header style={hero.style} className={canCreate ? `mx-auto mb-6 max-w-3xl text-center ${hero.className}` : `mb-6 ${hero.className}`}>
          <h1 className="text-balance text-3xl font-semibold leading-tight tracking-tight">
            {canCreate ? t("What do you want to make today?") : t("Projects")}
          </h1>
          <p className={canCreate ? "mx-auto mt-2 max-w-xl text-mute" : "mt-1 max-w-2xl text-sm text-mute"}>
            {canCreate
              ? t("Give a concept. The Director writes the hooks, script, cast and shots — you approve, it generates.")
              : t("Everything your team is making, in one place.")}
          </p>
        </header>

        <AnimatePresence initial={false}>
          {mock && canCreate && !noteDismissed && (
            <motion.div key="mock" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }} className="mx-auto max-w-4xl overflow-hidden">
              <Alert tone="warn" className="mb-5" title={t("Mock mode")}
                action={<IconButton title={t("Dismiss")} onClick={dismissNote} className="-my-1 -mr-1.5"><X className="size-4" /></IconButton>}>
                <span className="text-xs leading-relaxed">
                  {t("No Gemini key yet, so the studio makes free placeholder images, video and voices — try the whole flow.")}{" "}
                  <Link to="/settings" className="whitespace-nowrap font-medium text-ink underline underline-offset-2 hover:text-accent-ink">{t("Add keys in Settings")}</Link>
                </span>
              </Alert>
            </motion.div>
          )}
        </AnimatePresence>

        {canCreate && (
          <div style={body.style} className={`mx-auto mb-12 max-w-4xl ${body.className}`}>
            <Composer ref={composer} onTemplateChange={(tpl) => setAppliedId(tpl?.id ?? null)} />
          </div>
        )}

        {canCreate && <Templates items={templates} appliedId={appliedId} onPick={pickTemplate} />}

        <ProjectsSection canCreate={canCreate} onWrite={() => composer.current?.focus()} onTemplate={() => pickTemplate(templates[0])} />
      </div>
    </Page>
  );
}
