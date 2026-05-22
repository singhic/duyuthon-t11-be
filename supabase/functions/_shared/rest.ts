import { HttpError, requireEnv } from "./http.ts";

export type RestUser = {
  id: string;
};

export function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

export async function requireRestUser(req: Request): Promise<RestUser> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new HttpError(401, "Missing Authorization header");

  const response = await fetch(`${requireEnv("SUPABASE_URL")}/auth/v1/user`, {
    headers: {
      apikey: requireEnv("SUPABASE_ANON_KEY"),
      Authorization: authHeader,
    },
  });
  const body = await response.json();
  if (!response.ok || !body.id) {
    throw new HttpError(401, "Invalid or expired user token", body);
  }

  return { id: body.id };
}

export async function restSelect<T>(path: string): Promise<T[]> {
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/${path}`, {
    headers: serviceHeaders(),
  });
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, "Supabase REST select failed", body);
  return body as T[];
}

export async function restSelectSingle<T>(path: string): Promise<T | null> {
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/${path}`, {
    headers: serviceHeaders({ Accept: "application/vnd.pgrst.object+json" }),
  });
  if (response.status === 406) return null;
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, "Supabase REST select failed", body);
  return body as T;
}

export async function restWriteSingle<T>(
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
  prefer = "return=representation",
): Promise<T> {
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/${path}`, {
    method,
    headers: serviceHeaders({
      "Content-Type": "application/json",
      Prefer: prefer,
      Accept: "application/vnd.pgrst.object+json",
    }),
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, "Supabase REST write failed", body);
  return body as T;
}

export async function restRpc<T>(name: string, payload: unknown): Promise<T[]> {
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serviceHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new HttpError(response.status, "Supabase RPC failed", body);
  return body as T[];
}

export async function requireRestAdmin(userId: string): Promise<void> {
  const profile = await restSelectSingle<{ role: string | null }>(
    `user_profiles?select=role&user_id=eq.${encodeURIComponent(userId)}`,
  );
  if (profile?.role !== "admin") {
    throw new HttpError(403, "Admin role is required");
  }
}
