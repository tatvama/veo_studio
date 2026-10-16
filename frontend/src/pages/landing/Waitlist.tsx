import { ArrowRight, Check, CircleAlert, Copy, LockKeyhole, Mail, MessageCircle, Smartphone } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatPhone, maskEmail, maskPhone, normalizePhone, validEmail } from "../../lib/contact";

const JOINED_KEY = "veo-waitlist-joined"; // only a yes/no: never the person's details
const readJoined = () => { try { return localStorage.getItem(JOINED_KEY) === "1"; } catch { return false; } };
const writeJoined = (on: boolean) => {
  try { if (on) localStorage.setItem(JOINED_KEY, "1"); else localStorage.removeItem(JOINED_KEY); } catch { /* storage blocked */ }
};

type Field = "email" | "phone" | "consent";
type Errors = Partial<Record<Field, string>>;

const MESSAGES = {
  emailEmpty: "Enter your email address.",
  emailBad: "That doesn't look like an email address.",
  phoneEmpty: "Enter your mobile number.",
  phoneBad: "Enter a valid mobile number, like 98765 43210.",
  consent: "Please tick the box so we can contact you about the launch.",
};

function check(f: Field, v: string | boolean): string | undefined {
  if (f === "email") return !String(v).trim() ? MESSAGES.emailEmpty : !validEmail(String(v).trim().toLowerCase()) ? MESSAGES.emailBad : undefined;
  if (f === "phone") return !String(v).trim() ? MESSAGES.phoneEmpty : !normalizePhone(String(v)) ? MESSAGES.phoneBad : undefined;
  return v ? undefined : MESSAGES.consent;
}

const SHARE_TEXT = "I just joined the waitlist for Tatvam AI Studio, an AI film studio made in India.";

function Msg({ id, children }: { id: string; children: ReactNode }) {
  return (
    <motion.p id={id} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="mt-1.5 flex items-start gap-1.5 text-xs text-bad">
      <CircleAlert className="mt-px size-3.5 shrink-0" />{children}
    </motion.p>
  );
}

function Joined({ email, phone, onAgain, takeFocus }: { email?: string; phone?: string; onAgain: () => void; takeFocus: boolean }) {
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (takeFocus) heading.current?.focus(); }, [takeFocus]); // the form is gone: keep keyboard and screen-reader users in place
  const url = `${window.location.origin}/`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  };
  return (
    <motion.div key="joined" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }} className="text-center">
      <span className="mx-auto grid size-16 place-items-center rounded-full bg-ok/15 text-ok ring-1 ring-ok/30">
        <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" strokeDasharray="24" style={{ animation: "check-draw 0.6s 0.15s ease-out backwards" }} />
        </svg>
      </span>
      <h3 ref={heading} tabIndex={-1} className="mt-5 text-2xl font-semibold tracking-tight outline-none">You're on the list.</h3>
      <p className="mt-2 text-sm leading-relaxed text-mute sm:text-base">We'll let you know the moment your invite is ready.</p>
      {email && phone && <p className="mono mt-4 text-xs text-dim">{maskEmail(email)} · {maskPhone(phone)}</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <a href={`https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT} ${url}`)}`} target="_blank" rel="noopener noreferrer"
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#25D366] px-5 text-sm font-medium text-black transition-[filter,transform] hover:brightness-110 active:scale-[0.97]">
          <MessageCircle className="size-4" />Tell a friend on WhatsApp
        </a>
        <Button variant="outline" size="lg" onClick={copy} className="h-11 rounded-xl" icon={copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}>
          {copied ? "Link copied" : "Copy link"}
        </Button>
      </div>
      <button type="button" onClick={onAgain} className="mt-5 text-xs text-dim underline-offset-4 hover:text-ink hover:underline">Use a different email or number</button>
    </motion.div>
  );
}

/** The waitlist card: email and mobile number, with the consent to contact. Joins through POST /api/public/waitlist. */
export function WaitlistCard() {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState(""); // honeypot: hidden from people, filled in by bots
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ email: string; phone: string } | null>(null);
  const [before, setBefore] = useState(readJoined);
  const refs = { email: useRef<HTMLInputElement>(null), phone: useRef<HTMLInputElement>(null), consent: useRef<HTMLInputElement>(null) };
  const intl = /^\s*(\+|00)/.test(phone); // a country code was typed: the +91 beside the field no longer applies

  const set = (f: Field, v: string | boolean) => setErrors((e) => ({ ...e, [f]: check(f, v) }));
  const edit = (f: Field, v: string, put: (s: string) => void) => {
    put(v);
    if (formError) setFormError(null);
    if (errors[f]) set(f, v); // once a field has been flagged, re-check it as it is fixed
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    const next: Errors = { email: check("email", email), phone: check("phone", phone), consent: check("consent", consent) };
    setErrors(next);
    const bad = (["email", "phone", "consent"] as Field[]).find((f) => next[f]);
    if (bad) { refs[bad].current?.focus(); return; }
    setBusy(true);
    try {
      await api.post("/api/public/waitlist", { email: email.trim(), phone: phone.trim(), consent, website }, { silent: true });
      writeJoined(true);
      setDone({ email: email.trim().toLowerCase(), phone: normalizePhone(phone) ?? phone });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Can't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const again = () => { writeJoined(false); setBefore(false); setDone(null); setEmail(""); setPhone(""); setConsent(false); setErrors({}); };
  const field = (f: Field) => cn("h-12 bg-panel/60 max-sm:text-base!", errors[f] && "border-bad/60! focus:border-bad! focus:ring-bad/20!");

  return (
    <div className="lg-card p-6 sm:p-8">
      <AnimatePresence mode="wait" initial={false}>
        {done || before ? (
          <Joined key="joined" email={done?.email} phone={done?.phone} onAgain={again} takeFocus={!!done} />
        ) : (
          <motion.form key="form" onSubmit={submit} noValidate exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }} className="space-y-5" aria-label="Join the waitlist">
            <div>
              <label htmlFor="wl-email" className="eyebrow mb-2 block">Email</label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-dim" />
                <Input id="wl-email" ref={refs.email} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="name@example.com"
                  value={email} onChange={(e) => edit("email", e.target.value, setEmail)} onBlur={() => email && set("email", email)}
                  aria-invalid={!!errors.email} aria-describedby={errors.email ? "wl-email-msg" : undefined} className={cn(field("email"), "pl-10")} />
              </div>
              <AnimatePresence initial={false}>{errors.email && <Msg id="wl-email-msg">{errors.email}</Msg>}</AnimatePresence>
            </div>

            <div>
              <label htmlFor="wl-phone" className="eyebrow mb-2 block">Mobile number</label>
              <div className="relative">
                {intl
                  ? <Smartphone className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-dim" />
                  : <span aria-hidden className="mono pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 border-r border-line pr-2.5 text-sm text-mute">+91</span>}
                <Input id="wl-phone" ref={refs.phone} type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210"
                  value={phone} onChange={(e) => edit("phone", e.target.value, setPhone)}
                  onBlur={() => { if (!phone.trim()) return; set("phone", phone); const n = normalizePhone(phone); if (n) setPhone(formatPhone(n)); }}
                  aria-invalid={!!errors.phone} aria-describedby={errors.phone ? "wl-phone-msg" : "wl-phone-hint"} className={cn(field("phone"), intl ? "pl-10" : "pl-[3.75rem]")} />
              </div>
              <AnimatePresence initial={false} mode="wait">
                {errors.phone ? <Msg key="e" id="wl-phone-msg">{errors.phone}</Msg> : <p key="h" id="wl-phone-hint" className="mt-1.5 text-2xs text-dim">Indian mobile numbers need no country code. Elsewhere? Start with + and your code.</p>}
              </AnimatePresence>
            </div>

            {/* honeypot: people never see or reach it (the odd name and label keep browser autofill away from it) */}
            <div aria-hidden className="absolute -left-[9999px] size-0 overflow-hidden">
              <label>Leave this empty<input tabIndex={-1} autoComplete="off" name="hp-ref" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
            </div>

            <div>
              <label className="flex cursor-pointer items-start gap-3 text-sm leading-snug text-mute">
                <input ref={refs.consent} type="checkbox" checked={consent} onChange={(e) => { setConsent(e.target.checked); if (formError) setFormError(null); if (errors.consent) set("consent", e.target.checked); }}
                  aria-invalid={!!errors.consent} aria-describedby={errors.consent ? "wl-consent-msg" : undefined} className="mt-0.5 size-4 shrink-0" />
                <span>I agree that Tatvam may contact me about the launch on this email and number.</span>
              </label>
              <AnimatePresence initial={false}>{errors.consent && <Msg id="wl-consent-msg">{errors.consent}</Msg>}</AnimatePresence>
            </div>

            <AnimatePresence initial={false}>
              {formError && (
                <motion.div key="fe" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="flex items-start gap-2.5 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2.5 text-sm"><CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" /><span>{formError}</span></div>
                </motion.div>
              )}
            </AnimatePresence>

            <Button type="submit" variant="primary" size="lg" block loading={busy} className="lg-sheen h-12 rounded-xl text-[0.95rem]" iconRight={<ArrowRight className="size-4" />}>
              Join the waitlist
            </Button>
            <p className="flex items-center justify-center gap-1.5 text-center text-2xs text-dim"><LockKeyhole className="size-3" />Used only to contact you about Tatvam's launch. We don't sell your details.</p>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}

const FACTS = ["Takes ten seconds, and needs no payment details", "Your invite comes by email and to your phone", "We don't sell your details"];

/** The last section: the pitch on the left, the card on the right, over a blurred frame of the showreel. */
export function WaitlistSection() {
  return (
    <section id="waitlist" className="ld-section ld-wait relative isolate overflow-hidden py-16 sm:py-24">
      <div aria-hidden className="ld-wait-bg" />
      <div className="mx-auto grid max-w-[80rem] gap-12 px-4 sm:px-8 lg:grid-cols-2 lg:items-center lg:gap-20">
        <div>
          <p className="eyebrow flex items-center gap-3 !text-accent-ink"><span aria-hidden className="h-px w-8 bg-accent/60" />Early access</p>
          <h2 className="ld-h2 mt-4 text-balance">Be first in line.</h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-mute sm:text-lg">
            Tatvam is getting ready to open its doors. Leave your email and mobile number and we'll tell you the moment your invite is ready.
          </p>
          <ul className="mt-8 space-y-3 text-sm sm:text-base">
            {FACTS.map((f) => (
              <li key={f} className="flex items-center gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-ok/15 text-ok"><Check className="size-3.5" strokeWidth={3} /></span>{f}</li>
            ))}
          </ul>
        </div>
        <div className="mx-auto w-full max-w-[28rem] lg:mx-0 lg:justify-self-end"><WaitlistCard /></div>
      </div>
    </section>
  );
}
