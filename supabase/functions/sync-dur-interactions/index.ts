import { handleCors } from "../_shared/cors.ts";
import { runDurSync } from "../_shared/dur_sync.ts";
import { errorResponse, json, readJson } from "../_shared/http.ts";
import { requireAdmin, requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  pageNo?: number;
  numOfRows?: number;
  itemSeq?: string;
  syncKnownMedications?: boolean;
  medicationLimit?: number;
  medicationOffset?: number;
  maxDurRowsPerMedication?: number;
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    await requireAdmin(serviceClient, user.id);

    const body = await readJson<RequestBody>(req);
    const result = await runDurSync(serviceClient, body, { userId: user.id });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
});
