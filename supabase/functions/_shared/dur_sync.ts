import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { HttpError, requireEnv } from "./http.ts";
import { logApiUsage } from "./supabase.ts";
import {
  errorMessage,
  finishSyncJobRun,
  lastSuccessfulNextCursor,
  startSyncJobRun,
} from "./sync_jobs.ts";

export type DurSyncRequest = {
  pageNo?: number;
  numOfRows?: number;
  itemSeq?: string;
  syncKnownMedications?: boolean;
  medicationLimit?: number;
  medicationOffset?: number;
  maxDurRowsPerMedication?: number;
};

type DurItem = Record<string, unknown>;

type SyncCounts = {
  apiItemCount: number;
  insertedOrUpdatedCount: number;
  skippedCount: number;
};

export type DurSyncResult = {
  mode: string;
  pageNo: number;
  numOfRows: number;
  itemSeq: string | null;
  syncKnownMedications: boolean;
  medicationLimit: number | null;
  medicationOffset: number | null;
  nextMedicationOffset: number | null;
  medicationBatchCount: number;
  medicationTotalCount: number | null;
  apiRequestCount: number;
  apiItemCount: number;
  insertedOrUpdatedCount: number;
  skippedCount: number;
  syncJobRunId: string;
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function text(item: DurItem, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key] ?? item[key.toLowerCase()];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function normalizeIngredientName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function medicationIngredientsByItemSeq(
  serviceClient: SupabaseClient,
  itemSeq: string | null,
): Promise<string[]> {
  if (!itemSeq) return [];

  const { data: medication, error: medError } = await serviceClient
    .from("medications")
    .select("id")
    .eq("item_seq", itemSeq)
    .maybeSingle();

  if (medError) throw new HttpError(500, "Failed to load medication by item_seq", medError);
  if (!medication) return [];

  const { data: rows, error } = await serviceClient
    .from("medication_ingredients")
    .select("ingredient_id")
    .eq("medication_id", medication.id);

  if (error) throw new HttpError(500, "Failed to load medication ingredients", error);
  return [...new Set((rows ?? []).map((row) => row.ingredient_id))];
}

async function ingredientIdByName(
  serviceClient: SupabaseClient,
  name: string | null,
): Promise<string | null> {
  if (!name) return null;
  const normalizedName = normalizeIngredientName(name);
  const { data: existing, error: loadError } = await serviceClient
    .from("ingredients")
    .select("id")
    .eq("normalized_name", normalizedName)
    .maybeSingle();

  if (loadError) throw new HttpError(500, "Failed to load ingredient", loadError);
  if (existing) return existing.id;

  const { data: inserted, error: insertError } = await serviceClient
    .from("ingredients")
    .insert({ name })
    .select("id")
    .single();

  if (insertError) throw new HttpError(500, "Failed to create ingredient", insertError);
  return inserted.id;
}

async function ingredientIdsForDurSide(
  serviceClient: SupabaseClient,
  itemSeq: string | null,
  ingredientName: string | null,
): Promise<string[]> {
  const fromMedication = await medicationIngredientsByItemSeq(serviceClient, itemSeq);
  if (fromMedication.length > 0) return fromMedication;

  const ingredientId = await ingredientIdByName(serviceClient, ingredientName);
  return ingredientId ? [ingredientId] : [];
}

async function fetchDurItems(params: {
  endpoint: string;
  serviceKey: string;
  pageNo: number;
  numOfRows: number;
  itemSeq?: string | null;
}): Promise<DurItem[]> {
  const query = new URLSearchParams({
    serviceKey: params.serviceKey,
    pageNo: String(params.pageNo),
    numOfRows: String(params.numOfRows),
    type: "json",
  });

  if (params.itemSeq) {
    query.set("itemSeq", params.itemSeq);
  }

  const response = await fetch(`${params.endpoint}?${query.toString()}`);
  const responseText = await response.text();
  let apiBody: any;
  try {
    apiBody = JSON.parse(responseText);
  } catch {
    throw new HttpError(response.ok ? 502 : response.status, "DUR interaction API returned non-JSON response", {
      status: response.status,
      bodyPreview: responseText.slice(0, 500),
    });
  }

  if (!response.ok) {
    throw new HttpError(response.status, "DUR interaction API request failed", apiBody);
  }

  return asArray<DurItem>(
    apiBody?.body?.items?.item ?? apiBody?.body?.items ?? apiBody?.response?.body?.items?.item,
  );
}

async function upsertDurItems(
  serviceClient: SupabaseClient,
  endpoint: string,
  items: DurItem[],
): Promise<SyncCounts> {
  let apiItemCount = 0;
  let insertedOrUpdatedCount = 0;
  let skippedCount = 0;

  for (const item of items) {
    apiItemCount += 1;
    const itemSeqA = text(item, "ITEM_SEQ", "ItemSeq", "itemSeq", "ITEM_SEQ_A", "MIXTURE_ITEM_SEQ1");
    const itemSeqB = text(
      item,
      "MIXTURE_ITEM_SEQ",
      "MIXTURE_ITEMSEQ",
      "MIXTURE_ITEM_SEQ2",
      "USJNT_TABOO_ITEM_SEQ",
      "TARGET_ITEM_SEQ",
    );
    const ingredientNameA = text(item, "INGR_KOR_NAME", "INGR_NAME", "INGREDIENT_NAME", "MATERIAL_NAME");
    const ingredientNameB = text(
      item,
      "MIXTURE_INGR_KOR_NAME",
      "MIXTURE_INGR_NAME",
      "USJNT_TABOO_INGR_KOR_NAME",
      "TARGET_INGR_NAME",
    );
    const itemNameA = text(item, "ITEM_NAME", "PRDLST_NM");
    const itemNameB = text(item, "MIXTURE_ITEM_NAME", "USJNT_TABOO_ITEM_NAME", "TARGET_ITEM_NAME");
    const description = text(
      item,
      "PROHBT_CONTENT",
      "TABOO_CONTENT",
      "DUR_CONTENT",
      "REMARK",
      "NOTE",
    ) ?? "식품의약품안전처 DUR 병용금기 정보에 등록된 조합입니다.";
    const externalSourceId = text(item, "DUR_SEQ", "SEQ", "NO") ?? [itemSeqA, itemSeqB, ingredientNameA, ingredientNameB]
      .filter(Boolean)
      .join(":");

    const ingredientIdsA = await ingredientIdsForDurSide(serviceClient, itemSeqA, ingredientNameA);
    const ingredientIdsB = await ingredientIdsForDurSide(serviceClient, itemSeqB, ingredientNameB);

    if (ingredientIdsA.length === 0 || ingredientIdsB.length === 0) {
      skippedCount += 1;
      continue;
    }

    for (const ingredientA of ingredientIdsA) {
      for (const ingredientB of ingredientIdsB) {
        if (ingredientA === ingredientB) continue;
        const { error } = await serviceClient
          .from("drug_interactions")
          .upsert({
            ingredient_a_id: ingredientA,
            ingredient_b_id: ingredientB,
            severity: "contraindicated",
            description,
            recommendation: "DUR 병용금기 조합입니다. 함께 복용하기 전 의사 또는 약사에게 반드시 확인하세요.",
            source: "mfds_dur_usjnt_taboo",
            source_url: endpoint,
            external_source_id: externalSourceId || null,
            raw_source: {
              ...item,
              parsedItemNameA: itemNameA,
              parsedItemNameB: itemNameB,
              parsedIngredientNameA: ingredientNameA,
              parsedIngredientNameB: ingredientNameB,
            },
            updated_at: new Date().toISOString(),
          }, { onConflict: "ingredient_a_id,ingredient_b_id" });

        if (error) throw new HttpError(500, "Failed to upsert DUR interaction", error);
        insertedOrUpdatedCount += 1;
      }
    }
  }

  return { apiItemCount, insertedOrUpdatedCount, skippedCount };
}

function nextOffset(currentOffset: number, batchCount: number, totalCount: number | null): number {
  const next = currentOffset + batchCount;
  if (totalCount !== null && next >= totalCount) return 0;
  return next;
}

export async function runDurSync(
  serviceClient: SupabaseClient,
  body: DurSyncRequest,
  options: { userId?: string | null; resumeOffset?: boolean } = {},
): Promise<DurSyncResult> {
  const pageNo = body.pageNo ?? 1;
  const numOfRows = Math.min(body.numOfRows ?? 100, 500);
  const endpoint = "https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getUsjntTabooInfoList03";
  const medicationLimit = clamp(body.medicationLimit ?? 20, 1, 50);
  const resolvedOffset = body.medicationOffset ?? (
    options.resumeOffset && body.syncKnownMedications
      ? (await lastSuccessfulNextCursor(serviceClient, "sync_dur_known_medications")) ?? 0
      : 0
  );
  const medicationOffset = Math.max(resolvedOffset, 0);
  const mode = body.syncKnownMedications ? "known_medications" : body.itemSeq ? "item_seq" : "page";
  const run = await startSyncJobRun(serviceClient, {
    jobName: body.syncKnownMedications ? "sync_dur_known_medications" : "sync_dur_interactions",
    cursorOffset: body.syncKnownMedications ? medicationOffset : pageNo,
    batchSize: body.syncKnownMedications ? medicationLimit : numOfRows,
    rawResult: {
      itemSeq: body.itemSeq ?? null,
      syncKnownMedications: Boolean(body.syncKnownMedications),
    },
  });

  let apiRequestCount = 0;
  let apiItemCount = 0;
  let insertedOrUpdatedCount = 0;
  let skippedCount = 0;
  let medicationBatchCount = 0;
  let medicationTotalCount: number | null = null;

  try {
    const serviceKey = requireEnv("DATA_GO_KR_SERVICE_KEY");

    if (body.syncKnownMedications) {
      const maxDurRowsPerMedication = clamp(body.maxDurRowsPerMedication ?? 100, 1, 500);
      const { data: medications, error: medicationsError, count } = await serviceClient
        .from("medications")
        .select("item_seq,item_name", { count: "exact" })
        .not("item_seq", "is", null)
        .order("item_seq", { ascending: true })
        .range(medicationOffset, medicationOffset + medicationLimit - 1);

      if (medicationsError) {
        throw new HttpError(500, "Failed to load known medications for DUR sync", medicationsError);
      }

      medicationBatchCount = medications?.length ?? 0;
      medicationTotalCount = count ?? null;

      for (const medication of medications ?? []) {
        if (!medication.item_seq) continue;
        const items = await fetchDurItems({
          endpoint,
          serviceKey,
          pageNo: 1,
          numOfRows: maxDurRowsPerMedication,
          itemSeq: medication.item_seq,
        });
        apiRequestCount += 1;

        const result = await upsertDurItems(serviceClient, endpoint, items);
        apiItemCount += result.apiItemCount;
        insertedOrUpdatedCount += result.insertedOrUpdatedCount;
        skippedCount += result.skippedCount;
      }
    } else {
      const items = await fetchDurItems({
        endpoint,
        serviceKey,
        pageNo,
        numOfRows,
        itemSeq: body.itemSeq,
      });
      apiRequestCount = 1;

      const result = await upsertDurItems(serviceClient, endpoint, items);
      apiItemCount = result.apiItemCount;
      insertedOrUpdatedCount = result.insertedOrUpdatedCount;
      skippedCount = result.skippedCount;
    }

    const nextMedicationOffset = body.syncKnownMedications
      ? nextOffset(medicationOffset, medicationBatchCount, medicationTotalCount)
      : null;
    const response: DurSyncResult = {
      mode,
      pageNo,
      numOfRows,
      itemSeq: body.itemSeq ?? null,
      syncKnownMedications: Boolean(body.syncKnownMedications),
      medicationLimit: body.syncKnownMedications ? medicationLimit : null,
      medicationOffset: body.syncKnownMedications ? medicationOffset : null,
      nextMedicationOffset,
      medicationBatchCount,
      medicationTotalCount,
      apiRequestCount,
      apiItemCount,
      insertedOrUpdatedCount,
      skippedCount,
      syncJobRunId: run.id,
    };

    await logApiUsage(serviceClient, {
      userId: options.userId ?? undefined,
      provider: "data_go_kr",
      endpoint: "getUsjntTabooInfoList03",
      requestCount: Math.max(apiRequestCount, 1),
    });
    await finishSyncJobRun(serviceClient, run.id, {
      status: "succeeded",
      nextCursorOffset: body.syncKnownMedications ? nextMedicationOffset : pageNo + 1,
      requestCount: Math.max(apiRequestCount, 1),
      insertedOrUpdatedCount,
      skippedCount,
      rawResult: response,
    });

    return response;
  } catch (error) {
    await finishSyncJobRun(serviceClient, run.id, {
      status: "failed",
      nextCursorOffset: body.syncKnownMedications ? medicationOffset : pageNo,
      requestCount: apiRequestCount,
      insertedOrUpdatedCount,
      skippedCount,
      errorMessage: errorMessage(error),
      rawResult: {
        mode,
        pageNo,
        numOfRows,
        itemSeq: body.itemSeq ?? null,
        syncKnownMedications: Boolean(body.syncKnownMedications),
        medicationLimit: body.syncKnownMedications ? medicationLimit : null,
        medicationOffset: body.syncKnownMedications ? medicationOffset : null,
        medicationBatchCount,
        medicationTotalCount,
        apiRequestCount,
        apiItemCount,
        insertedOrUpdatedCount,
        skippedCount,
      },
    });
    throw error;
  }
}
