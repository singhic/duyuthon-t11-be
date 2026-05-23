import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { HttpError } from "./http.ts";

export type SyncJobStatus = "running" | "succeeded" | "failed";

export type SyncJobRun = {
  id: string;
};

type StartSyncJobParams = {
  jobName: string;
  cursorOffset?: number | null;
  batchSize?: number | null;
  rawResult?: Record<string, unknown>;
};

type FinishSyncJobParams = {
  status: Exclude<SyncJobStatus, "running">;
  nextCursorOffset?: number | null;
  requestCount?: number;
  insertedOrUpdatedCount?: number;
  skippedCount?: number;
  errorMessage?: string | null;
  rawResult?: Record<string, unknown>;
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

export async function startSyncJobRun(
  serviceClient: SupabaseClient,
  params: StartSyncJobParams,
): Promise<SyncJobRun> {
  const { data, error } = await serviceClient
    .from("sync_job_runs")
    .insert({
      job_name: params.jobName,
      status: "running",
      cursor_offset: params.cursorOffset ?? null,
      batch_size: params.batchSize ?? null,
      raw_result: params.rawResult ?? {},
    })
    .select("id")
    .single();

  if (error) throw new HttpError(500, "Failed to start sync job run", error);
  return data;
}

export async function finishSyncJobRun(
  serviceClient: SupabaseClient,
  runId: string,
  params: FinishSyncJobParams,
): Promise<void> {
  const { error } = await serviceClient
    .from("sync_job_runs")
    .update({
      status: params.status,
      finished_at: new Date().toISOString(),
      next_cursor_offset: params.nextCursorOffset ?? null,
      request_count: params.requestCount ?? 0,
      inserted_or_updated_count: params.insertedOrUpdatedCount ?? 0,
      skipped_count: params.skippedCount ?? 0,
      error_message: params.errorMessage ?? null,
      raw_result: params.rawResult ?? {},
    })
    .eq("id", runId);

  if (error) throw new HttpError(500, "Failed to finish sync job run", error);
}

export async function lastSuccessfulNextCursor(
  serviceClient: SupabaseClient,
  jobName: string,
): Promise<number | null> {
  const { data, error } = await serviceClient
    .from("sync_job_runs")
    .select("next_cursor_offset")
    .eq("job_name", jobName)
    .eq("status", "succeeded")
    .not("next_cursor_offset", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to load last successful sync cursor", error);
  return typeof data?.next_cursor_offset === "number" ? data.next_cursor_offset : null;
}
