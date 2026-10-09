import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";

export interface ApiKeyRow { provider: string; source: "admin" | "env" | "missing"; masked: string }

/** Which AI services have a key, and where it comes from (admins only). One query shared by the status strip and the engine table. */
export const useApiKeys = (enabled: boolean) =>
  useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api.get<ApiKeyRow[]>("/api/settings/api-keys"),
    enabled,
  });
