// Thin client for the Vikunja REST API (v1 API, tested against Vikunja v2.4.x).

export class VikunjaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class Vikunja {
  private base: string;

  constructor(
    baseUrl: string,
    private token: string,
  ) {
    // Accept either https://host or https://host/api/v1
    this.base = baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
  }

  get frontendUrl(): string {
    return this.base.replace(/\/api\/v1$/, "");
  }

  async request<T = any>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg =
        (data && typeof data === "object" && (data.message || data.error)) ||
        (typeof data === "string" ? data : res.statusText);
      throw new VikunjaError(res.status, `Vikunja ${method} ${path} failed (${res.status}): ${msg}`);
    }
    return { data: data as T, headers: res.headers };
  }

  get<T = any>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query }).then((r) => r.data);
  }
  put<T = any>(path: string, body: unknown) {
    return this.request<T>("PUT", path, { body }).then((r) => r.data);
  }
  post<T = any>(path: string, body: unknown) {
    return this.request<T>("POST", path, { body }).then((r) => r.data);
  }
  delete<T = any>(path: string) {
    return this.request<T>("DELETE", path).then((r) => r.data);
  }

  /** Fetch every page of a paginated list endpoint (capped to protect against runaway loops). */
  async getAll<T = any>(path: string, query: Query = {}, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, headers } = await this.request<T[]>("GET", path, {
        query: { ...query, page, per_page: 50 },
      });
      if (!Array.isArray(data) || data.length === 0) break;
      out.push(...data);
      const totalPages = Number(headers.get("x-pagination-total-pages") ?? "1");
      if (!Number.isFinite(totalPages) || page >= totalPages) break;
    }
    return out;
  }
}

// ---------- Response shaping: keep tool output small and readable ----------

const NULL_DATE = "0001-01-01T00:00:00Z";
export const date = (d?: string | null) => (!d || d.startsWith("0001-01-01") ? null : d);
export const toVikunjaDate = (d: string | null | undefined) => (d ? d : NULL_DATE);

export const PRIORITY_NAMES = ["unset", "low", "medium", "high", "urgent", "do now"];

export function slimTask(t: any, frontend?: string) {
  if (!t || typeof t !== "object") return t;
  return {
    id: t.id,
    identifier: t.identifier || undefined,
    title: t.title,
    description: t.description || undefined,
    done: t.done,
    done_at: date(t.done_at) ?? undefined,
    project_id: t.project_id,
    priority: t.priority ? `${t.priority} (${PRIORITY_NAMES[t.priority] ?? "?"})` : undefined,
    due_date: date(t.due_date) ?? undefined,
    start_date: date(t.start_date) ?? undefined,
    end_date: date(t.end_date) ?? undefined,
    repeat_after_seconds: t.repeat_after || undefined,
    percent_done: t.percent_done || undefined,
    labels: t.labels?.length ? t.labels.map((l: any) => ({ id: l.id, title: l.title })) : undefined,
    assignees: t.assignees?.length
      ? t.assignees.map((u: any) => ({ id: u.id, username: u.username, name: u.name || undefined }))
      : undefined,
    reminders: t.reminders?.length ? t.reminders.map((r: any) => r.reminder ?? r) : undefined,
    is_favorite: t.is_favorite || undefined,
    created: t.created,
    updated: t.updated,
    url: frontend ? `${frontend}/tasks/${t.id}` : undefined,
  };
}

export function slimProject(p: any, frontend?: string) {
  return {
    id: p.id,
    title: p.title,
    description: p.description || undefined,
    parent_project_id: p.parent_project_id || undefined,
    is_archived: p.is_archived || undefined,
    is_favorite: p.is_favorite || undefined,
    identifier: p.identifier || undefined,
    hex_color: p.hex_color || undefined,
    url: frontend ? `${frontend}/projects/${p.id}` : undefined,
  };
}
