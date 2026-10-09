import { Moon, Sun } from "lucide-react";
import { useT } from "../../lib/i18n";
import { Tooltip } from "../ui";
import { usePrefActions } from "./prefs";
import { useResolvedTheme } from "./theme";

/** One-click light / dark switch for the top bar (the account menu has the full dark / light / system choice). */
export function ThemeButton() {
  const t = useT();
  const theme = useResolvedTheme();
  const { setTheme } = usePrefActions(true);
  const toLight = theme === "dark";
  return (
    <Tooltip content={toLight ? t("Switch to light theme") : t("Switch to dark theme")} side="bottom">
      <button
        aria-label={toLight ? t("Switch to light theme") : t("Switch to dark theme")}
        onClick={() => setTheme(toLight ? "light" : "dark")}
        className="flex size-8 items-center justify-center rounded-lg border border-line bg-raised/60 text-mute outline-none transition-colors hover:border-accent/40 hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {toLight ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
    </Tooltip>
  );
}
