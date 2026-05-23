import { handleCors } from "../_shared/cors.ts";
import { fetchDrugItems, upsertDrugApiItems } from "../_shared/drug_master.ts";
import { errorResponse, json, readJson } from "../_shared/http.ts";
import { logApiUsage, requireAdmin, requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  pageNo?: number;
  numOfRows?: number;
  itemName?: string;
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    await requireAdmin(serviceClient, user.id);

    const body = await readJson<RequestBody>(req);
    const pageNo = body.pageNo ?? 1;
    const numOfRows = Math.min(body.numOfRows ?? 100, 500);
    const items = await fetchDrugItems({
      itemName: body.itemName,
      pageNo,
      numOfRows,
    });
    const result = await upsertDrugApiItems(serviceClient, items);

    await logApiUsage(serviceClient, {
      userId: user.id,
      provider: "data_go_kr",
      endpoint: "getDrugPrdtPrmsnDtlInq06",
      requestCount: 1,
    });

    return json({
      pageNo,
      numOfRows,
      medicationCount: result.medicationCount,
      ingredientCount: result.ingredientCount,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
