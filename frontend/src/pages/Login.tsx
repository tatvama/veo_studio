import { LogoMark } from "../components/shell/Brand";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ArrowRight, CircleAlert, Eye, EyeOff, Languages, LockKeyhole, Monitor, Moon, Sun, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { usePrefActions } from "../components/shell/prefs";
import { nextTheme, useThemePref } from "../components/shell/theme";
import { Button, IconButton, Input, Meter, rise } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { UI_LANGUAGES, useT, useUiLanguage } from "../lib/i18n";
import { useAuthStatus } from "../lib/queries";
import { EngineMarquee, Reel, Stage, useShowreel } from "./login/Cinema";

type Field = "name" | "email" | "password";
type Errors = Partial<Record<Field, string>>;

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** Rough strength estimate for the first-time admin password (the server only enforces the 8-character minimum). */
function strength(pw: string): { score: number; tone: "bad" | "warn" | "ok" } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < 8) score = Math.min(score, 1);
  return { score, tone: (["bad", "bad", "warn", "ok", "ok"] as const)[score] };
}

function useOnline() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; },
    () => navigator.onLine,
    () => true,
  );
}

/** Google's multi-colour "G" — a third-party brand mark, so these fills are the one place we use literal colours. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.27-2.09 3.57-5.17 3.57-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.37-2.28v-3.1H1.27A12 12 0 0 0 0 12c0 1.94.46 3.77 1.27 5.38l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.62l4 3.1C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

function Brand({ className }: { className?: string }) {
  const t = useT();
  return (
    <div className={clsx("flex items-center gap-3", className)}>
      <motion.span
        initial={{ rotate: -30, scale: 0.6, opacity: 0 }}
        animate={{ rotate: 0, scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.1 }}
        className="grid size-10 shrink-0 place-items-center"
      >
        <LogoMark size={40} />
      </motion.span>
      {/* the wordmark drops away below 360px so the language and theme switchers always fit */}
      <span className="leading-none max-[359px]:hidden">
        <span className="text-gradient block text-lg font-semibold tracking-[0.22em]">TATVAM</span>
        <span className="eyebrow mt-1.5 block tracking-[0.32em]">{t("AI STUDIO")}</span>
      </span>
    </div>
  );
}

/** Connection, server and sign-in method, as a row of tiny mono telemetry. All of it is read from the real state. */
function StatusRow({ setupNeeded, googleEnabled, className }: { setupNeeded: boolean; googleEnabled: boolean; className?: string }) {
  const t = useT();
  const online = useOnline();
  const status = useAuthStatus();
  const server = status.isError ? "bad" : status.data ? "ok" : "warn";
  return (
    <ul aria-label={t("System status")} className={clsx("mono flex flex-wrap items-center gap-x-4 gap-y-1.5 text-2xs text-dim", className)}>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className={clsx("live-dot", !online && "is-bad")} />
        <span className={online ? "text-mute" : "text-bad"}>{online ? t("Online") : t("Offline")}</span>
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className={clsx("live-dot", server === "bad" && "is-bad", server === "warn" && "is-warn")} />
        <span className={server === "bad" ? "text-bad" : "text-mute"}>{server === "bad" ? t("Server unreachable") : server === "warn" ? t("Connecting…") : t("Server ready")}</span>
      </li>
      <li className="flex items-center gap-1.5 text-mute">
        <span aria-hidden>◆</span>{setupNeeded ? t("Setup pending") : googleEnabled ? t("Email or Google") : t("Email sign-in")}
      </li>
    </ul>
  );
}

/** Left side on wide screens: the pitch in one line, the five languages, and the showreel caption with its frame picker. */
function Hero({ reel }: { reel: ReturnType<typeof useShowreel> }) {
  const t = useT();
  return (
    <section className="hidden lg:block">
      <p {...rise(0)} className={clsx("lg-glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-mute", rise(0).className)}>
        <span aria-hidden className="live-dot" />{t("AI film studio · made in India")}
      </p>
      <h2 {...rise(1)} className={clsx("lg-headline mt-6 max-w-2xl text-balance", rise(1).className)}>
        {t("Every story,")}<br /><span className="text-gradient">{t("made cinematic.")}</span>
      </h2>
      <p {...rise(2)} className={clsx("mt-5 max-w-xl text-base leading-relaxed text-mute", rise(2).className)}>
        {t("Write it, cast it, shoot it. Your AI crew handles hooks, scripts, characters, shots, voices and lip-sync, and you approve every step and every rupee.")}
      </p>
      <ul {...rise(3)} aria-label={t("Languages")} className={clsx("mt-5 flex flex-wrap gap-2", rise(3).className)}>
        {Object.entries(UI_LANGUAGES).map(([code, label]) => (
          <li key={code} lang={code} className="lg-glass rounded-full px-3 py-1 text-xs text-ink">{label}</li>
        ))}
      </ul>
      <div {...rise(4)} className={clsx("mt-10 max-w-xl", rise(4).className)}>
        <Reel index={reel.index} paused={reel.paused} onPick={reel.go} onHold={reel.setHold} />
      </div>
    </section>
  );
}

function FieldRow({ id, label, hint, error, optional, children }: {
  id: string; label: string; hint?: ReactNode; error?: string; optional?: boolean; children: ReactNode;
}) {
  const t = useT();
  return (
    <div>
      <label htmlFor={id} className="eyebrow mb-2 flex items-baseline justify-between gap-2">
        <span>{label}</span>
        {optional && <span className="font-sans text-2xs font-normal normal-case tracking-normal text-dim">{t("optional")}</span>}
      </label>
      {children}
      <AnimatePresence initial={false} mode="wait">
        {error ? (
          <motion.p key="err" id={`${id}-msg`} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            className="mt-1.5 flex items-start gap-1.5 text-xs text-bad">
            <CircleAlert className="mt-px size-3.5 shrink-0" />{error}
          </motion.p>
        ) : hint ? (
          <p key="hint" id={`${id}-msg`} className="mt-1.5 text-2xs leading-snug text-dim">{hint}</p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export default function Login({ setupNeeded, googleEnabled }: { setupNeeded: boolean; googleEnabled: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const uiLang = useUiLanguage();
  const theme = useThemePref();
  const online = useOnline();
  const reel = useShowreel();
  // Signed out: choices apply now and are saved to the account right after sign-in.
  const prefs = usePrefActions(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [card, animate] = useAnimate<HTMLDivElement>();
  const refs = { name: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) };
  const touch = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

  const shake = () => { if (card.current) void animate(card.current, { x: [0, -8, 8, -5, 5, 0] }, { duration: 0.38 }); };

  const check = (f: Field, v: string): string | undefined => {
    if (f === "email") return !v.trim() ? t("Enter your email address.") : !EMAIL_RE.test(v.trim()) ? t("That doesn't look like an email address.") : undefined;
    if (f === "password") return !v ? t("Enter your password.") : setupNeeded && v.length < 8 ? t("Use at least 8 characters.") : undefined;
    return undefined;
  };
  const setError = (f: Field, msg: string | undefined) => setErrors((e) => ({ ...e, [f]: msg }));
  const onChange = (f: Field, v: string, set: (s: string) => void) => {
    set(v);
    if (formError) setFormError(null);
    if (errors[f]) setError(f, check(f, v)); // re-validate live once a field has been flagged
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    const next: Errors = { email: check("email", email), password: check("password", password) };
    setErrors(next);
    const bad = (["email", "password"] as Field[]).find((f) => next[f]);
    if (bad) {
      refs[bad].current?.focus();
      shake();
      return;
    }
    setBusy(true);
    try {
      if (setupNeeded) await api.post("/api/auth/setup", { email: email.trim(), name: name.trim(), password });
      else await api.post("/api/auth/login", { email: email.trim(), password });
      await qc.invalidateQueries({ queryKey: ["auth"] });
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.status === 401 ? t("Wrong email or password. Check them and try again.") : err.message
          : t("Can't reach the server. Check your connection and try again."),
      );
      shake();
    } finally {
      setBusy(false);
    }
  };

  const ThemeIcon = theme === "light" ? Sun : theme === "system" ? Monitor : Moon;
  const themeLabel = theme === "light" ? t("Light") : theme === "system" ? t("System") : t("Dark");
  const str = strength(password);
  const strengthLabels = [t("Too short"), t("Weak"), t("Okay"), t("Good"), t("Strong")];
  // 16px on phones keeps iOS from zooming into the field on focus
  const fieldCls = (f: Field) => clsx("h-11 bg-panel/60 max-sm:text-base!", errors[f] && "border-bad/60! focus:border-bad! focus:ring-bad/20!");
  const glassBtn = "lg-glass flex h-10 items-center gap-1.5 rounded-full text-xs text-mute transition-colors hover:text-ink sm:h-9";

  return (
    // `clip` (unlike `hidden`) can't be scrolled by focus, which would shift the page sideways.
    <div className="relative flex min-h-full flex-col" style={{ overflow: "clip" }}>
      <Stage index={reel.index} />

      <header className="relative z-10 flex items-center justify-between gap-3 px-4 py-3 sm:px-8 sm:py-5">
        <Brand />
        <div className="flex items-center gap-2">
          <label className={clsx(glassBtn, "pl-3 pr-1 focus-within:border-accent/60")}>
            <Languages className="size-4 shrink-0" />
            <span className="sr-only">{t("Interface language")}</span>
            <select value={uiLang} onChange={(e) => prefs.setLanguage(e.target.value)} className="h-full max-w-[9rem] cursor-pointer bg-transparent pr-2 text-xs text-ink outline-none">
              {Object.entries(UI_LANGUAGES).map(([code, label]) => <option key={code} value={code} lang={code}>{label}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => prefs.setTheme(nextTheme(theme))} title={t("Theme: {name}", { name: themeLabel })} aria-label={t("Theme: {name}", { name: themeLabel })}
            className={clsx(glassBtn, "px-3 active:scale-95")}>
            <motion.span key={theme} initial={{ rotate: -40, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} transition={{ duration: 0.2 }}>
              <ThemeIcon className="size-4" />
            </motion.span>
            <span className="hidden sm:inline">{themeLabel}</span>
          </button>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center px-4 pb-6 pt-2 sm:px-8">
        <div className="mx-auto grid w-full max-w-[84rem] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_27rem] lg:gap-16 xl:gap-24">
          <Hero reel={reel} />

          <div className="mx-auto w-full max-w-[27rem]">
            {/* phones and tablets: the pitch in two lines above the card */}
            <h2 className="lg-headline mb-6 text-balance text-center !text-[2.1rem] sm:!text-[2.6rem] lg:hidden">
              {t("Every story,")} <span className="text-gradient">{t("made cinematic.")}</span>
            </h2>

            <motion.div initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
              <div ref={card} className="lg-card p-6 sm:p-7">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <span className="eyebrow flex items-center gap-2 !text-accent-ink"><LockKeyhole className="size-3.5" />{setupNeeded ? t("First-time setup") : t("Sign in")}</span>
                  <span className="eyebrow flex items-center gap-1.5"><span aria-hidden className={clsx("live-dot", !online && "is-bad")} />{online ? t("Online") : t("Offline")}</span>
                </div>
                <form onSubmit={submit} noValidate className="space-y-4">
                  <div {...rise(0)} className={rise(0).className}>
                    <h1 className="text-balance text-[1.75rem] font-semibold leading-tight tracking-tight">
                      {setupNeeded ? t("Set up your studio") : t("Welcome back")}
                    </h1>
                    <p className="mt-1.5 text-sm text-mute">
                      {setupNeeded ? t("First-time setup — create the admin account") : t("Sign in to pick up where your crew left off.")}
                    </p>
                    {setupNeeded && (
                      <p className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-raised/60 px-3 py-2 text-xs leading-relaxed text-mute">
                        <LockKeyhole className="mt-px size-3.5 shrink-0 text-accent-ink" />
                        {t("You'll be the admin: you can add teammates, set budgets and add API keys.")}
                      </p>
                    )}
                  </div>

                  {setupNeeded && (
                    <div {...rise(1)} className={rise(1).className}>
                      <FieldRow id="login-name" label={t("Your name")} optional>
                        <Input id="login-name" ref={refs.name} className="h-11 bg-panel/60 max-sm:text-base!" value={name} onChange={(e) => setName(e.target.value)}
                          autoComplete="name" autoFocus={!touch} placeholder={t("e.g. Asha Rao")} />
                      </FieldRow>
                    </div>
                  )}

                  <div {...rise(2)} className={rise(2).className}>
                    <FieldRow id="login-email" label={t("Email")} error={errors.email}>
                      <Input
                        id="login-email" ref={refs.email} type="email" inputMode="email" value={email} className={fieldCls("email")}
                        onChange={(e) => onChange("email", e.target.value, setEmail)} onBlur={() => email && setError("email", check("email", email))}
                        autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!touch && !setupNeeded} placeholder="name@example.com"
                        aria-invalid={!!errors.email} aria-describedby={errors.email ? "login-email-msg" : undefined}
                      />
                    </FieldRow>
                  </div>

                  <div {...rise(3)} className={rise(3).className}>
                    <FieldRow id="login-password" label={t("Password")} error={errors.password}
                      hint={setupNeeded && !password ? t("At least 8 characters") : undefined}>
                      <div className="relative">
                        <Input
                          id="login-password" ref={refs.password} type={show ? "text" : "password"} value={password} className={clsx(fieldCls("password"), "pr-11")}
                          onChange={(e) => onChange("password", e.target.value, setPassword)} onBlur={() => { setCaps(false); if (password) setError("password", check("password", password)); }}
                          onKeyDown={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)} onKeyUp={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)}
                          autoComplete={setupNeeded ? "new-password" : "current-password"}
                          aria-invalid={!!errors.password} aria-describedby={errors.password ? "login-password-msg" : undefined}
                        />
                        <IconButton type="button" title={show ? t("Hide password") : t("Show password")} onClick={() => setShow((v) => !v)} tipSide="left"
                          className="absolute right-1.5 top-1/2 size-8 -translate-y-1/2">
                          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </IconButton>
                      </div>
                      <AnimatePresence initial={false}>
                        {caps && (
                          <motion.p key="caps" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden text-xs text-warn">
                            <span className="mt-1.5 flex items-center gap-1.5"><TriangleAlert className="size-3.5" />{t("Caps Lock is on")}</span>
                          </motion.p>
                        )}
                      </AnimatePresence>
                      {setupNeeded && password && (
                        <div className="mt-2 flex items-center gap-2" aria-live="polite">
                          <Meter filled={str.score} total={4} tone={str.tone} className="flex-1" />
                          <span className="mono w-16 text-right text-2xs text-dim">{strengthLabels[str.score]}</span>
                        </div>
                      )}
                    </FieldRow>
                  </div>

                  <AnimatePresence initial={false}>
                    {formError && (
                      <motion.div key="form-error" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }} className="overflow-hidden" role="alert">
                        <div className="flex items-start gap-2.5 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2.5 text-sm text-ink">
                          <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" />
                          <span className="min-w-0 flex-1">{formError}</span>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div {...rise(4)} className={clsx("space-y-4 pt-1", rise(4).className)}>
                    <Button type="submit" variant="primary" size="lg" block loading={busy} className="lg-sheen h-12 rounded-xl text-[0.95rem]" iconRight={<ArrowRight className="size-4" />}>
                      {setupNeeded ? t("Create admin & start") : t("Sign in")}
                    </Button>

                    {googleEnabled && !setupNeeded && (
                      <>
                        <div className="eyebrow flex items-center gap-3">
                          <span className="h-px flex-1 bg-line" />{t("or")}<span className="h-px flex-1 bg-line" />
                        </div>
                        <a href="/api/auth/google/start"
                          className="lg-glass flex h-12 w-full items-center justify-center gap-2.5 rounded-xl text-sm font-medium transition-[background-color,border-color,transform] hover:border-dim/50 hover:bg-hover active:scale-[0.98]">
                          <GoogleMark />{t("Continue with Google")}
                        </a>
                      </>
                    )}

                    {!setupNeeded && (
                      <p className="text-center text-2xs leading-relaxed text-dim">{t("Forgot your password? Ask a studio admin to set a new one for you.")}</p>
                    )}
                  </div>
                </form>
              </div>
            </motion.div>

            <StatusRow setupNeeded={setupNeeded} googleEnabled={googleEnabled} className="mt-4 justify-center" />
          </div>
        </div>
      </main>

      <footer className="relative z-10 px-4 pb-5 sm:px-8">
        <div className="mx-auto max-w-[84rem]"><EngineMarquee /></div>
      </footer>
    </div>
  );
}
