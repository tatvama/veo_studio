import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type {
  Approval, Character, Comment, Episode, EventRow, Job, Location, Notification, Project, SettingsPayload, Shot, Style, User,
  UserBrief, AgentMessage,
} from "./types";

export const useAuthStatus = () =>
  useQuery({
    queryKey: ["auth"],
    queryFn: () => api.get<{ setup_needed: boolean; google_enabled: boolean; user: UserBrief | null; app_name: string }>("/api/auth/status"),
    staleTime: 60_000,
  });

export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsPayload>("/api/settings"), staleTime: 30_000 });
export const useProjects = (archived = false) => useQuery({ queryKey: ["projects", archived], queryFn: () => api.get<Project[]>(`/api/projects?archived=${archived}`) });
export const useProject = (pid: number) => useQuery({ queryKey: ["project", pid], queryFn: () => api.get<Project>(`/api/projects/${pid}`), enabled: !!pid });
export const useEpisode = (eid: number | undefined, lang?: string) =>
  useQuery({ queryKey: ["episode", eid, lang], queryFn: () => api.get<Episode>(`/api/episodes/${eid}${lang ? `?lang=${lang}` : ""}`), enabled: !!eid });
export const useShot = (sid: number | null, lang?: string) =>
  useQuery({ queryKey: ["shot", sid, lang], queryFn: () => api.get<Shot>(`/api/shots/${sid}${lang ? `?lang=${lang}` : ""}`), enabled: !!sid });
export const useCharacters = (pid?: number) =>
  useQuery({ queryKey: ["characters", pid ?? "library"], queryFn: () => api.get<Character[]>(`/api/characters${pid ? `?project_id=${pid}` : ""}`) });
export const useCharacter = (cid: number | null) =>
  useQuery({ queryKey: ["character", cid], queryFn: () => api.get<Character>(`/api/characters/${cid}`), enabled: !!cid });
export const useLocations = (pid?: number) =>
  useQuery({ queryKey: ["locations", pid ?? "library"], queryFn: () => api.get<Location[]>(`/api/locations${pid ? `?project_id=${pid}` : ""}`) });
export const useStyles = () => useQuery({ queryKey: ["styles"], queryFn: () => api.get<{ styles: Style[]; presets: Omit<Style, "id" | "locked">[] }>("/api/styles") });
export const useJobs = (pid?: number, status = "active") =>
  useQuery({ queryKey: ["jobs", pid ?? "all", status], queryFn: () => api.get<Job[]>(`/api/jobs?status=${status}${pid ? `&project_id=${pid}` : ""}&limit=150`), refetchInterval: 15_000 });
export const useAgentMessages = (pid: number) => useQuery({ queryKey: ["agent", pid], queryFn: () => api.get<AgentMessage[]>(`/api/projects/${pid}/agent/messages`) });
export const useComments = (pid: number, targetType?: string, targetId?: number) =>
  useQuery({
    queryKey: ["comments", pid, targetType, targetId],
    queryFn: () => api.get<Comment[]>(`/api/comments?project_id=${pid}${targetType ? `&target_type=${targetType}&target_id=${targetId}` : ""}`),
  });
export const useActivity = (pid?: number) => useQuery({ queryKey: ["activity", pid], queryFn: () => api.get<EventRow[]>(`/api/activity${pid ? `?project_id=${pid}` : ""}`) });
export const useApprovals = (status = "pending") => useQuery({ queryKey: ["approvals", status], queryFn: () => api.get<Approval[]>(`/api/approvals?status=${status}`) });
export const useNotifications = () => useQuery({ queryKey: ["notifications"], queryFn: () => api.get<Notification[]>("/api/notifications"), refetchInterval: 60_000 });
export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/api/users") });
export const useCosts = () => useQuery({ queryKey: ["costs"], queryFn: () => api.get<any>("/api/costs/summary") });

// ── v2 hooks ─────────────────────────────────────────────────────────────────
import type {
  AIModel, AuditRow, BrandKit, ConsentRow, HookInsight, IntegrationRow, MarketingPack, ModelList, ModelPolicy, Prefs,
  ReviewLinkRow, ScriptVersion, ShotEngines, TableRead,
} from "./types";

export const useModels = (params: { task?: string; status?: string; q?: string; provider?: string; mode?: string; sort?: string; limit?: number; offset?: number } = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== 0).map(([k, v]) => [k, String(v)])).toString();
  return useQuery({ queryKey: ["models", qs], queryFn: () => api.get<ModelList>(`/api/models${qs ? `?${qs}` : ""}`) });
};
export const useModel = (id: string | null) =>
  useQuery({ queryKey: ["model", id], queryFn: () => api.get<AIModel>(`/api/models/${id}`), enabled: !!id });
export const useVideoEngines = () =>
  useQuery({ queryKey: ["models", "video-engines"], queryFn: () => api.get<import("./types").VideoEngines>("/api/engines/video"), staleTime: 60_000 });
export const usePolicy = () => useQuery({ queryKey: ["models", "policy"], queryFn: () => api.get<ModelPolicy>("/api/models/policy") });
export const useShotEngines = (sid: number | null, purpose = "video") =>
  useQuery({ queryKey: ["shot-engines", sid, purpose], queryFn: () => api.get<ShotEngines>(`/api/shots/${sid}/engines?purpose=${purpose}`), enabled: !!sid });
export const useScriptVersions = (eid: number | undefined) =>
  useQuery({ queryKey: ["script-versions", eid], queryFn: () => api.get<ScriptVersion[]>(`/api/episodes/${eid}/script/versions`), enabled: !!eid });
export const useTableRead = (eid: number | undefined) =>
  useQuery({ queryKey: ["table-read", eid], queryFn: () => api.get<Record<string, TableRead>>(`/api/episodes/${eid}/table-read`), enabled: !!eid });
export const useMarketing = (eid: number | undefined) =>
  useQuery({ queryKey: ["marketing", eid], queryFn: () => api.get<MarketingPack>(`/api/episodes/${eid}/marketing`), enabled: !!eid });
export const useBrandKits = () => useQuery({ queryKey: ["brand-kits"], queryFn: () => api.get<BrandKit[]>("/api/brand-kits") });
export const useIntegrations = () =>
  useQuery({ queryKey: ["integrations"], queryFn: () => api.get<{ youtube_ready: boolean; redirect_uri?: string; accounts: IntegrationRow[] }>("/api/integrations") });
export const useConsents = () => useQuery({ queryKey: ["consents"], queryFn: () => api.get<ConsentRow[]>("/api/consents") });
export const useAudit = () => useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditRow[]>("/api/audit") });
export const usePrefs = () => useQuery({ queryKey: ["prefs"], queryFn: () => api.get<Prefs>("/api/me/prefs"), staleTime: 60_000 });
export const useReviewLinks = (xid: number | null) =>
  useQuery({ queryKey: ["review-links", xid], queryFn: () => api.get<ReviewLinkRow[]>(`/api/exports/${xid}/review-links`), enabled: !!xid });
export const useBoard = (eid: number | undefined) =>
  useQuery({ queryKey: ["board", eid], queryFn: () => api.get<import("./types").Board>(`/api/episodes/${eid}/board`), enabled: !!eid });
export const useHookInsights =() => useQuery({ queryKey: ["hook-insights"], queryFn: () => api.get<HookInsight[]>("/api/insights/hooks") });

// ── MCP access ───────────────────────────────────────────────────────────────
import type { McpInfo, McpToken, OAuthRequestView } from "./types";

export const useMcpInfo = () => useQuery({ queryKey: ["mcp", "info"], queryFn: () => api.get<McpInfo>("/api/mcp/info"), staleTime: 60_000 });
export const useMcpTokens = () => useQuery({ queryKey: ["mcp", "tokens"], queryFn: () => api.get<McpToken[]>("/api/mcp/tokens") });
/** A pending "connect this app" request (404 = unknown or gone; shown as an expired link, not a toast). */
export const useOAuthRequest = (rid: string | null) =>
  useQuery({
    queryKey: ["oauth-request", rid], enabled: !!rid, retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
    queryFn: () => api.get<OAuthRequestView>(`/api/oauth/requests/${encodeURIComponent(rid ?? "")}`, { silent: true }),
  });
