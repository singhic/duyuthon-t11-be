import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchDrugItems, upsertDrugApiItems } from "./drug_master.ts";
import { logApiUsage } from "./supabase.ts";
import { errorMessage, finishSyncJobRun, startSyncJobRun } from "./sync_jobs.ts";

export type DrugMasterSyncRequest = {
  pageNo?: number;
  numOfRows?: number;
  itemName?: string;
};

export type DrugMasterSyncResult = {
  pageNo: number;
  numOfRows: number;
  medicationCount: number;
  ingredientCount: number;
  syncJobRunId: string;
};

export async function runDrugMasterSync(
  serviceClient: SupabaseClient,
  body: DrugMasterSyncRequest,
  options: { userId?: string | null } = {},
): Promise<DrugMasterSyncResult> {
  const pageNo = body.pageNo ?? 1;
  const numOfRows = Math.min(body.numOfRows ?? 100, 500);
  const run = await startSyncJobRun(serviceClient, {
    jobName: "sync_drug_master_page",
    cursorOffset: pageNo,
    batchSize: numOfRows,
    rawResult: {
      itemName: body.itemName ?? null,
    },
  });

  try {
    const items = await fetchDrugItems({
      itemName: body.itemName,
      pageNo,
      numOfRows,
    });
    const result = await upsertDrugApiItems(serviceClient, items);
    const response = {
      pageNo,
      numOfRows,
      medicationCount: result.medicationCount,
      ingredientCount: result.ingredientCount,
      syncJobRunId: run.id,
    };

    await logApiUsage(serviceClient, {
      userId: options.userId ?? undefined,
      provider: "data_go_kr",
      endpoint: "getDrugPrdtPrmsnDtlInq06",
      requestCount: 1,
    });
    await finishSyncJobRun(serviceClient, run.id, {
      status: "succeeded",
      nextCursorOffset: pageNo + 1,
      requestCount: 1,
      insertedOrUpdatedCount: result.medicationCount + result.ingredientCount,
      skippedCount: 0,
      rawResult: response,
    });

    return response;
  } catch (error) {
    await finishSyncJobRun(serviceClient, run.id, {
      status: "failed",
      nextCursorOffset: pageNo,
      errorMessage: errorMessage(error),
      rawResult: {
        pageNo,
        numOfRows,
        itemName: body.itemName ?? null,
      },
    });
    throw error;
  }
}
