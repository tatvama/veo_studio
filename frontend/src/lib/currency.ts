/**
 * Rupees next to dollars. Spend is tracked and billed in USD; the UI can show INR beside it at a live rate
 * (GET /api/rates, refreshed every 15 minutes). The mode is a per-user preference ("both" | "usd" | "inr").
 *
 * Money is formatted by plain functions (see lib/format.ts `usd`) so ~130 call sites keep working; they read this store
 * at call time. The Shell re-mounts the page when the mode changes or the first rate arrives, so nothing shows a stale string.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./api";

export type CurrencyMode = "both" | "usd" | "inr";
export interface Rates { base: "USD"; rates: { INR?: number }; as_of: string | null; source: string | null; stale: boolean }

export const CURRENCY_KEY = "veo-currency";
/** Joins the dollar and rupee text of one amount: "$12.40 ≈ ₹1,201". */
export const MONEY_JOIN = " ≈ ";
const MODES: readonly CurrencyMode[] = ["both", "usd", "inr"];

function readMode(): CurrencyMode {
  try {
    const v = localStorage.getItem(CURRENCY_KEY) as CurrencyMode | null;
    return v && MODES.includes(v) ? v : "both";
  } catch {
    return "both";
  }
}

interface CurrencyState {
  mode: CurrencyMode;
  /** Rupees per US dollar; null until the first rate arrives (or if no source ever answered). */
  inr: number | null;
  asOf: string | null;
  source: string | null;
  stale: boolean;
  setMode: (m: CurrencyMode) => void;
  setRates: (r: Rates) => void;
}

export const useCurrency = create<CurrencyState>((set) => ({
  mode: readMode(),
  inr: null,
  asOf: null,
  source: null,
  stale: false,
  setMode: (mode) => {
    if (!MODES.includes(mode)) return;
    try { localStorage.setItem(CURRENCY_KEY, mode); } catch { /* private mode */ }
    set({ mode });
  },
  setRates: (r) => set({ inr: r.rates?.INR ?? null, asOf: r.as_of, source: r.source, stale: r.stale }),
}));

/** Mount once in the signed-in shell: fetches the rate and refreshes it while the app is open. */
export function useRatesSync() {
  const { data } = useQuery({
    queryKey: ["rates"],
    queryFn: () => api.get<Rates>("/api/rates", { silent: true }),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const setRates = useCurrency((s) => s.setRates);
  useEffect(() => { if (data) setRates(data); }, [data, setRates]);
}

/** Changes whenever the text of a money figure would change shape (mode switch, first rate): used as a React key. */
export const useMoneyShape = () => useCurrency((s) => `${s.mode}:${s.inr ? 1 : 0}`);

const inGroups = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const inGroups2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rupees with Indian digit grouping (₹1,03,400): paise below ₹100 or when asked, whole rupees above. */
export function rupees(v: number, digits?: number): string {
  const d = digits ?? (Math.abs(v) < 100 ? 2 : 0);
  return `₹${(d === 0 ? inGroups : inGroups2).format(v)}`;
}

/** Compact rupees for tight labels and axes: ₹950, ₹4.2k, ₹1.2L (lakh), ₹3.4Cr (crore). */
export function rupeesShort(v: number): string {
  const a = Math.abs(v);
  const n = (x: number) => `${+x.toFixed(x >= 10 ? 0 : 1)}`;
  if (a >= 1e7) return `₹${n(v / 1e7)}Cr`;
  if (a >= 1e5) return `₹${n(v / 1e5)}L`;
  if (a >= 1e4) return `₹${n(v / 1e3)}k`;
  if (a >= 1000) return `₹${+(v / 1e3).toFixed(1)}k`;
  if (a < 1) return `₹${+v.toFixed(2)}`;
  return `₹${+v.toFixed(a < 10 ? 1 : 0)}`;
}

/** What a US-dollar amount reads as in each currency, given the user's mode. `inr` is null when there is no rate yet. */
export function splitMoney(usd: number, digits = 2): { usd: string; inr: string | null; mode: CurrencyMode } {
  const { mode, inr } = useCurrency.getState();
  const u = usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(digits)}`;
  if (!inr) return { usd: u, inr: null, mode: "usd" };
  const r = usd * inr;
  const rs = usd > 0 && r < 1 && digits !== 0 ? (r < 0.01 ? "<₹0.01" : rupees(r, 2)) : rupees(r, digits === 0 ? 0 : undefined);
  return { usd: u, inr: rs, mode };
}
