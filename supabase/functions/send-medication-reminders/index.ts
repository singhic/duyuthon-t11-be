import { handleCors } from "../_shared/cors.ts";
import { errorResponse, json, readJson } from "../_shared/http.ts";
import { runMedicationReminders } from "../_shared/reminders.ts";
import { requireRestAdmin, requireRestUser } from "../_shared/rest.ts";

type RequestBody = {
  windowStart?: string;
  windowEnd?: string;
  targetUserId?: string;
  dryRun?: boolean;
  includeReminders?: boolean;
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const user = await requireRestUser(req);
    await requireRestAdmin(user.id);

    const body = await readJson<RequestBody>(req);
    const result = await runMedicationReminders(body);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
});
