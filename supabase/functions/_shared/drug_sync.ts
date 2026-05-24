import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchDrugItems, fetchDrugItemsByItemSeq, upsertDrugApiItems } from "./drug_master.ts";
import type { DrugApiItem } from "./drug_master.ts";
import { HttpError } from "./http.ts";
import { logApiUsage } from "./supabase.ts";
import { errorMessage, finishSyncJobRun, startSyncJobRun } from "./sync_jobs.ts";

export type DrugMasterSyncRequest = {
  pageNo?: number;
  numOfRows?: number;
  itemName?: string;
  itemSeq?: string | number;
  itemSeqList?: Array<string | number>;
  skipExisting?: boolean;
};

export type DrugMasterSyncResult = {
  mode: "page" | "item_name" | "item_seq_list";
  pageNo: number;
  numOfRows: number;
  medicationCount: number;
  ingredientCount: number;
  requestedItemSeqCount: number;
  fetchedItemCount: number;
  skippedExistingItemSeqs: string[];
  missingItemSeqs: string[];
  invalidItemSeqs: string[];
  syncJobRunId: string;
};

const MAX_ITEM_SEQ_LIST_SIZE = 100;
const ITEM_SEQ_FETCH_CONCURRENCY = 5;

function normalizeItemSeq(value: string | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return /^\d{9}$/.test(normalized) ? normalized : null;
}

function uniqueItemSeqs(body: DrugMasterSyncRequest): {
  valid: string[];
  invalid: string[];
} {
  const values = [
    body.itemSeq,
    ...(Array.isArray(body.itemSeqList) ? body.itemSeqList : []),
  ];
  const valid = new Set<string>();
  const invalid = new Set<string>();

  for (const value of values) {
    if (value === undefined || value === null || String(value).trim() === "") continue;
    const normalized = normalizeItemSeq(value);
    if (normalized) {
      valid.add(normalized);
    } else {
      invalid.add(String(value).trim());
    }
  }

  return {
    valid: [...valid],
    invalid: [...invalid],
  };
}

async function filterExistingItemSeqs(
  serviceClient: SupabaseClient,
  itemSeqs: string[],
): Promise<{ pending: string[]; skipped: string[] }> {
  if (itemSeqs.length === 0) {
    return {
      pending: [],
      skipped: [],
    };
  }

  const { data, error } = await serviceClient
    .from("medications")
    .select("item_seq")
    .in("item_seq", itemSeqs);

  if (error) throw new HttpError(500, "Failed to load existing medications by item_seq", error);

  const existing = new Set((data ?? []).map((row) => row.item_seq).filter(Boolean));
  return {
    pending: itemSeqs.filter((itemSeq) => !existing.has(itemSeq)),
    skipped: itemSeqs.filter((itemSeq) => existing.has(itemSeq)),
  };
}

async function fetchItemsByItemSeqs(itemSeqs: string[]): Promise<DrugApiItem[]> {
  const items: DrugApiItem[] = [];
  for (let index = 0; index < itemSeqs.length; index += ITEM_SEQ_FETCH_CONCURRENCY) {
    const batch = itemSeqs.slice(index, index + ITEM_SEQ_FETCH_CONCURRENCY);
    const responses = await Promise.all(batch.map((itemSeq) => fetchDrugItemsByItemSeq(itemSeq)));
    items.push(...responses.flat());
  }
  return items;
}

export async function runDrugMasterSync(
  serviceClient: SupabaseClient,
  body: DrugMasterSyncRequest,
  options: { userId?: string | null } = {},
): Promise<DrugMasterSyncResult> {
  const requestedItemSeqs = uniqueItemSeqs(body);
  if (requestedItemSeqs.valid.length > MAX_ITEM_SEQ_LIST_SIZE) {
    throw new HttpError(400, `itemSeqList supports up to ${MAX_ITEM_SEQ_LIST_SIZE} item_seq values per request`, {
      requestedItemSeqCount: requestedItemSeqs.valid.length,
    });
  }
  if (requestedItemSeqs.invalid.length > 0 && requestedItemSeqs.valid.length === 0) {
    throw new HttpError(400, "No valid item_seq values were provided", {
      invalidItemSeqs: requestedItemSeqs.invalid,
    });
  }

  const mode = requestedItemSeqs.valid.length > 0
    ? "item_seq_list"
    : body.itemName
    ? "item_name"
    : "page";
  const pageNo = body.pageNo ?? 1;
  const numOfRows = requestedItemSeqs.valid.length > 0
    ? requestedItemSeqs.valid.length
    : Math.min(body.numOfRows ?? 100, 500);
  const run = await startSyncJobRun(serviceClient, {
    jobName: mode === "item_seq_list" ? "sync_drug_master_item_seq" : "sync_drug_master_page",
    cursorOffset: pageNo,
    batchSize: numOfRows,
    rawResult: {
      mode,
      itemName: body.itemName ?? null,
      requestedItemSeqCount: requestedItemSeqs.valid.length,
      skipExisting: body.skipExisting ?? false,
    },
  });

  try {
    let items: DrugApiItem[] = [];
    let requestCount = 1;
    let skippedExistingItemSeqs: string[] = [];
    let missingItemSeqs: string[] = [];

    if (requestedItemSeqs.valid.length > 0) {
      const filtered = body.skipExisting
        ? await filterExistingItemSeqs(serviceClient, requestedItemSeqs.valid)
        : {
          pending: requestedItemSeqs.valid,
          skipped: [],
        };
      skippedExistingItemSeqs = filtered.skipped;
      requestCount = filtered.pending.length;

      items = await fetchItemsByItemSeqs(filtered.pending);

      const foundItemSeqs = new Set(
        items
          .map((item) => item.ITEM_SEQ ?? item.item_seq)
          .filter((itemSeq): itemSeq is string => Boolean(itemSeq)),
      );
      missingItemSeqs = filtered.pending.filter((itemSeq) => !foundItemSeqs.has(itemSeq));
    } else {
      items = await fetchDrugItems({
        itemName: body.itemName,
        pageNo,
        numOfRows,
      });
    }

    const result = await upsertDrugApiItems(serviceClient, items);
    const response = {
      mode,
      pageNo,
      numOfRows,
      medicationCount: result.medicationCount,
      ingredientCount: result.ingredientCount,
      requestedItemSeqCount: requestedItemSeqs.valid.length,
      fetchedItemCount: items.length,
      skippedExistingItemSeqs,
      missingItemSeqs,
      invalidItemSeqs: requestedItemSeqs.invalid,
      syncJobRunId: run.id,
    };

    if (requestCount > 0) {
      await logApiUsage(serviceClient, {
        userId: options.userId ?? undefined,
        provider: "data_go_kr",
        endpoint: "getDrugPrdtPrmsnDtlInq06",
        requestCount,
      });
    }
    await finishSyncJobRun(serviceClient, run.id, {
      status: "succeeded",
      nextCursorOffset: mode === "item_seq_list" ? pageNo : pageNo + 1,
      requestCount,
      insertedOrUpdatedCount: result.medicationCount + result.ingredientCount,
      skippedCount: skippedExistingItemSeqs.length + missingItemSeqs.length + requestedItemSeqs.invalid.length,
      rawResult: response,
    });

    return response;
  } catch (error) {
    await finishSyncJobRun(serviceClient, run.id, {
      status: "failed",
      nextCursorOffset: pageNo,
      errorMessage: errorMessage(error),
      rawResult: {
        mode,
        pageNo,
        numOfRows,
        itemName: body.itemName ?? null,
        requestedItemSeqCount: requestedItemSeqs.valid.length,
        invalidItemSeqs: requestedItemSeqs.invalid,
      },
    });
    throw error;
  }
}
