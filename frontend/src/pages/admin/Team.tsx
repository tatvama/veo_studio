import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  BadgeCheck, Check, Copy, Eye, EyeOff, KeyRound, MessageSquare, RefreshCw, ShieldCheck, Sparkles, UserPlus, Users, type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { agoT, copyText, fmtDateTime } from "../../components/growth/common";
import { FilterChip } from "../../components/home/Chips";
import {
  Alert, Avatar, Badge, Button, Empty, IconButton, Input, Modal, Page, PageHeader, Progress, ScrollStrip, SearchField, Section, Select,
  Skeleton, Toggle, rise,
} from "../../components/ui";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useAuthStatus, useSettings, useUsers } from "../../lib/queries";
import { ROLE_RANK, type Role, type User, type UserBrief } from "../../lib/types";

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

const ROLE_ORDER: Role[] = ["admin", "producer", "creator", "reviewer", "viewer"];

const ROLE_INFO: Record<Role, { label: string; desc: string; tone: Tone; icon: LucideIcon }> = {
  admin: { label: "Admin", desc: "Manages people, API keys and the team budget.", tone: "accent", icon: ShieldCheck },
  producer: { label: "Producer", desc: "Approves spending, locks the Bible and approves exports.", tone: "info", icon: BadgeCheck },
  creator: { label: "Creator", desc: "Writes and generates, within their monthly limit.", tone: "ok", icon: Sparkles },
  reviewer: { label: "Reviewer", desc: "Comments on work and approves takes.", tone: "warn", icon: MessageSquare },
  viewer: { label: "Viewer", desc: "Can watch only.", tone: "neutral", icon: Eye },
};

function displayName(u: Pick<UserBrief, "name" | "email">): string {
  return u.name?.trim() || u.email.split("@")[0];
}

function makePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

function RoleBadge({ role }: { role: Role }) {
  const t = useT();
  const info = ROLE_INFO[role] ?? ROLE_INFO.viewer;
  return <Badge tone={info.tone}>{t(info.label)}</Badge>;
}

// ── "what each role can do" ──────────────────────────────────────────────────────────────────────────────────────

function RoleLegend() {
  const t = useT();
  return (
    <Section title={t("What each role can do")} className="mt-8">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {ROLE_ORDER.map((r, i) => {
          const info = ROLE_INFO[r];
          const Icon = info.icon;
          const a = rise(i);
          return (
            <div key={r} className={a.className} style={a.style}>
              <div className="h-full rounded-xl border border-line bg-panel p-3.5">
                <div className="flex items-center gap-2">
                  <span className="grid size-7 place-items-center rounded-lg bg-raised text-mute"><Icon className="size-4" /></span>
                  <RoleBadge role={r} />
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-mute">{t(info.desc)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ── limit input (blank = team default) ───────────────────────────────────────────────────────────────────────────

function LimitInput({ u, disabled, onSave }: { u: User; disabled?: boolean; onSave: (body: Record<string, unknown>, msg: string) => void }) {
  const initial = u.monthly_limit_usd == null ? "" : String(u.monthly_limit_usd);
  const t = useT();
  const [val, setVal] = useState(initial);
  useEffect(() => setVal(initial), [initial]);

  const commit = () => {
    const raw = val.trim();
    if (raw === initial || (raw !== "" && initial !== "" && Number(raw) === Number(initial))) return;
    if (raw === "") {
      onSave({ clear_limit: true }, t("{name} now uses the team default limit", { name: displayName(u) }));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      toast.error(t("Enter a dollar amount, for example 25"));
      setVal(initial);
      return;
    }
    onSave({ monthly_limit_usd: n }, t("{name}'s monthly limit is now {usd}", { name: displayName(u), usd: usd(n) }));
  };

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-dim">$</span>
      <Input
        className="pl-6"
        inputMode="decimal"
        aria-label={t("Monthly limit for {name}", { name: displayName(u) })}
        placeholder={t("Default")}
        value={val}
        disabled={disabled}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { setVal(initial); e.currentTarget.blur(); }
        }}
      />
    </div>
  );
}

function limitHint(u: User): string {
  const rank = ROLE_RANK[u.role] ?? 0;
  if (rank < ROLE_RANK.creator) return tr("Can't generate");
  if (rank >= ROLE_RANK.producer) return tr("Not limited (can approve)");
  if (u.effective_limit_usd == null) return tr("No limit");
  return u.monthly_limit_usd == null ? tr("Team default: {usd}", { usd: usd(u.effective_limit_usd) }) : tr("Custom limit");
}

// ── one member ───────────────────────────────────────────────────────────────────────────────────────────────────
// One DOM structure, two layouts chosen by the width of the list (container query): stacked card below ~940px, table row above.

const COLS = "@min-[940px]:grid-cols-[minmax(0,1.7fr)_8.5rem_8.5rem_minmax(0,1.2fr)_4.5rem_6.5rem_2.25rem]";

function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("min-w-0", className)}>
      <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-dim @min-[940px]:hidden">{label}</p>
      {children}
    </div>
  );
}

function UserRow({ u, index, isMe, onSetPassword }: { u: User; index: number; isMe: boolean; onSetPassword: (u: User) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const name = displayName(u);
  const r = rise(index);

  const patch = async (field: string, body: Record<string, unknown>, msg: string) => {
    setBusy(field);
    try {
      await api.patch<User>(`/api/users/${u.id}`, body);
      await qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(msg);
    } catch {
      /* the api helper already showed the error */
    } finally {
      setBusy(null);
    }
  };

  const spent = u.spent_month_usd ?? 0;
  const limit = u.effective_limit_usd;
  const showBar = ROLE_RANK[u.role] === ROLE_RANK.creator && limit != null && limit > 0;
  const pct = showBar ? spent / (limit as number) : 0;

  return (
    <li className={r.className} style={r.style}>
      <div className={clsx("rounded-xl border border-line bg-panel shadow-card transition-colors hover:border-dim/40", !u.active && "bg-panel/60")}>
        <div className={clsx("grid grid-cols-2 gap-x-4 gap-y-4 p-4 @min-[520px]:grid-cols-3 @min-[760px]:grid-cols-5 @min-[940px]:items-center @min-[940px]:gap-y-0 @min-[940px]:py-3", COLS)}>
          {/* person */}
          <div className="col-span-full flex min-w-0 items-center gap-3 @min-[940px]:col-span-1">
            <span className={clsx(!u.active && "opacity-50")}><Avatar name={name} size={38} /></span>
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-1.5 font-medium">
                <span className="truncate">{name}</span>
                {isMe && <Badge tone="accent">{t("You")}</Badge>}
                {!u.active && <Badge tone="bad">{t("Turned off")}</Badge>}
              </p>
              <p className="truncate text-xs text-mute">{u.email}</p>
            </div>
            <IconButton title={t("Set a new password")} onClick={() => onSetPassword(u)} className="@min-[940px]:hidden"><KeyRound className="size-4" /></IconButton>
          </div>

          <Cell label={t("Role")}>
            <Select
              value={u.role}
              aria-label={t("Role for {name}", { name })}
              disabled={isMe || busy === "role"}
              title={isMe ? t("You can't change your own role") : undefined}
              onChange={(e) => {
                const role = e.target.value as Role;
                void patch("role", { role }, t("{name} is now {role}", { name, role: t(ROLE_INFO[role].label) }));
              }}
            >
              {ROLE_ORDER.map((rl) => <option key={rl} value={rl}>{t(ROLE_INFO[rl].label)}</option>)}
            </Select>
          </Cell>

          <Cell label={t("Monthly limit")}>
            <LimitInput u={u} disabled={busy === "limit"} onSave={(body, msg) => void patch("limit", body, msg)} />
            <p className="mt-1 truncate text-2xs text-dim" title={limitHint(u)}>{limitHint(u)}</p>
          </Cell>

          <Cell label={t("Spent this month")} className="col-span-2 @min-[520px]:col-span-1">
            <p className="text-sm tabular-nums">
              <span className="font-medium">{usd(spent)}</span>
              {showBar && <span className="text-dim"> {t("of {limit}", { limit: usd(limit) })}</span>}
            </p>
            {showBar && <Progress className="mt-1.5" size="sm" value={pct} tone={pct >= 0.9 ? "bad" : pct >= 0.7 ? "warn" : "accent"} />}
          </Cell>

          <Cell label={t("Can sign in")} className="@min-[940px]:flex @min-[940px]:justify-center">
            <div className="flex items-center gap-2.5">
              <Toggle
                checked={u.active}
                disabled={isMe || busy === "active"}
                label={<span className="sr-only">{t("Can sign in")}: {name}</span>}
                onChange={(v) => void patch("active", { active: v }, v ? t("{name} can sign in again", { name }) : t("{name} can no longer sign in", { name }))}
              />
              <span className="text-xs text-mute @min-[940px]:sr-only">{u.active ? t("Yes") : t("No")}</span>
            </div>
          </Cell>

          <Cell label={t("Last sign-in")}>
            <p className="whitespace-nowrap text-sm text-mute" title={u.last_login_at ? fmtDateTime(u.last_login_at) : undefined}>
              {u.last_login_at ? agoT(u.last_login_at) : <span className="text-dim">{t("Never")}</span>}
            </p>
          </Cell>

          <div className="hidden justify-end @min-[940px]:flex">
            <IconButton title={t("Set a new password")} onClick={() => onSetPassword(u)}><KeyRound className="size-4" /></IconButton>
          </div>
        </div>
      </div>
    </li>
  );
}

function TableHead() {
  const t = useT();
  return (
    <div className={clsx("mb-2 hidden gap-x-4 px-[calc(1rem+1px)] text-2xs font-semibold uppercase tracking-[0.08em] text-dim @min-[940px]:grid", COLS)} aria-hidden>
      <span>{t("Person")}</span><span>{t("Role")}</span><span>{t("Monthly limit")}</span><span>{t("Spent this month")}</span><span className="text-center">{t("Can sign in")}</span><span>{t("Last sign-in")}</span><span />
    </div>
  );
}

function RowSkeleton() {
  return (
    <div aria-hidden className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-3"><Skeleton className="size-9 rounded-full" /><div className="space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-44" /></div></div>
      <div className="mt-4 grid grid-cols-2 gap-3 @min-[760px]:grid-cols-5"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
    </div>
  );
}

// ── modals ───────────────────────────────────────────────────────────────────────────────────────────────────────

const BLANK = { email: "", name: "", role: "creator" as Role, password: "", limit: "" };
const LIMIT_PRESETS = [10, 25, 50, 100];

function PasswordField({ id, value, onChange, error, autoFocus, required }: {
  id: string; value: string; onChange: (v: string) => void; error?: string; autoFocus?: boolean; required?: boolean;
}) {
  const t = useT();
  const [show, setShow] = useState(true);
  return (
    <div>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            id={id} className={clsx("pr-10 font-mono", error && "border-bad/60!")} type={show ? "text" : "password"} autoComplete="new-password" spellCheck={false}
            autoFocus={autoFocus} required={required} minLength={8} value={value} placeholder={t("At least 8 characters")}
            aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} onChange={(e) => onChange(e.target.value)}
          />
          <IconButton type="button" title={show ? t("Hide password") : t("Show password")} onClick={() => setShow((v) => !v)} tipSide="top"
            className="absolute right-1 top-1/2 size-7 -translate-y-1/2">
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </IconButton>
        </div>
        <Button type="button" variant="outline" icon={<RefreshCw className="size-4" />} onClick={() => { onChange(makePassword()); setShow(true); }}>{t("Make one")}</Button>
        <AnimatePresence initial={false}>
          {value.length >= 8 && (
            <motion.span key="copy" initial={{ opacity: 0, scale: 0.8, width: 0 }} animate={{ opacity: 1, scale: 1, width: "auto" }} exit={{ opacity: 0, scale: 0.8, width: 0 }} className="overflow-hidden">
              <IconButton type="button" title={t("Copy password")} onClick={() => void copyText(value, t("Password"))} className="size-9 border border-line"><Copy className="size-4" /></IconButton>
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      {error && <p id={`${id}-err`} className="mt-1.5 text-xs text-bad">{error}</p>}
    </div>
  );
}

function FieldBlock({ label, htmlFor, hint, error, optional, children }: { label: string; htmlFor?: string; hint?: ReactNode; error?: string; optional?: boolean; children: ReactNode }) {
  const t = useT();
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between gap-2 text-xs font-medium text-mute">
        <span>{label}</span>
        {optional && <span className="text-2xs font-normal text-dim">{t("optional")}</span>}
      </label>
      {children}
      {error ? <p className="mt-1.5 text-xs text-bad" id={htmlFor ? `${htmlFor}-err` : undefined}>{error}</p> : hint ? <p className="mt-1.5 text-2xs leading-snug text-dim">{hint}</p> : null}
    </div>
  );
}

function AddTeammateModal({ open, onClose, defaultLimit, googleEnabled }: {
  open: boolean; onClose: () => void; defaultLimit: number | null | undefined; googleEnabled: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState(BLANK);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof BLANK, string>>>({});
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof typeof BLANK>(k: K, v: (typeof BLANK)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const close = () => {
    setForm(BLANK);
    setErrors({});
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const email = form.email.trim();
    const next: typeof errors = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) next.email = t("Enter a valid email address");
    if (form.password && form.password.length < 8) next.password = t("The password needs at least 8 characters");
    else if (!form.password && !googleEnabled) next.password = t("Set a temporary password so they can sign in");
    let limit: number | null = null;
    if (form.limit.trim()) {
      const n = Number(form.limit);
      if (!Number.isFinite(n) || n < 0) next.limit = t("Monthly limit must be a dollar amount, for example 25");
      else limit = n;
    }
    setErrors(next);
    if (Object.keys(next).length) {
      if (next.email) emailRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.post<User>("/api/users", {
        email, name: form.name.trim(), role: form.role, password: form.password || null, monthly_limit_usd: limit,
      });
      await qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(t("{name} joined the team", { name: form.name.trim() || email }), {
        description: form.password ? t("Share the temporary password with them privately.") : t("They can sign in with Google."),
      });
      close();
    } catch {
      /* already toasted */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("Add a teammate")}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>{t("Cancel")}</Button>
          <Button variant="primary" type="submit" form="add-teammate" loading={busy} icon={<UserPlus className="size-4" />}>{t("Add teammate")}</Button>
        </>
      )}
    >
      <form id="add-teammate" onSubmit={submit} noValidate className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldBlock label={t("Email")} htmlFor="tm-email" error={errors.email}>
            <Input id="tm-email" ref={emailRef} type="email" autoFocus value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="name@example.com"
              aria-invalid={!!errors.email} className={clsx(errors.email && "border-bad/60!")} />
          </FieldBlock>
          <FieldBlock label={t("Name")} htmlFor="tm-name" optional>
            <Input id="tm-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder={t("Full name")} />
          </FieldBlock>
        </div>

        <FieldBlock label={t("Role")}>
          <div role="radiogroup" aria-label={t("Role")} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {ROLE_ORDER.map((rl) => {
              const info = ROLE_INFO[rl];
              const Icon = info.icon;
              const on = form.role === rl;
              return (
                <button key={rl} type="button" role="radio" aria-checked={on} onClick={() => set("role", rl)}
                  className={clsx("flex items-center justify-center gap-2 rounded-xl border px-2 py-2.5 text-xs font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-95 sm:flex-col sm:gap-1.5",
                    on ? "border-accent/60 bg-accent/10 text-ink" : "border-line bg-panel text-mute hover:border-dim/50 hover:bg-hover hover:text-ink")}>
                  <Icon className={clsx("size-4", on && "text-accent-ink")} />{t(info.label)}
                </button>
              );
            })}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p key={form.role} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}
              className="mt-2 rounded-lg bg-raised/60 px-3 py-2 text-xs leading-relaxed text-mute">
              {t(ROLE_INFO[form.role].desc)}
            </motion.p>
          </AnimatePresence>
        </FieldBlock>

        <FieldBlock
          label={t("Temporary password")}
          htmlFor="tm-password"
          hint={googleEnabled ? t("At least 8 characters. Leave blank if they will sign in with Google.") : t("At least 8 characters. Share it with them privately.")}
        >
          <PasswordField id="tm-password" value={form.password} onChange={(v) => set("password", v)} error={errors.password} />
        </FieldBlock>

        <FieldBlock
          label={t("Monthly spending limit (optional)")}
          htmlFor="tm-limit"
          error={errors.limit}
          hint={defaultLimit != null ? t("Leave blank to use the team default ({usd} for creators).", { usd: usd(defaultLimit) }) : t("Leave blank to use the team default.")}
        >
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-dim">$</span>
            <Input id="tm-limit" className="pl-6" inputMode="decimal" value={form.limit} onChange={(e) => set("limit", e.target.value)} placeholder={t("Default")} aria-invalid={!!errors.limit} />
          </div>
          <ScrollStrip className="mt-2 -mx-1 px-1">
            <div className="flex gap-1.5 pr-4">
              <FilterChip active={form.limit.trim() === ""} onClick={() => set("limit", "")}>{t("Team default")}</FilterChip>
              {LIMIT_PRESETS.map((n) => <FilterChip key={n} active={form.limit.trim() === String(n)} onClick={() => set("limit", String(n))}>${n}</FilterChip>)}
            </div>
          </ScrollStrip>
        </FieldBlock>
      </form>
    </Modal>
  );
}

function SetPasswordModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPw("");
    setError(undefined);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (pw.length < 8) return void setError(t("The password needs at least 8 characters"));
    setBusy(true);
    try {
      await api.patch<User>(`/api/users/${user.id}`, { password: pw });
      await qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(t("New password set for {name}", { name: displayName(user) }), { description: t("They have been signed out and must use the new password.") });
      close();
    } catch {
      /* already toasted */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!user}
      onClose={close}
      size="sm"
      title={user ? t("New password for {name}", { name: displayName(user) }) : t("New password")}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>{t("Cancel")}</Button>
          <Button variant="primary" type="submit" form="set-password" loading={busy} icon={<KeyRound className="size-4" />}>{t("Set password")}</Button>
        </>
      )}
    >
      <form id="set-password" onSubmit={submit} noValidate className="space-y-3">
        <Alert tone="warn" icon={<KeyRound className="size-4" />}>{t("They will be signed out everywhere and must sign in again with this password.")}</Alert>
        <FieldBlock label={t("New password")} htmlFor="tm-newpw" hint={t("At least 8 characters. Share it with them privately.")}>
          <PasswordField id="tm-newpw" autoFocus value={pw} onChange={(v) => { setPw(v); setError(undefined); }} error={error} />
        </FieldBlock>
      </form>
    </Modal>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export default function TeamPage() {
  const t = useT();
  const { data: auth } = useAuthStatus();
  const me = auth?.user ?? null;
  const isAdmin = me?.role === "admin";
  const { data: users, isLoading, isError, refetch } = useUsers();
  const { data: settings } = useSettings();
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState<User | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState<Role | "all">("all");

  const defaultLimit = settings?.settings?.creator_default_monthly_limit_usd as number | null | undefined;
  const list = users ?? [];
  const activeCount = list.filter((u) => u.active).length;
  const sorted = [...list].sort((a, b) =>
    Number(b.active) - Number(a.active) || (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0) || displayName(a).localeCompare(displayName(b)));
  const needle = q.trim().toLowerCase();
  const shown = sorted.filter((u) => (role === "all" || u.role === role) && (!needle || `${u.name} ${u.email}`.toLowerCase().includes(needle)));
  const filterable = list.length >= 6;
  const roleCounts = ROLE_ORDER.map((rl) => [rl, list.filter((u) => u.role === rl).length] as const).filter(([, n]) => n > 0);

  const addBtn = (
    <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)} className="h-10 w-[calc(100vw-2rem)] max-w-full sm:h-9 sm:w-auto">{t("Add teammate")}</Button>
  );

  return (
    <Page width="wide">
      <PageHeader
        title={t("Team")}
        subtitle={users ? (list.length === 1 ? t("1 person · {n} can sign in", { n: activeCount }) : t("{count} people · {n} can sign in", { count: list.length, n: activeCount })) : t("Who works in this studio")}
        icon={<Users className="size-5" />}
        actions={isAdmin ? addBtn : undefined}
      />

      {isLoading ? (
        <div aria-busy="true" className="@container space-y-3">{Array.from({ length: 3 }, (_, i) => <RowSkeleton key={i} />)}</div>
      ) : isError ? (
        <Alert tone="bad" title={t("Couldn't load the team")} action={<Button size="sm" variant="outline" onClick={() => void refetch()}>{t("Try again")}</Button>}>
          {t("Check your connection and try again.")}
        </Alert>
      ) : !list.length ? (
        <Empty icon={<Users className="size-7" />} title={t("No teammates yet")} sub={t("Add the people who will write, review and approve videos.")}
          action={isAdmin ? <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>{t("Add teammate")}</Button> : undefined} />
      ) : isAdmin ? (
        <>
          {filterable && (
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <SearchField value={q} onChange={setQ} placeholder={t("Search people…")} aria-label={t("Search people")} className="w-full sm:w-64" />
              <ScrollStrip className="-mx-4 px-4 sm:mx-0 sm:min-w-0 sm:flex-1 sm:px-0">
                <div className="flex gap-2 pr-6">
                  <FilterChip active={role === "all"} onClick={() => setRole("all")} count={list.length}>{t("Everyone")}</FilterChip>
                  {roleCounts.map(([rl, n]) => <FilterChip key={rl} active={role === rl} onClick={() => setRole(rl)} count={n}>{t(ROLE_INFO[rl].label)}</FilterChip>)}
                </div>
              </ScrollStrip>
            </div>
          )}
          <div className="@container">
            <TableHead />
            {shown.length ? (
              <ul className="space-y-2.5">
                {shown.map((u, i) => <UserRow key={u.id} u={u} index={i} isMe={u.id === me?.id} onSetPassword={setPwFor} />)}
              </ul>
            ) : (
              <Empty title={t("No one matches")} sub={t("Try a different name or clear the filters.")} action={<Button variant="outline" onClick={() => { setQ(""); setRole("all"); }}>{t("Clear filters")}</Button>} />
            )}
          </div>
        </>
      ) : (
        <>
          <Alert tone="info" icon={<ShieldCheck className="size-4" />} className="mb-4">
            {t("Only admins can add people, change roles or set spending limits. Ask an admin if something needs to change.")}
          </Alert>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((u, i) => {
              const a = rise(i);
              return (
                <div key={u.id} className={a.className} style={a.style}>
                  <div className={clsx("flex items-center gap-3 rounded-xl border border-line bg-panel p-3.5", !u.active && "opacity-60")}>
                    <Avatar name={displayName(u)} size={38} />
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 items-baseline gap-1.5 font-medium">
                        <span className="truncate">{displayName(u)}</span>
                        {u.id === me?.id && <span className="shrink-0 text-xs font-normal text-dim">{t("(you)")}</span>}
                      </p>
                      <p className="truncate text-xs text-mute">{u.email}</p>
                    </div>
                    <RoleBadge role={u.role} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <RoleLegend />

      {isAdmin && (
        <>
          <AddTeammateModal open={adding} onClose={() => setAdding(false)} defaultLimit={defaultLimit} googleEnabled={!!auth?.google_enabled} />
          <SetPasswordModal user={pwFor} onClose={() => setPwFor(null)} />
        </>
      )}
    </Page>
  );
}
