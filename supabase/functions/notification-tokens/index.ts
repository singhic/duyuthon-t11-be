import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireRestUser, restSelect, restWriteSingle } from "../_shared/rest.ts";

type RequestBody = {
  token: string;
  provider?: "fcm" | "apns";
  deviceId?: string;
  platform?: "ios" | "android" | "web";
  timezone?: string;
  enabled?: boolean;
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const user = await requireRestUser(req);

    if (req.method === "GET") {
      const tokens = await restSelect(
        `notification_tokens?select=id,provider,device_id,platform,timezone,enabled,last_seen_at,created_at&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc`,
      );
      return json({ tokens });
    }

    if (req.method !== "POST") {
      throw new HttpError(405, "Method not allowed");
    }

    const body = await readJson<RequestBody>(req);
    if (!body.token?.trim()) {
      throw new HttpError(400, "token is required");
    }

    const data = await restWriteSingle(
      "notification_tokens?on_conflict=provider,token&select=id,provider,device_id,platform,timezone,enabled,last_seen_at,created_at",
      "POST",
      {
        user_id: user.id,
        token: body.token.trim(),
        provider: body.provider ?? "fcm",
        device_id: body.deviceId ?? null,
        platform: body.platform ?? null,
        timezone: body.timezone ?? "Asia/Seoul",
        enabled: body.enabled ?? true,
        last_seen_at: new Date().toISOString(),
      },
      "resolution=merge-duplicates,return=representation",
    );

    return json({ token: data });
  } catch (error) {
    return errorResponse(error);
  }
});
