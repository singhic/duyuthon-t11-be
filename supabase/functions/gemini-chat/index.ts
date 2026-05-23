import { handleCors } from "../_shared/cors.ts";
import { askGeminiForMedicationAnswer } from "../_shared/gemini.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { enforceDailyUsageLimit, logApiUsage, requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  question: string;
  chatSessionId?: string;
  scanId?: string;
};

type MedicationContextItem = {
  id: string;
  source: "active" | "scan";
  name: string;
  medicationId: string | null;
};

type InteractionEvidence = {
  mode: "not_interaction_question" | "confirmed_warning" | "no_registered_warning" | "insufficient_context";
  checkedMedicationIds: string[];
  interactions: Array<{
    id: string;
    severity: string;
    description: string | null;
    recommendation: string | null;
    source: string | null;
    updated_at: string | null;
  }>;
  message: string;
  isConfirmedSafe: false;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function isInteractionQuestion(question: string): boolean {
  return /(같이|함께|동시|동시에|병용|상호작용|먹어도|복용해도|겹쳐|중복|섞어|술|알코올|커피|카페인)/i.test(question);
}

function medicationName(value: any): string {
  return value?.medications?.item_name ?? value?.matched_name ?? value?.custom_name ?? value?.detected_name ?? "이 약";
}

function uniqueMedicationContext(activeMeds: any[], detected: any[]): MedicationContextItem[] {
  const items: MedicationContextItem[] = [
    ...activeMeds.map((row) => ({
      id: row.id,
      source: "active" as const,
      name: medicationName(row),
      medicationId: row.medication_id ?? row.medications?.id ?? null,
    })),
    ...detected.map((row) => ({
      id: row.id,
      source: "scan" as const,
      name: medicationName(row),
      medicationId: row.medication_id ?? row.medications?.id ?? null,
    })),
  ];

  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.medicationId ?? `${item.source}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadInteractionEvidence(
  serviceClient: any,
  question: string,
  medications: MedicationContextItem[],
): Promise<InteractionEvidence> {
  if (!isInteractionQuestion(question)) {
    return {
      mode: "not_interaction_question",
      checkedMedicationIds: [],
      interactions: [],
      message: "상호작용 질문이 아니므로 별도 상호작용 DB 검사를 수행하지 않았습니다.",
      isConfirmedSafe: false,
    };
  }

  const medicationIds = [...new Set(medications.map((item) => item.medicationId).filter((id): id is string => Boolean(id)))];
  if (medicationIds.length < 2) {
    return {
      mode: "insufficient_context",
      checkedMedicationIds: medicationIds,
      interactions: [],
      message: "상호작용을 판단하려면 공식 DB에 매칭된 약이 2개 이상 필요합니다. 현재 정보만으로는 함께 복용 가능 여부를 답할 수 없습니다.",
      isConfirmedSafe: false,
    };
  }

  const { data: ingredientRows, error: ingredientError } = await serviceClient
    .from("medication_ingredients")
    .select("medication_id, ingredient_id")
    .in("medication_id", medicationIds);

  if (ingredientError) {
    throw new HttpError(500, "Failed to load medication ingredients for interaction evidence", ingredientError);
  }

  const ingredientIdsByMedication = new Map<string, string[]>();
  for (const row of ingredientRows ?? []) {
    const ids = ingredientIdsByMedication.get(row.medication_id) ?? [];
    ids.push(row.ingredient_id);
    ingredientIdsByMedication.set(row.medication_id, ids);
  }

  if (medicationIds.some((id) => !ingredientIdsByMedication.has(id))) {
    return {
      mode: "insufficient_context",
      checkedMedicationIds: medicationIds,
      interactions: [],
      message: "일부 약의 성분 정보가 부족해 상호작용을 확인할 수 없습니다. 공공 DB 동기화 후 다시 확인하거나 약사에게 문의하세요.",
      isConfirmedSafe: false,
    };
  }

  const interactionMap = new Map<string, InteractionEvidence["interactions"][number]>();
  for (let index = 0; index < medicationIds.length; index += 1) {
    const currentIds = medicationIds.slice(0, index);
    const newMedicationId = medicationIds[index];
    if (currentIds.length === 0) continue;

    const { data: interactions, error: interactionError } = await serviceClient
      .rpc("check_interactions_for_medications", {
        current_medication_ids: currentIds,
        new_medication_id: newMedicationId,
      });

    if (interactionError) {
      throw new HttpError(500, "Failed to load interaction evidence", interactionError);
    }

    for (const interaction of interactions ?? []) {
      interactionMap.set(interaction.id, {
        id: interaction.id,
        severity: interaction.severity,
        description: interaction.description,
        recommendation: interaction.recommendation,
        source: interaction.source,
        updated_at: interaction.updated_at,
      });
    }
  }

  const foundInteractions = [...interactionMap.values()];
  if (foundInteractions.length > 0) {
    return {
      mode: "confirmed_warning",
      checkedMedicationIds: medicationIds,
      interactions: foundInteractions,
      message: "공식 DB에 저장된 상호작용 경고가 확인되었습니다.",
      isConfirmedSafe: false,
    };
  }

  return {
    mode: "no_registered_warning",
    checkedMedicationIds: medicationIds,
    interactions: [],
    message: "현재 DB에 등록된 상호작용 경고는 없습니다. 그러나 이는 안전 확정이 아니라 미등록 또는 미동기화 가능성이 있는 상태입니다.",
    isConfirmedSafe: false,
  };
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

    const medicationContext = uniqueMedicationContext(activeMeds ?? [], detected ?? []);
    const interactionEvidence = await loadInteractionEvidence(
      serviceClient,
      body.question.trim(),
      medicationContext,
    );

    if (interactionEvidence.mode === "insufficient_context") {
      const fallbackAnswer = {
        answer: `${interactionEvidence.message} AI 답변은 틀릴 수 있으니, 정확한 복약 가능 여부는 의사 또는 약사에게 확인하세요.`,
        safetyLevel: "caution" as const,
        needsDoctorOrPharmacist: true,
        citedMedicationIds: interactionEvidence.checkedMedicationIds,
        citedInteractionIds: [],
        disclaimer: "이 정보는 참고용이며 AI 답변은 틀릴 수 있습니다. 정확한 복약 방법과 약물 상호작용은 의사 또는 약사에게 확인하세요.",
      };

      await serviceClient.from("chat_messages").insert({
        chat_session_id: chatSessionId,
        role: "assistant",
        content: fallbackAnswer.answer,
        model_name: "deterministic-safety-guard",
        citations: {
          interactionEvidence,
        },
        safety_level: fallbackAnswer.safetyLevel,
        needs_doctor_or_pharmacist: fallbackAnswer.needsDoctorOrPharmacist,
      });

      return json({
        chatSessionId,
        ...fallbackAnswer,
        interactionEvidence,
      });
    }

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
      interactionEvidence,
      safetyPolicy: {
        doNotAdviseDoseChange: true,
        doNotAdviseStopMedication: true,
        doNotClaimAbsoluteSafety: true,
        requireProfessionalForUncertainCases: true,
        alwaysUseOfficialContextOnly: true,
        ifInteractionEvidenceIsNoRegisteredWarningSayNotConfirmedSafe: true,
        ifInteractionEvidenceIsInsufficientContextDoNotAnswerMedicalConclusion: true,
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
        interactionEvidence,
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
      interactionEvidence,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
