import { handleCors } from "../_shared/cors.ts";
import { runDurSync } from "../_shared/dur_sync.ts";
import { runDrugMasterSync } from "../_shared/drug_sync.ts";
import { errorResponse, HttpError, json, readJson, requireEnv } from "../_shared/http.ts";
import { runRedactExpiredSensitiveData } from "../_shared/redaction.ts";
import { runMedicationReminders } from "../_shared/reminders.ts";
import { createServiceClient } from "../_shared/supabase.ts";

type MaintenanceJob =
  | "sync_drug_master_page"
  | "sync_dur_known_medications"
  | "send_medication_reminders"
  | "redact_expired_sensitive_data";

type RequestBody = {
  job?: MaintenanceJob;
  pageNo?: number;
  numOfRows?: number;
  itemName?: string;
  medicationLimit?: number;
  medicationOffset?: number;
  maxDurRowsPerMedication?: number;
  windowStart?: string;
  windowEnd?: string;
  windowMinutes?: number;
  targetUserId?: string;
  dryRun?: boolean;
  includeReminders?: boolean;
};

function requireCronSecret(req: Request): void {
  const expected = requireEnv("CRON_SECRET");
  const actual = req.headers.get("x-cron-secret");
  if (!actual || actual !== expected) {
    throw new HttpError(401, "Invalid or missing cron secret");
  }
}

function reminderWindow(body: RequestBody): { windowStart?: string; windowEnd?: string } {
  if (body.windowEnd) {
    return {
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
    };
  }

  if (!body.windowMinutes) {
    return {
      windowStart: body.windowStart,
    };
  }

  const windowStartDate = body.windowStart ? new Date(body.windowStart) : new Date();
  const windowEndDate = new Date(windowStartDate.getTime() + body.windowMinutes * 60 * 1000);
  return {
    windowStart: windowStartDate.toISOString(),
    windowEnd: windowEndDate.toISOString(),
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    requireCronSecret(req);

    const body = await readJson<RequestBody>(req);
    if (!body.job) throw new HttpError(400, "job is required");

    const serviceClient = createServiceClient();
    let result: unknown;

    if (body.job === "sync_drug_master_page") {
      result = await runDrugMasterSync(serviceClient, {
        pageNo: body.pageNo,
        numOfRows: body.numOfRows,
        itemName: body.itemName,
      });
    } else if (body.job === "sync_dur_known_medications") {
      result = await runDurSync(serviceClient, {
        syncKnownMedications: true,
        medicationLimit: body.medicationLimit,
        medicationOffset: body.medicationOffset,
        maxDurRowsPerMedication: body.maxDurRowsPerMedication,
      }, { resumeOffset: true });
    } else if (body.job === "send_medication_reminders") {
      const window = reminderWindow(body);
      result = await runMedicationReminders({
        ...window,
        targetUserId: body.targetUserId,
        dryRun: body.dryRun ?? true,
        includeReminders: body.includeReminders,
      });
    } else if (body.job === "redact_expired_sensitive_data") {
      result = await runRedactExpiredSensitiveData(serviceClient, {
        dryRun: body.dryRun ?? true,
      });
    } else {
      throw new HttpError(400, "Unsupported maintenance job");
    }

    return json({
      job: body.job,
      result,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
