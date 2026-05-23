import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type RedactExpiredSensitiveDataRequest = {
  dryRun?: boolean;
};

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

export async function runRedactExpiredSensitiveData(
  serviceClient: SupabaseClient,
  body: RedactExpiredSensitiveDataRequest,
  options: { actorUserId?: string | null } = {},
): Promise<Record<string, unknown>> {
  const dryRun = body.dryRun ?? true;
  const now = new Date().toISOString();

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

  await serviceClient.from("audit_logs").insert({
    actor_user_id: options.actorUserId ?? null,
    action: "redact_expired_sensitive_data",
    target_type: "maintenance",
    metadata: {
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
      scanOcrTextCount,
      ocrResultCount,
      chatMessageCount,
    },
  };
}
