import { getGoogleServiceAccountAccessToken, getGoogleServiceAccountProjectId } from "./google.ts";
import { HttpError } from "./http.ts";
import { restRpc, restWriteSingle } from "./rest.ts";

export type ReminderRequest = {
  windowStart?: string;
  windowEnd?: string;
  targetUserId?: string;
  dryRun?: boolean;
  includeReminders?: boolean;
};

type Reminder = {
  delivery_id?: string;
  user_id: string;
  token_id: string;
  token: string;
  provider: "fcm" | "apns";
  platform: string | null;
  schedule_id: string;
  user_medication_id: string;
  medication_id: string;
  medication_name: string;
  take_time: string;
  planned_date: string;
  planned_time: string;
  dose_amount: number | null;
  dose_unit: string | null;
};

type SendResult = {
  deliveryId?: string;
  tokenId: string;
  ok: boolean;
  messageId?: string;
  error?: string;
  status?: "sent" | "failed" | "skipped";
};

function getFcmProjectId(): string {
  const projectId = Deno.env.get("FCM_PROJECT_ID") ?? getGoogleServiceAccountProjectId();
  if (!projectId) {
    throw new HttpError(500, "FCM_PROJECT_ID is required or GOOGLE_SERVICE_ACCOUNT_JSON must include project_id");
  }
  return projectId;
}

function buildFcmMessage(reminder: Reminder): Record<string, unknown> {
  const dose = reminder.dose_amount && reminder.dose_unit
    ? ` ${reminder.dose_amount}${reminder.dose_unit}`
    : "";

  return {
    token: reminder.token,
    notification: {
      title: "복약 시간입니다",
      body: `${reminder.medication_name}${dose} 복용 시간을 확인해 주세요.`,
    },
    data: {
      type: "medication_reminder",
      scheduleId: reminder.schedule_id,
      userMedicationId: reminder.user_medication_id,
      medicationId: reminder.medication_id,
      plannedDate: reminder.planned_date,
      plannedTime: reminder.planned_time ?? reminder.take_time,
    },
    android: {
      priority: "HIGH",
      notification: {
        channel_id: "medication_reminders",
        click_action: "MEDICATION_REMINDER",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    webpush: {
      notification: {
        icon: "/icon-192.png",
      },
    },
  };
}

async function sendFcmReminder(projectId: string, accessToken: string, reminder: Reminder): Promise<SendResult> {
  if (reminder.provider !== "fcm") {
    return {
      deliveryId: reminder.delivery_id,
      tokenId: reminder.token_id,
      ok: false,
      error: `Unsupported notification provider: ${reminder.provider}`,
      status: "skipped",
    };
  }

  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: buildFcmMessage(reminder),
    }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    return {
      deliveryId: reminder.delivery_id,
      tokenId: reminder.token_id,
      ok: false,
      error: typeof body?.error === "object" && body.error && "message" in body.error
        ? String((body.error as { message?: unknown }).message)
        : "FCM send failed",
      status: "failed",
    };
  }

  return {
    deliveryId: reminder.delivery_id,
    tokenId: reminder.token_id,
    ok: true,
    messageId: typeof body?.name === "string" ? body.name : undefined,
    status: "sent",
  };
}

async function updateDeliveryResult(result: SendResult): Promise<void> {
  if (!result.deliveryId) return;

  await restWriteSingle(
    `medication_notification_deliveries?id=eq.${encodeURIComponent(result.deliveryId)}&select=id,status`,
    "PATCH",
    {
      status: result.status ?? (result.ok ? "sent" : "failed"),
      provider_message_id: result.messageId ?? null,
      error: result.error ?? null,
      sent_at: result.ok ? new Date().toISOString() : null,
    },
  );
}

async function disableInvalidToken(result: SendResult): Promise<void> {
  if (!result.error) return;
  if (!/(UNREGISTERED|not registered|invalid registration|INVALID_ARGUMENT)/i.test(result.error)) return;

  await restWriteSingle(
    `notification_tokens?id=eq.${encodeURIComponent(result.tokenId)}&select=id,enabled`,
    "PATCH",
    {
      enabled: false,
      last_seen_at: new Date().toISOString(),
    },
  );
}

function stripToken(reminder: Reminder): Omit<Reminder, "token"> & { token: string } {
  return {
    ...reminder,
    token: `${reminder.token.slice(0, 8)}...`,
  };
}

export async function runMedicationReminders(body: ReminderRequest): Promise<Record<string, unknown>> {
  const dryRun = body.dryRun ?? true;

  const rpcName = dryRun ? "due_medication_notifications" : "claim_due_medication_notifications";
  const reminders = await restRpc<Reminder>(rpcName, {
    p_window_start: body.windowStart ?? new Date().toISOString(),
    p_window_end: body.windowEnd ?? new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    p_target_user_id: body.targetUserId ?? null,
  });
  const fcmReminders = reminders.filter((reminder) => reminder.provider === "fcm");
  const skippedCount = reminders.length - fcmReminders.length;

  if (dryRun) {
    return {
      dryRun,
      sentCount: 0,
      failedCount: 0,
      skippedCount,
      pendingCount: reminders.length,
      reminders: body.includeReminders ? reminders.map(stripToken) : [],
      message: "FCM dry-run입니다. 실제 푸시는 전송하지 않고 발송 대상만 계산했습니다.",
    };
  }

  const projectId = getFcmProjectId();
  const accessToken = await getGoogleServiceAccountAccessToken("https://www.googleapis.com/auth/firebase.messaging");
  if (!accessToken) {
    throw new HttpError(500, "GOOGLE_SERVICE_ACCOUNT_JSON is required for FCM sending");
  }

  const unsupportedResults = reminders
    .filter((reminder) => reminder.provider !== "fcm")
    .map((reminder) => ({
      deliveryId: reminder.delivery_id,
      tokenId: reminder.token_id,
      ok: false,
      error: `Unsupported notification provider: ${reminder.provider}`,
      status: "skipped" as const,
    }));
  const fcmResults = await Promise.all(
    fcmReminders.map((reminder) => sendFcmReminder(projectId, accessToken, reminder)),
  );
  const results = [...fcmResults, ...unsupportedResults];
  await Promise.all(results.map(updateDeliveryResult));
  await Promise.all(results.filter((result) => !result.ok).map(disableInvalidToken));
  const sentCount = results.filter((result) => result.ok).length;
  const failedCount = results.filter((result) => !result.ok).length;

  return {
    dryRun,
    sentCount,
    failedCount,
    skippedCount,
    pendingCount: reminders.length,
    results,
    reminders: body.includeReminders ? reminders.map(stripToken) : [],
    message: failedCount > 0
      ? "일부 FCM 알림 전송에 실패했습니다. 실패 토큰은 프론트에서 갱신하거나 비활성화해야 합니다."
      : "FCM 알림 전송을 완료했습니다.",
  };
}
