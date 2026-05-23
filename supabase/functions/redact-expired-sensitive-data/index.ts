import { handleCors } from "../_shared/cors.ts";
import { errorResponse, json, readJson } from "../_shared/http.ts";
import { runRedactExpiredSensitiveData } from "../_shared/redaction.ts";
import { requireAdmin, requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  dryRun?: boolean;
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    await requireAdmin(serviceClient, user.id);

    const body = await readJson<RequestBody>(req);
    const result = await runRedactExpiredSensitiveData(serviceClient, body, { actorUserId: user.id });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
});
