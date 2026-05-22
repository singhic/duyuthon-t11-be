import { handleCors } from "../_shared/cors.ts";
import { askGeminiForMedicationAnswer } from "../_shared/gemini.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { enforceDailyUsageLimit, logApiUsage, requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  question: string;
  chatSessionId?: string;
  scanId?: string;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.question?.trim()) {
      throw new HttpError(400, "question is required");
    }

    await enforceDailyUsageLimit(serviceClient, {
      userId: user.id,
      provider: "gemini",
      maxRequests: Number(Deno.env.get("DAILY_GEMINI_LIMIT") ?? 100),
    });

    let chatSessionId = body.chatSessionId;
    if (chatSessionId) {
      const { data: existing, error } = await serviceClient
        .from("chat_sessions")
        .select("id")
        .eq("id", chatSessionId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) throw new HttpError(500, "Failed to verify chat session", error);
      if (!existing) throw new HttpError(404, "Chat session not found");
    } else {
      const { data: created, error } = await serviceClient
        .from("chat_sessions")
        .insert({
          user_id: user.id,
          scan_id: body.scanId ?? null,
        })
        .select("id")
        .single();

      if (error) throw new HttpError(500, "Failed to create chat session", error);
      chatSessionId = created.id;
    }

    await serviceClient.from("chat_messages").insert({
      chat_session_id: chatSessionId,
      role: "user",
      content: body.question.trim(),
    });

    const [{ data: activeMeds, error: medsError }, { data: detected, error: detectedError }, { data: scan, error: scanError }] = await Promise.all([
      serviceClient
        .from("user_medications")
        .select("id, medication_id, custom_name, medications(id,item_name,efficacy,dosage,precautions,side_effects,storage_method,administration_timing,information_completeness,source,source_updated_at)")
        .eq("user_id", user.id)
        .eq("active", true),
      body.scanId
        ? serviceClient
          .from("scan_detected_medications")
          .select("id, medication_id, detected_name, matched_name, confidence, match_quality, needs_confirmation, warning_message, medications(id,item_name,efficacy,dosage,precautions,side_effects,storage_method,administration_timing,information_completeness,source,source_updated_at)")
          .eq("scan_id", body.scanId)
        : Promise.resolve({ data: [], error: null }),
      body.scanId
        ? serviceClient
          .from("scan_sessions")
          .select("id, confidence, status, ocr_text, review_status, failure_reason, recommended_action, pharmacy_contact")
          .eq("id", body.scanId)
          .eq("user_id", user.id)
          .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (medsError) throw new HttpError(500, "Failed to load active medications", medsError);
    if (detectedError) throw new HttpError(500, "Failed to load scan medications", detectedError);
    if (scanError) throw new HttpError(500, "Failed to load scan session", scanError);

    const context = {
      service: {
        name: "이약뭐지",
        purpose: "약 사진과 공식 DB 기반 복약 정보 안내",
        medicalDisclaimerRequired: true,
      },
      scan: scan
        ? {
          id: scan.id,
          status: scan.status,
          ocrConfidence: scan.confidence,
          reviewStatus: scan.review_status,
          failureReason: scan.failure_reason,
          recommendedAction: scan.recommended_action,
          pharmacyContact: scan.pharmacy_contact,
          ocrTextPreview: typeof scan.ocr_text === "string" ? scan.ocr_text.slice(0, 500) : null,
          caution: scan.confidence !== null && scan.confidence < 0.8
            ? "OCR 신뢰도가 낮으므로 약품명과 복용법을 확정하지 말고 사용자 확인을 요청해야 한다."
            : null,
        }
        : null,
      activeMedications: activeMeds ?? [],
      scanMedications: detected ?? [],
      safetyPolicy: {
        doNotAdviseDoseChange: true,
        doNotAdviseStopMedication: true,
        doNotClaimAbsoluteSafety: true,
        requireProfessionalForUncertainCases: true,
        alwaysUseOfficialContextOnly: true,
      },
    };

    let gemini;
    try {
      gemini = await askGeminiForMedicationAnswer({
        question: body.question.trim(),
        context,
      });
    } catch (geminiError) {
      await logApiUsage(serviceClient, {
        userId: user.id,
        provider: "gemini",
        endpoint: "generateContent",
        status: "failed",
      }).catch(() => {});

      await serviceClient.from("chat_messages").insert({
        chat_session_id: chatSessionId,
        role: "assistant",
        content: "지금은 답변을 생성하지 못했습니다. AI 답변은 틀릴 수 있으니, 정확한 복약 정보는 의사 또는 약사에게 확인하세요.",
        model_name: Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash",
        citations: {
          error: errorMessage(geminiError).slice(0, 500),
        },
        safety_level: "caution",
        needs_doctor_or_pharmacist: true,
      }).catch(() => {});

      throw geminiError;
    }

    await serviceClient.from("chat_messages").insert({
      chat_session_id: chatSessionId,
      role: "assistant",
      content: gemini.answer.answer,
      model_name: gemini.model,
      citations: {
        medicationIds: gemini.answer.citedMedicationIds,
        interactionIds: gemini.answer.citedInteractionIds,
        rawSafetyBlocked: gemini.safetyBlocked,
      },
      safety_level: gemini.answer.safetyLevel,
      needs_doctor_or_pharmacist: gemini.answer.needsDoctorOrPharmacist,
    });

    await logApiUsage(serviceClient, {
      userId: user.id,
      provider: "gemini",
      endpoint: "generateContent",
      tokenCount: gemini.tokenCount ?? undefined,
    });

    return json({
      chatSessionId,
      ...gemini.answer,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
