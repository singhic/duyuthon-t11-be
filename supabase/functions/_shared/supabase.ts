import { createClient, SupabaseClient, User } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { HttpError, requireEnv } from "./http.ts";

export function createServiceClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

export function createUserClient(req: Request): SupabaseClient {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new HttpError(401, "Missing Authorization header");
  }

  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_ANON_KEY"),
    {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

export async function requireUser(req: Request): Promise<{ user: User; userClient: SupabaseClient; serviceClient: SupabaseClient }> {
  const userClient = createUserClient(req);
  const { data, error } = await userClient.auth.getUser();

  if (error || !data.user) {
    throw new HttpError(401, "Invalid or expired user token");
  }

  return {
    user: data.user,
    userClient,
    serviceClient: createServiceClient(),
  };
}

export async function requireAdmin(serviceClient: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await serviceClient
    .from("user_profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Failed to verify admin role", error);
  }

  if (data?.role !== "admin") {
    throw new HttpError(403, "Admin role is required");
  }
}

export async function logApiUsage(
  serviceClient: SupabaseClient,
  params: {
    userId?: string;
    provider: "google_vision" | "gemini" | "data_go_kr";
    endpoint: string;
    status?: "succeeded" | "failed";
    requestCount?: number;
    tokenCount?: number;
    imageCount?: number;
    costEstimate?: number;
  },
): Promise<void> {
  await serviceClient.from("api_usage_logs").insert({
    user_id: params.userId ?? null,
    provider: params.provider,
    endpoint: params.endpoint,
    status: params.status ?? "succeeded",
    request_count: params.requestCount ?? 1,
    token_count: params.tokenCount ?? null,
    image_count: params.imageCount ?? null,
    cost_estimate: params.costEstimate ?? null,
  });
}

export async function enforceDailyUsageLimit(
  serviceClient: SupabaseClient,
  params: {
    userId: string;
    provider: "google_vision" | "gemini" | "data_go_kr";
    maxRequests: number;
  },
): Promise<void> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const { data, error } = await serviceClient
    .from("api_usage_logs")
    .select("request_count")
    .eq("user_id", params.userId)
    .eq("provider", params.provider)
    .gte("created_at", since.toISOString());

  if (error) {
    throw new HttpError(500, "Failed to check API usage limit", error);
  }

  const used = (data ?? []).reduce((sum, row) => sum + (row.request_count ?? 1), 0);
  if (used >= params.maxRequests) {
    throw new HttpError(429, `Daily ${params.provider} usage limit exceeded`);
  }
}
