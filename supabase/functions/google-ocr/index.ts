import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson, requireEnv } from "../_shared/http.ts";
import { imageBlobToBase64, runGoogleOcr } from "../_shared/google.ts";

type RequestBody = {
  scanId: string;
};

type User = {
  id: string;
};

type ScanSession = {
  id: string;
  user_id: string;
  image_path: string | null;
};

type PharmacyContact = {
  name: string | null;
  phone: string | null;
  address: string | null;
  rawLine: string | null;
  confidence: "high" | "medium" | "low";
  source: "ocr";
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function normalizePhone(value: string): string {
  const digits = value.replace(/[^\d]/g, "");
  return digits.replace(/^(\d{2,3})(\d{3,4})(\d{4})$/, "$1-$2-$3");
}

function normalizePhoneDigits(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/[^\d]/g, "");
  return digits.length >= 7 ? digits : null;
}

function normalizePharmacyName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return normalized || null;
}

function stripPhoneFromLine(line: string): string {
  return line.replace(/(?:전화|TEL|Tel|tel|T\.?)?[:\s-]*(?:0\d{1,2}[-.\s]?)?\d{3,4}[-.\s]?\d{4}/g, "").trim();
}

function looksLikeAddress(line: string): boolean {
  return /(특별시|광역시|도\s|시\s|군\s|구\s|읍\s|면\s|동\s|로\s|길\s|번지|층)/.test(line);
}

function extractPharmacyContact(text: string): PharmacyContact | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const phoneMatch = text.match(/(?:0\d{1,2}[-.\s]?)?\d{3,4}[-.\s]?\d{4}/);
  const pharmacyLineIndex = lines.findIndex((line) => /약국|약방/.test(line));
  const pharmacyLine = pharmacyLineIndex >= 0 ? lines[pharmacyLineIndex] : null;
  const name = pharmacyLine
    ? stripPhoneFromLine(pharmacyLine).replace(/(?:전화|TEL|Tel|tel|T\.?)[:\s-]*.*$/g, "").trim()
    : null;
  const phone = phoneMatch ? normalizePhone(phoneMatch[0]) : null;
  const nearbyLines = pharmacyLineIndex >= 0
    ? lines.slice(Math.max(0, pharmacyLineIndex - 2), pharmacyLineIndex + 3)
    : lines;
  const address = nearbyLines.find((line) => looksLikeAddress(line) && !/약국|약방/.test(line)) ?? null;
  const rawLine = pharmacyLine ?? lines.find((line) => phoneMatch && line.includes(phoneMatch[0])) ?? null;
  const confidence = name && phone ? "high" : name || phone ? "medium" : "low";

  if (!name && !phone) return null;
  return {
    name: name || null,
    phone,
    address,
    rawLine,
    confidence,
    source: "ocr",
  };
}

function classifyOcrResult(text: string, confidence: number | null): {
  needsManualReview: boolean;
  failureReason: string | null;
  recommendedAction: string;
} {
  if (!text.trim()) {
    return {
      needsManualReview: true,
      failureReason: "empty_ocr_text",
      recommendedAction: "사진에서 글자를 읽지 못했습니다. 밝은 곳에서 처방전 또는 약봉투를 다시 촬영하거나 약사에게 확인하세요.",
    };
  }

  if (confidence !== null && confidence < 0.65) {
    return {
      needsManualReview: true,
      failureReason: "low_ocr_confidence",
      recommendedAction: "OCR 신뢰도가 낮습니다. 인식된 약 이름과 복용법을 사용자가 직접 확인해야 합니다.",
    };
  }

  return {
    needsManualReview: false,
    failureReason: null,
    recommendedAction: "Call /functions/v1/analyze-medication",
  };
}

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

async function requireUser(req: Request): Promise<User> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new HttpError(401, "Missing Authorization header");
  }

  const response = await fetch(`${requireEnv("SUPABASE_URL")}/auth/v1/user`, {
    headers: {
      apikey: requireEnv("SUPABASE_ANON_KEY"),
      Authorization: authHeader,
    },
  });
  const body = await response.json();

  if (!response.ok || !body.id) {
    throw new HttpError(401, "Invalid or expired user token", body);
  }

  return { id: body.id };
}

async function restSelectSingle<T>(path: string): Promise<T | null> {
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/${path}`, {
    headers: serviceHeaders({
      Accept: "application/vnd.pgrst.object+json",
    }),
  });

  if (response.status === 406) {
    return null;
  }

  const body = await response.json();
  if (!response.ok) {
    throw new HttpError(response.status, "Supabase REST select failed", body);
  }

  return body as T;
}

async function restInsertSingle<T>(table: string, payload: unknown): Promise<T> {
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/${table}?select=*`, {
    method: "POST",
    headers: serviceHeaders({
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Accept: "application/vnd.pgrst.object+json",
    }),
    body: JSON.stringify(payload),
  });
  const body = await response.json();

  if (!response.ok) {
    throw new HttpError(response.status, "Supabase REST insert failed", body);
  }

  return body as T;
}

async function upsertOcrPharmacy(contact: PharmacyContact | null): Promise<string | null> {
  if (!contact) return null;

  const normalizedName = normalizePharmacyName(contact.name);
  const normalizedPhone = normalizePhoneDigits(contact.phone);
  if (!normalizedName && !normalizedPhone) return null;

  const filters = [
    normalizedName
      ? `normalized_name=eq.${encodeURIComponent(normalizedName)}`
      : "normalized_name=is.null",
    normalizedPhone
      ? `normalized_phone=eq.${encodeURIComponent(normalizedPhone)}`
      : "normalized_phone=is.null",
  ].join("&");
  const payload = {
    name: contact.name ?? contact.phone ?? "OCR 약국 정보",
    phone: contact.phone,
    address: contact.address,
    source: "ocr",
    raw_source: contact,
    source_updated_at: new Date().toISOString(),
  };
  const existing = await restSelectSingle<{ id: string }>(
    `pharmacies?select=id&${filters}`,
  );

  if (existing) {
    await restPatch("pharmacies", `id=eq.${encodeURIComponent(existing.id)}`, payload);
    return existing.id;
  }

  try {
    const inserted = await restInsertSingle<{ id: string }>("pharmacies", payload);
    return inserted.id;
  } catch (error) {
    const retried = await restSelectSingle<{ id: string }>(
      `pharmacies?select=id&${filters}`,
    );
    if (retried) return retried.id;
    throw error;
  }
}

async function restPatch(table: string, query: string, payload: unknown): Promise<void> {
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: serviceHeaders({
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json();
    throw new HttpError(response.status, "Supabase REST update failed", body);
  }
}

async function safeRestPatch(table: string, query: string, payload: unknown): Promise<void> {
  try {
    await restPatch(table, query, payload);
  } catch {
    // Preserve the original request error. Cleanup writes are best-effort.
  }
}

async function insertApiUsage(userId: string, status: "succeeded" | "failed" = "succeeded"): Promise<void> {
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/api_usage_logs`, {
    method: "POST",
    headers: serviceHeaders({
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify({
      user_id: userId,
      provider: "google_vision",
      endpoint: "images:annotate",
      status,
      request_count: 1,
      image_count: 1,
    }),
  });

  if (!response.ok) {
    const body = await response.json();
    throw new HttpError(response.status, "Failed to log API usage", body);
  }
}

async function safeInsertApiUsage(userId: string | null, status: "succeeded" | "failed"): Promise<void> {
  if (!userId) return;

  try {
    await insertApiUsage(userId, status);
  } catch {
    // Usage logging must not mask the request result.
  }
}

async function enforceDailyUsageLimit(userId: string): Promise<void> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const path = [
    "api_usage_logs?select=request_count",
    `user_id=eq.${encodeURIComponent(userId)}`,
    "provider=eq.google_vision",
    `created_at=gte.${encodeURIComponent(since.toISOString())}`,
  ].join("&");
  const response = await fetch(`${requireEnv("SUPABASE_URL")}/rest/v1/${path}`, {
    headers: serviceHeaders(),
  });
  const body = await response.json();

  if (!response.ok) {
    throw new HttpError(response.status, "Failed to check API usage limit", body);
  }

  const used = (body as Array<{ request_count?: number }>).reduce(
    (sum, row) => sum + (row.request_count ?? 1),
    0,
  );
  const maxRequests = Number(Deno.env.get("DAILY_GOOGLE_OCR_LIMIT") ?? 50);

  if (used >= maxRequests) {
    throw new HttpError(429, "Daily google_vision usage limit exceeded");
  }
}

async function downloadImage(path: string): Promise<Blob> {
  const encodedPath = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await fetch(
    `${requireEnv("SUPABASE_URL")}/storage/v1/object/prescription-temp/${encodedPath}`,
    {
      headers: serviceHeaders(),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response.status, "Failed to download scan image", text);
  }

  return await response.blob();
}

function validateSupportedImagePath(path: string): void {
  if (!/\.(jpe?g|png)$/i.test(path)) {
    throw new HttpError(400, "unsupported_image_type", {
      message: "jpg, jpeg, png 이미지만 OCR 처리할 수 있습니다.",
      allowedExtensions: ["jpg", "jpeg", "png"],
    });
  }
}

async function removeImage(path: string): Promise<boolean> {
  const encodedPath = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await fetch(
    `${requireEnv("SUPABASE_URL")}/storage/v1/object/prescription-temp/${encodedPath}`,
    {
      method: "DELETE",
      headers: serviceHeaders(),
    },
  );

  return response.ok;
}

function failureReasonFromError(error: unknown): string {
  if (error instanceof HttpError && error.message === "unsupported_image_type") {
    return "unsupported_image_type";
  }
  return "ocr_request_failed";
}

function recommendedActionFromError(error: unknown): string {
  if (error instanceof HttpError && error.message === "unsupported_image_type") {
    return "jpg, jpeg, png 이미지만 OCR 처리할 수 있습니다. 지원 형식으로 다시 업로드해 주세요.";
  }
  return "OCR 처리에 실패했습니다. 처방 약국 또는 의료진에게 복약 정보를 확인하세요.";
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let userId: string | null = null;
  let scanId: string | null = null;
  let jobId: string | null = null;
  let imagePath: string | null = null;

  try {
    const user = await requireUser(req);
    userId = user.id;
    const body = await readJson<RequestBody>(req);

    if (!body.scanId) {
      throw new HttpError(400, "scanId is required");
    }
    scanId = body.scanId;

    await enforceDailyUsageLimit(user.id);

    const scan = await restSelectSingle<ScanSession>(
      `scan_sessions?select=id,user_id,image_path&id=eq.${encodeURIComponent(body.scanId)}&user_id=eq.${encodeURIComponent(user.id)}`,
    );

    if (!scan) throw new HttpError(404, "Scan session not found");
    if (!scan.image_path) throw new HttpError(400, "Scan session has no image_path");
    imagePath = scan.image_path;
    validateSupportedImagePath(scan.image_path);

    const job = await restInsertSingle<{ id: string }>(
      "ocr_jobs",
      {
        scan_id: scan.id,
        provider: "google_vision",
        status: "processing",
        input_image_path: scan.image_path,
        started_at: new Date().toISOString(),
      },
    );
    jobId = job.id;

    await restPatch("scan_sessions", `id=eq.${encodeURIComponent(scan.id)}`, { status: "ocr_processing" });

    const imageBlob = await downloadImage(scan.image_path);
    const imageBase64 = await imageBlobToBase64(imageBlob);
    const ocr = await runGoogleOcr(imageBase64);
    const imageDeleted = await removeImage(scan.image_path);
    const pharmacyContact = extractPharmacyContact(ocr.text);
    const pharmacyId = await upsertOcrPharmacy(pharmacyContact);
    const review = classifyOcrResult(ocr.text, ocr.confidence);

    await restPatch(
      "ocr_jobs",
      `id=eq.${encodeURIComponent(job.id)}`,
      {
        status: "succeeded",
        result_json: ocr.raw,
        failure_reason: review.failureReason,
        finished_at: new Date().toISOString(),
      },
    );

    await restPatch(
      "scan_sessions",
      `id=eq.${encodeURIComponent(scan.id)}`,
      {
        status: "matching",
        ocr_text: ocr.text,
        confidence: ocr.confidence,
        review_status: review.needsManualReview ? "needed" : "not_needed",
        failure_reason: review.failureReason,
        recommended_action: review.recommendedAction,
        pharmacy_id: pharmacyId,
        pharmacy_contact: pharmacyContact,
        ocr_quality: {
          confidence: ocr.confidence,
          textLength: ocr.text.trim().length,
          hasPharmacyContact: Boolean(pharmacyContact),
        },
        ...(imageDeleted ? {
          image_path: null,
          image_deleted_at: new Date().toISOString(),
        } : {}),
      },
    );

    await insertApiUsage(user.id);

    return json({
      scanId: scan.id,
      ocrText: ocr.text,
      confidence: ocr.confidence,
      imageDeleted,
      needsManualReview: review.needsManualReview,
      failureReason: review.failureReason,
      recommendedAction: review.recommendedAction,
      pharmacyContact,
      next: review.recommendedAction,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (jobId) {
      await safeRestPatch(
        "ocr_jobs",
        `id=eq.${encodeURIComponent(jobId)}`,
        {
          status: "failed",
          failure_reason: failureReasonFromError(error),
          error_message: message,
          finished_at: new Date().toISOString(),
        },
      );
    }
    if (scanId) {
      await safeRestPatch(
        "scan_sessions",
        `id=eq.${encodeURIComponent(scanId)}`,
        {
          status: "failed",
          review_status: "needed",
          failure_reason: failureReasonFromError(error),
          recommended_action: recommendedActionFromError(error),
          error_message: message,
        },
      );
    }
    if (imagePath) {
      await removeImage(imagePath).catch(() => false);
    }
    await safeInsertApiUsage(userId, "failed");
    return errorResponse(error);
  }
});
