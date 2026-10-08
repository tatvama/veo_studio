import { toast } from "sonner";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, opts: { silent?: boolean } = {}): Promise<T> {
  const init: RequestInit = { method, credentials: "include", headers: { "X-Requested-With": "veo-studio" } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      msg = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail)
        ? data.detail.map((d: any) => `${(d.loc || []).slice(-1)[0]}: ${d.msg}`).join("; ")
        : JSON.stringify(data.detail ?? data);
    } catch { /* not json */ }
    if (res.status === 401 && !path.startsWith("/api/auth")) {
      window.dispatchEvent(new CustomEvent("veo:unauthorized"));
    }
    if (!opts.silent && res.status !== 401) toast.error(msg);
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(p: string, o?: { silent?: boolean }) => request<T>("GET", p, undefined, o),
  post: <T>(p: string, b?: unknown, o?: { silent?: boolean }) => request<T>("POST", p, b ?? {}, o),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
  upload: <T>(p: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<T>("POST", p, fd);
  },
};
