import { handleCors } from "../_shared/cors.ts";
import { runDurSync } from "../_shared/dur_sync.ts";
import { runDrugMasterSync } from "../_shared/drug_sync.ts";
import { errorResponse, HttpError, json, readJson, requireEnv } from "../_shared/http.ts";
import { runRedactExpiredSensitiveData } from "../_shared/redaction.ts";
import { runMedicationReminders } from "../_shared/reminders.ts";
import { createServiceClient } from "../_shared/supabase.ts";

type MaintenanceJob =
  | "sync_drug_master_page"
  | "sync_drug_master_item_seq"
  | "sync_dur_known_medications"
  | "send_medication_reminders"
  | "redact_expired_sensitive_data"
  | "operation_snapshot";

type RequestBody = {
  job?: MaintenanceJob;
  pageNo?: number;
  numOfRows?: number;
  itemName?: string;
  itemSeq?: string | number;
  itemSeqList?: Array<string | number>;
  skipExisting?: boolean;
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

async function exactCount(serviceClient: any, table: string, buildQuery: (query: any) => any = (query) => query): Promise<number> {
  const { count, error } = await buildQuery(
    serviceClient
      .from(table)
      .select("id", { count: "exact", head: true }),
  );
  if (error) throw new HttpError(500, `Failed to count ${table}`, error);
  return count ?? 0;
}

async function runOperationSnapshot(serviceClient: any): Promise<Record<string, unknown>> {
  const generatedAt = new Date().toISOString();

  const [
    recentSyncRuns,
    medicationCount,
    medicationWithItemSeqCount,
    missingEfficacyCount,
    missingDosageCount,
    missingPrecautionsCount,
    missingStorageMethodCount,
    drugInteractionCount,
    mfdsDurInteractionCount,
    notificationTokenCount,
    enabledNotificationTokenCount,
    deliveryPendingCount,
    deliverySentCount,
    deliveryFailedCount,
    deliverySkippedCount,
    reminderDryRun,
    redactionDryRun,
  ] = await Promise.all([
    serviceClient
      .from("sync_job_runs")
      .select("job_name,status,started_at,finished_at,cursor_offset,next_cursor_offset,batch_size,request_count,inserted_or_updated_count,skipped_count,error_message")
      .order("started_at", { ascending: false })
      .limit(10),
    exactCount(serviceClient, "medications"),
    exactCount(serviceClient, "medications", (query) => query.not("item_seq", "is", null)),
    exactCount(serviceClient, "medications", (query) => query.is("efficacy", null)),
    exactCount(serviceClient, "medications", (query) => query.is("dosage", null)),
    exactCount(serviceClient, "medications", (query) => query.is("precautions", null)),
    exactCount(serviceClient, "medications", (query) => query.is("storage_method", null)),
    exactCount(serviceClient, "drug_interactions"),
    exactCount(serviceClient, "drug_interactions", (query) => query.eq("source", "mfds_dur_usjnt_taboo")),
    exactCount(serviceClient, "notification_tokens"),
    exactCount(serviceClient, "notification_tokens", (query) => query.eq("enabled", true)),
    exactCount(serviceClient, "medication_notification_deliveries", (query) => query.eq("status", "pending")),
    exactCount(serviceClient, "medication_notification_deliveries", (query) => query.eq("status", "sent")),
    exactCount(serviceClient, "medication_notification_deliveries", (query) => query.eq("status", "failed")),
    exactCount(serviceClient, "medication_notification_deliveries", (query) => query.eq("status", "skipped")),
    runMedicationReminders({ dryRun: true }),
    runRedactExpiredSensitiveData(serviceClient, { dryRun: true }),
  ]);

  if (recentSyncRuns.error) {
    throw new HttpError(500, "Failed to load recent sync job runs", recentSyncRuns.error);
  }

  return {
    generatedAt,
    syncJobs: {
      recent: recentSyncRuns.data ?? [],
    },
    medications: {
      totalCount: medicationCount,
      withItemSeqCount: medicationWithItemSeqCount,
      missing: {
        efficacy: missingEfficacyCount,
        dosage: missingDosageCount,
        precautions: missingPrecautionsCount,
        storageMethod: missingStorageMethodCount,
      },
    },
    drugInteractions: {
      totalCount: drugInteractionCount,
      mfdsDurUsjntTabooCount: mfdsDurInteractionCount,
    },
    notifications: {
      tokenCount: notificationTokenCount,
      enabledTokenCount: enabledNotificationTokenCount,
      deliveryStatusCounts: {
        pending: deliveryPendingCount,
        sent: deliverySentCount,
        failed: deliveryFailedCount,
        skipped: deliverySkippedCount,
      },
      reminderDryRun,
    },
    redactionDryRun,
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
    } else if (body.job === "sync_drug_master_item_seq") {
      result = await runDrugMasterSync(serviceClient, {
        itemSeq: body.itemSeq,
        itemSeqList: body.itemSeqList,
        skipExisting: body.skipExisting,
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
    } else if (body.job === "operation_snapshot") {
      result = await runOperationSnapshot(serviceClient);
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
