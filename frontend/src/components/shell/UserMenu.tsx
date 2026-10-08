import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, ChevronsUpDown, Compass, Keyboard, Languages, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../../lib/api";
import { UI_LANGUAGES, useT, useUiLanguage } from "../../lib/i18n";
import { useUI } from "../../lib/store";
import type { UserBrief } from "../../lib/types";
import { Avatar, Kbd, Popover, Segmented, Toggle, Tooltip, type Placement } from "../ui";
import { MOD } from "./keys";
import { usePrefActions } from "./prefs";
import { useMotionPref, useThemePref, type ThemePref } from "./theme";

export async function signOut(qc: ReturnType<typeof useQueryClient>) {
  await api.post("/api/auth/logout");
  qc.clear();
  qc.invalidateQueries({ queryKey: ["auth"] });
}

export function ThemeSwitch({ signedIn, size = "sm" }: { signedIn: boolean; size?: "sm" | "md" }) {
  const t = useT();
  const theme = useThemePref();
  const { setTheme } = usePrefActions(signedIn);
  return (
    <Segmented<ThemePref>
      size={size}
      value={theme}
      onChange={setTheme}
      aria-label={t("Theme")}
      options={[
        { value: "dark", title: t("Dark"), label: <span className="flex items-center gap-1"><Moon className="size-3.5" />{t("Dark")}</span> },
        { value: "light", title: t("Light"), label: <span className="flex items-center gap-1"><Sun className="size-3.5" />{t("Light")}</span> },
        { value: "system", title: t("Follow system"), label: <span className="flex items-center gap-1"><Monitor className="size-3.5" />{t("System")}</span> },
      ]}
    />
  );
}

export function LanguageList({ signedIn, onPicked }: { signedIn: boolean; onPicked?: () => void }) {
  const lang = useUiLanguage();
  const { setLanguage } = usePrefActions(signedIn);
  return (
    <div className="grid grid-cols-2 gap-1">
      {Object.entries(UI_LANGUAGES).map(([code, name]) => (
        <button
          key={code}
          onClick={() => { setLanguage(code); onPicked?.(); }}
          className={clsx("flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
            lang === code ? "bg-accent/15 text-ink" : "text-mute hover:bg-hover hover:text-ink")}
        >
          <span lang={code}>{name}</span>
          {lang === code && <Check className="size-3.5 text-accent-ink" />}
        </button>
      ))}
    </div>
  );
}

export function UserMenu({ user, expanded = false, placement = "right-end" }: { user: UserBrief; expanded?: boolean; placement?: Placement }) {
  const t = useT();
  const qc = useQueryClient();
  const ui = useUI();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const motionPref = useMotionPref();
  const { setMotion } = usePrefActions(true);
  const name = user.name || user.email;

  const trigger = expanded ? (
    <button
      ref={ref}
      data-tour="user-menu"
      onClick={() => setOpen((v) => !v)}
      aria-label={t("Account and preferences")}
      aria-expanded={open}
      className={clsx("mt-1 flex w-full items-center gap-2.5 rounded-xl p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50", open ? "bg-hover" : "hover:bg-hover")}
    >
      <Avatar name={name} size={32} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-2xs capitalize text-dim">{roleLabel(t, user.role)}</span>
      </span>
      <ChevronsUpDown className="size-4 shrink-0 text-dim" />
    </button>
  ) : (
    <button
      ref={ref}
      data-tour="user-menu"
      onClick={() => setOpen((v) => !v)}
      aria-label={t("Account and preferences")}
      aria-expanded={open}
      className={clsx("mt-1 flex size-10 items-center justify-center self-center rounded-full outline-none ring-2 transition focus-visible:ring-accent/60", open ? "ring-accent/50" : "ring-transparent hover:ring-line")}
    >
      <Avatar name={name} size={34} />
    </button>
  );

  return (
    <>
      {open || expanded ? trigger : <Tooltip content={name} side="right">{trigger}</Tooltip>}
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement={placement} width={296} className="p-2">
        <div className="flex items-center gap-3 px-2 pb-2 pt-1">
          <Avatar name={name} size={36} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-mute">{user.email} · {roleLabel(t, user.role)}</p>
          </div>
        </div>
        <div className="space-y-3 border-t border-line px-2 py-3">
          <div>
            <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-dim">{t("Theme")}</p>
            <ThemeSwitch signedIn />
          </div>
          <div>
            <p className="mb-1.5 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-dim"><Languages className="size-3.5" />{t("Interface language")}</p>
            <LanguageList signedIn />
          </div>
          <Toggle checked={motionPref === "reduced"} onChange={(v) => setMotion(v ? "reduced" : "full")} label={<span className="text-sm text-mute">{t("Reduce motion")}</span>} />
        </div>
        <div className="border-t border-line pt-1.5">
          <button onClick={() => { setOpen(false); ui.setShortcutsOpen(true); }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-mute transition-colors hover:bg-hover hover:text-ink">
            <Keyboard className="size-4" /> {t("Keyboard shortcuts")} <span className="ml-auto"><Kbd>?</Kbd></span>
          </button>
          <button onClick={() => { setOpen(false); ui.startTour(); }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-mute transition-colors hover:bg-hover hover:text-ink">
            <Compass className="size-4" /> {t("Take the tour")}
          </button>
          <button onClick={() => { setOpen(false); ui.setPaletteOpen(true); }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-mute transition-colors hover:bg-hover hover:text-ink">
            <span className="flex size-4 items-center justify-center font-mono text-2xs">⌘</span> {t("Command palette")}
            <span className="ml-auto flex gap-0.5"><Kbd>{MOD}</Kbd><Kbd>K</Kbd></span>
          </button>
          <button onClick={() => signOut(qc)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-mute transition-colors hover:bg-hover hover:text-ink">
            <LogOut className="size-4" /> {t("Sign out")}
          </button>
        </div>
      </Popover>
    </>
  );
}

export function roleLabel(t: (s: string) => string, role: string): string {
  const labels: Record<string, string> = {
    viewer: t("viewer"), reviewer: t("reviewer"), creator: t("creator"), producer: t("producer"), admin: t("admin"),
  };
  return labels[role] ?? role;
}
