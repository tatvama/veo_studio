import { ArrowRight, Menu, Monitor, Moon, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LogoMark } from "../components/shell/Brand";
import { usePrefActions } from "../components/shell/prefs";
import { nextTheme, useThemePref } from "../components/shell/theme";
import { Button } from "../components/ui";
import { cn } from "../lib/cn";
import { useAuthStatus } from "../lib/queries";
import "../styles/landing.css";
import { NAV } from "./landing/content";
import { Estimator } from "./landing/Estimator";
import { Features } from "./landing/Features";
import { Hero } from "./landing/Hero";
import { India } from "./landing/India";
import { ScrollerContext, scrollToId } from "./landing/parts";
import { BuiltOn, Faq, Gallery } from "./landing/Proof";
import { Stats, Steps, Studio } from "./landing/Studio";
import { WaitlistSection } from "./landing/Waitlist";
import { EngineMarquee } from "./login/Cinema";

const TITLE = "Tatvam AI Studio · India's AI film studio";

function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark size={34} />
      <span className="leading-none max-[379px]:hidden">
        <span className="text-gradient block text-base font-semibold tracking-[0.22em]">TATVAM</span>
        <span className="eyebrow mt-1.5 block !text-[0.625rem] tracking-[0.3em]">AI STUDIO</span>
      </span>
    </span>
  );
}

function Nav({ stuck, signedIn, onJoin }: { stuck: boolean; signedIn: boolean; onJoin: () => void }) {
  const [open, setOpen] = useState(false);
  const theme = useThemePref();
  const prefs = usePrefActions(false); // signed out: the choice applies now and is saved to the account after sign-in
  const ThemeIcon = theme === "light" ? Sun : theme === "system" ? Monitor : Moon;
  const themeLabel = theme === "light" ? "Light" : theme === "system" ? "System" : "Dark";
  const go = (id: string) => { setOpen(false); scrollToId(id); };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const link = (id: string, label: string, cls: string) => (
    <a href={`#${id}`} onClick={(e) => { e.preventDefault(); go(id); }} className={cls}>{label}</a>
  );
  const account = signedIn ? { to: "/", label: "Open studio" } : { to: "/login", label: "Sign in" };

  return (
    <div className="ld-nav sticky top-0 z-50 -mb-16" data-stuck={stuck || open || undefined}>
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-[80rem] items-center justify-between gap-3 px-4 sm:px-8">
        <a href="#top" onClick={(e) => { e.preventDefault(); go("top"); }} aria-label="Tatvam AI Studio, back to the top" className="rounded-lg"><Wordmark /></a>

        <ul className="hidden items-center gap-1 lg:flex">
          {NAV.map((n) => <li key={n.id}>{link(n.id, n.label, "rounded-full px-3.5 py-2 text-sm text-mute transition-colors hover:text-ink")}</li>)}
        </ul>

        <div className="flex items-center gap-2">
          <button type="button" onClick={() => prefs.setTheme(nextTheme(theme))} title={`Theme: ${themeLabel}`} aria-label={`Theme: ${themeLabel}. Change theme`}
            className="lg-glass grid size-10 place-items-center rounded-full text-mute transition-[color,transform] hover:text-ink active:scale-95">
            <ThemeIcon className="size-4" />
          </button>
          <Link to={account.to} className="hidden h-10 items-center rounded-full px-4 text-sm text-mute transition-colors hover:text-ink sm:inline-flex">{account.label}</Link>
          <Button variant="primary" onClick={onJoin} className="h-10 rounded-full px-5">Join waitlist</Button>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="ld-menu" aria-label={open ? "Close menu" : "Open menu"}
            className="lg-glass grid size-10 place-items-center rounded-full text-mute hover:text-ink lg:hidden">
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </nav>

      {open && (
        <div id="ld-menu" className="absolute inset-x-0 top-full border-b border-line bg-panel px-4 pb-4 pt-2 shadow-pop lg:hidden">
          <ul className="space-y-1">
            {NAV.map((n) => <li key={n.id}>{link(n.id, n.label, "block rounded-lg px-3 py-3 text-base text-ink hover:bg-hover")}</li>)}
            <li><Link to={account.to} className="block rounded-lg px-3 py-3 text-base text-ink hover:bg-hover">{account.label}</Link></li>
          </ul>
        </div>
      )}
    </div>
  );
}

function Footer({ signedIn, onJoin }: { signedIn: boolean; onJoin: () => void }) {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-[80rem] gap-10 px-4 py-14 sm:px-8 md:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <Wordmark />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-mute">India's AI film studio. Write it, cast it, shoot it and finish it, in your language, with every cost shown in rupees first.</p>
        </div>
        <nav aria-label="Explore">
          <p className="eyebrow">Explore</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            {NAV.map((n) => (
              <li key={n.id}><a href={`#${n.id}`} onClick={(e) => { e.preventDefault(); scrollToId(n.id); }} className="text-mute transition-colors hover:text-ink">{n.label}</a></li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Studio">
          <p className="eyebrow">Studio</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><button type="button" onClick={onJoin} className="inline-flex items-center gap-1.5 text-mute transition-colors hover:text-ink">Join the waitlist<ArrowRight className="size-3.5" /></button></li>
            <li><Link to={signedIn ? "/" : "/login"} className="text-mute transition-colors hover:text-ink">{signedIn ? "Open studio" : "Sign in"}</Link></li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-[80rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-5 text-xs text-dim sm:px-8">
          <p>© {new Date().getFullYear()} Tatvam AI Studio. Made in India.</p>
          <p>Media is made with third-party AI engines. All names and marks belong to their respective owners.</p>
        </div>
      </div>
    </footer>
  );
}

/** The public home page: what Tatvam is, what it costs, and the waitlist. It scrolls inside its own container. */
export default function Landing() {
  const scroller = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const { data } = useAuthStatus();
  const signedIn = !!data?.user;

  useEffect(() => {
    const prev = document.title;
    document.title = TITLE;
    return () => { document.title = prev; };
  }, []);

  const join = () => {
    scrollToId("waitlist");
    window.setTimeout(() => document.getElementById("wl-email")?.focus({ preventScroll: true }), 700);
  };

  return (
    <ScrollerContext.Provider value={scroller}>
      <div ref={scroller} onScroll={(e) => setStuck(e.currentTarget.scrollTop > 24)} className="ld">
        <Nav stuck={stuck} signedIn={signedIn} onJoin={join} />
        <main>
          <Hero onJoin={join} onHow={() => scrollToId("how")} />
          <div className="ld-flow">
            <div className="mx-auto max-w-[80rem] px-4 pt-2 sm:px-8"><EngineMarquee /></div>
            <Studio />
            <Stats />
            <Steps />
            <Features />
            <India />
            <Estimator />
            <Gallery />
            <BuiltOn />
            <Faq />
          </div>
          <WaitlistSection />
        </main>
        <Footer signedIn={signedIn} onJoin={join} />
      </div>
    </ScrollerContext.Provider>
  );
}
