import { handleCors } from "../_shared/cors.ts";
import { errorResponse, json, readJson } from "../_shared/http.ts";
import { runDrugMasterSync } from "../_shared/drug_sync.ts";
import { requireAdmin, requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  pageNo?: number;
  numOfRows?: number;
  itemName?: string;
  itemSeq?: string | number;
  itemSeqList?: Array<string | number>;
  skipExisting?: boolean;
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    await requireAdmin(serviceClient, user.id);

    const body = await readJson<RequestBody>(req);
    const result = await runDrugMasterSync(serviceClient, body, { userId: user.id });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
});
