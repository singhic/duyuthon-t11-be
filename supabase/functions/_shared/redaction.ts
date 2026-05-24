import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type RedactExpiredSensitiveDataRequest = {
  dryRun?: boolean;
};

type ExpiredScanImage = {
  id: string;
  image_path: string;
};

const SCAN_IMAGE_STORAGE_BUCKET = "prescription-temp";
const SCAN_IMAGE_DELETE_CHUNK_SIZE = 100;
const SCAN_IMAGE_QUERY_PAGE_SIZE = 1000;
const FAILED_IMAGE_PATH_SAMPLE_LIMIT = 20;

async function countRows(
  serviceClient: SupabaseClient,
  table: string,
  buildQuery: (query: any) => any,
): Promise<number> {
  const { count, error } = await buildQuery(
    serviceClient
      .from(table)
      .select("id", { count: "exact", head: true }),
  );
  if (error) throw error;
  return count ?? 0;
}

async function loadExpiredScanImages(
  serviceClient: SupabaseClient,
  now: string,
): Promise<ExpiredScanImage[]> {
  const rows: ExpiredScanImage[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await serviceClient
      .from("scan_sessions")
      .select("id,image_path")
      .lte("expires_at", now)
      .is("image_deleted_at", null)
      .not("image_path", "is", null)
      .order("expires_at", { ascending: true })
      .range(from, from + SCAN_IMAGE_QUERY_PAGE_SIZE - 1);

    if (error) throw error;

    const page = (data ?? [])
      .filter((row): row is ExpiredScanImage =>
        typeof row.id === "string" &&
        typeof row.image_path === "string" &&
        row.image_path.length > 0
      );

    rows.push(...page);

    if ((data ?? []).length < SCAN_IMAGE_QUERY_PAGE_SIZE) break;
    from += SCAN_IMAGE_QUERY_PAGE_SIZE;
  }

  return rows;
}

function chunkRows<T>(rows: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

async function deleteExpiredScanImages(
  serviceClient: SupabaseClient,
  rows: ExpiredScanImage[],
  deletedAt: string,
): Promise<{
  scanImageDeletedCount: number;
  scanImageFailedCount: number;
  failedScanImagePaths: string[];
}> {
  let scanImageDeletedCount = 0;
  const failedScanImagePaths: string[] = [];

  for (const chunk of chunkRows(rows, SCAN_IMAGE_DELETE_CHUNK_SIZE)) {
    const paths = chunk.map((row) => row.image_path);
    const ids = chunk.map((row) => row.id);

    const { error: storageError } = await serviceClient.storage
      .from(SCAN_IMAGE_STORAGE_BUCKET)
      .remove(paths);

    if (storageError) {
      failedScanImagePaths.push(...paths);
      continue;
    }

    const { error: updateError } = await serviceClient
      .from("scan_sessions")
      .update({
        image_path: null,
        image_deleted_at: deletedAt,
      })
      .in("id", ids)
      .is("image_deleted_at", null)
      .not("image_path", "is", null);

    if (updateError) {
      failedScanImagePaths.push(...paths);
      continue;
    }

    scanImageDeletedCount += chunk.length;
  }

  return {
    scanImageDeletedCount,
    scanImageFailedCount: rows.length - scanImageDeletedCount,
    failedScanImagePaths: failedScanImagePaths.slice(0, FAILED_IMAGE_PATH_SAMPLE_LIMIT),
  };
}

export async function runRedactExpiredSensitiveData(
  serviceClient: SupabaseClient,
  body: RedactExpiredSensitiveDataRequest,
  options: { actorUserId?: string | null } = {},
): Promise<Record<string, unknown>> {
  const dryRun = body.dryRun ?? true;
  const now = new Date().toISOString();

  const expiredScanImages = await loadExpiredScanImages(serviceClient, now);
  const scanImageCount = expiredScanImages.length;
  const scanOcrTextCount = await countRows(
    serviceClient,
    "scan_sessions",
    (query) => query.lte("expires_at", now).is("ocr_text_deleted_at", null).not("ocr_text", "is", null),
  );
  const ocrResultCount = await countRows(
    serviceClient,
    "ocr_jobs",
    (query) => query.lte("expires_at", now).is("result_deleted_at", null),
  );
  const { data: expiredSessions, error: sessionLoadError } = await serviceClient
    .from("chat_sessions")
    .select("id")
    .lte("expires_at", now);
  if (sessionLoadError) throw sessionLoadError;

  const expiredSessionIds = (expiredSessions ?? []).map((row) => row.id);
  const chatMessageCount = expiredSessionIds.length > 0
    ? await countRows(
      serviceClient,
      "chat_messages",
      (query) => query.is("redacted_at", null).in("chat_session_id", expiredSessionIds),
    )
    : 0;

  if (dryRun) {
    return {
      dryRun,
      scannedAt: now,
      targets: {
        scanImageCount,
        scanOcrTextCount,
        ocrResultCount,
        chatMessageCount,
      },
      message: "dryRun=true 이므로 실제 민감정보는 삭제하지 않았습니다.",
    };
  }

  const { error: scanError } = await serviceClient
    .from("scan_sessions")
    .update({
      ocr_text: null,
      ocr_text_deleted_at: now,
    })
    .lte("expires_at", now)
    .is("ocr_text_deleted_at", null)
    .not("ocr_text", "is", null);
  if (scanError) throw scanError;

  const { error: ocrError } = await serviceClient
    .from("ocr_jobs")
    .update({
      result_json: {},
      result_deleted_at: now,
    })
    .lte("expires_at", now)
    .is("result_deleted_at", null);
  if (ocrError) throw ocrError;

  if (expiredSessionIds.length > 0) {
    const { error: chatError } = await serviceClient
      .from("chat_messages")
      .update({
        content: "[redacted]",
        citations: {},
        redacted_at: now,
      })
      .in("chat_session_id", expiredSessionIds)
      .is("redacted_at", null);
    if (chatError) throw chatError;
  }

  const {
    scanImageDeletedCount,
    scanImageFailedCount,
    failedScanImagePaths,
  } = await deleteExpiredScanImages(serviceClient, expiredScanImages, now);

  await serviceClient.from("audit_logs").insert({
    actor_user_id: options.actorUserId ?? null,
    action: "redact_expired_sensitive_data",
    target_type: "maintenance",
    metadata: {
      scanImageCount,
      scanImageDeletedCount,
      scanImageFailedCount,
      failedScanImagePaths,
      scanOcrTextCount,
      ocrResultCount,
      chatMessageCount,
    },
    severity: "info",
  });

  return {
    dryRun,
    redactedAt: now,
    redacted: {
      scanImageCount,
      scanImageDeletedCount,
      scanImageFailedCount,
      failedScanImagePaths,
      scanOcrTextCount,
      ocrResultCount,
      chatMessageCount,
    },
  };
}
