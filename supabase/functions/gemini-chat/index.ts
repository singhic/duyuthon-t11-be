import { handleCors } from "../_shared/cors.ts";
import { askGeminiForMedicationAnswer, type MedicationAnswer } from "../_shared/gemini.ts";
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

type SafetyIntent =
  | "general"
  | "interaction"
  | "dose_change"
  | "stop_medication"
  | "alcohol"
  | "pregnancy"
  | "emergency"
  | "prompt_attack";

const DEFAULT_DISCLAIMER = "이 정보는 참고용이며 AI 답변은 틀릴 수 있습니다. 정확한 복약 방법과 약물 상호작용은 의사 또는 약사에게 확인하세요.";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function classifySafetyIntent(question: string): SafetyIntent {
  const normalized = question.trim().toLowerCase();

  if (/(프롬프트|시스템\s*지시|개발자\s*지시|내부\s*지침|이전\s*지시|지시.*무시|무시.*지시|탈옥|개발자\s*모드|jailbreak|ignore\s+(all\s+)?previous|system\s+prompt|developer\s+message|prompt)/i.test(normalized)) {
    return "prompt_attack";
  }

  if (/(숨이?\s*답답|호흡\s*곤란|숨.*안\s*쉬|의식\s*(저하|없|잃)|흉통|가슴.*통증|심한\s*두드러기|두드러기.*호흡|얼굴.*붓|입술.*붓|목.*붓|과다\s*복용|너무\s*많이\s*먹|피.*토|피.*변|자살|자해)/i.test(normalized)) {
    return "emergency";
  }

  if (/(두\s*배|2\s*배|한\s*알\s*더|더\s*먹|추가로\s*먹|많이\s*먹|용량.*(늘|줄|바꿔)|복용량.*(늘|줄|바꿔)|반만\s*먹|쪼개.*먹|과량)/i.test(normalized)) {
    return "dose_change";
  }

  if (/(안\s*먹어도|안먹어도|먹지\s*않아도|끊어도|중단|중지|그만\s*먹|빼먹|건너뛰|오늘.*먹지|복용.*멈)/i.test(normalized)) {
    return "stop_medication";
  }

  if (/(술|음주|알코올|소주|맥주|와인|막걸리)/i.test(normalized)) {
    return "alcohol";
  }

  if (/(임신|임산부|수유|모유|태아|아기\s*가졌|임신부)/i.test(normalized)) {
    return "pregnancy";
  }

  if (/(같이|함께|동시|동시에|병용|상호작용|먹어도|복용해도|겹쳐|중복|섞어|커피|카페인)/i.test(normalized)) {
    return "interaction";
  }

  return "general";
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
  _question: string,
  medications: MedicationContextItem[],
  safetyIntent: SafetyIntent,
): Promise<InteractionEvidence> {
  if (safetyIntent !== "interaction") {
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

function deterministicAnswerForIntent(intent: SafetyIntent): MedicationAnswer | null {
  if (intent === "dose_change") {
    return {
      answer: "처방된 양보다 더 많이 먹거나 줄여 먹으면 위험할 수 있습니다. 두 배로 복용하지 말고, 이미 더 먹었거나 헷갈리면 약 봉투를 들고 약사 또는 의사에게 바로 확인하세요.",
      safetyLevel: "caution",
      needsDoctorOrPharmacist: true,
      citedMedicationIds: [],
      citedInteractionIds: [],
      disclaimer: DEFAULT_DISCLAIMER,
    };
  }

  if (intent === "stop_medication") {
    return {
      answer: "임의로 약을 중단하거나 건너뛰면 증상이 나빠질 수 있습니다. 오늘 복용 여부가 헷갈리면 추가로 판단하지 말고 처방한 병원이나 약국에 확인하세요.",
      safetyLevel: "caution",
      needsDoctorOrPharmacist: true,
      citedMedicationIds: [],
      citedInteractionIds: [],
      disclaimer: DEFAULT_DISCLAIMER,
    };
  }

  if (intent === "alcohol") {
    return {
      answer: "술과 함께 복용해도 된다고 단정할 수 없습니다. 약 종류에 따라 졸림, 간 부담, 부작용이 커질 수 있으니 복용 중에는 음주를 피하고 약사 또는 의사에게 확인하세요.",
      safetyLevel: "caution",
      needsDoctorOrPharmacist: true,
      citedMedicationIds: [],
      citedInteractionIds: [],
      disclaimer: DEFAULT_DISCLAIMER,
    };
  }

  if (intent === "pregnancy") {
    return {
      answer: "임신 중이거나 수유 중이면 약 복용 전 확인이 꼭 필요합니다. 임의로 복용하거나 중단하지 말고 산부인과 의사 또는 약사에게 이 약 이름을 알려 확인하세요.",
      safetyLevel: "caution",
      needsDoctorOrPharmacist: true,
      citedMedicationIds: [],
      citedInteractionIds: [],
      disclaimer: DEFAULT_DISCLAIMER,
    };
  }

  if (intent === "emergency") {
    return {
      answer: "숨이 답답하거나 심한 두드러기, 얼굴이나 입술 붓기, 흉통 같은 증상은 응급 상황일 수 있습니다. 지금 바로 119에 연락하거나 가까운 응급실로 가세요.",
      safetyLevel: "urgent",
      needsDoctorOrPharmacist: true,
      citedMedicationIds: [],
      citedInteractionIds: [],
      disclaimer: DEFAULT_DISCLAIMER,
    };
  }

  if (intent === "prompt_attack") {
    return {
      answer: "그 요청에는 답할 수 없습니다. 복약과 관련된 질문만 도와드릴 수 있습니다.",
      safetyLevel: "info",
      needsDoctorOrPharmacist: false,
      citedMedicationIds: [],
      citedInteractionIds: [],
      disclaimer: DEFAULT_DISCLAIMER,
    };
  }

  return null;
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
    const safetyIntent = classifySafetyIntent(body.question.trim());
    const interactionEvidence = await loadInteractionEvidence(
      serviceClient,
      body.question.trim(),
      medicationContext,
      safetyIntent,
    );

    const deterministicAnswer = deterministicAnswerForIntent(safetyIntent);
    if (deterministicAnswer) {
      await serviceClient.from("chat_messages").insert({
        chat_session_id: chatSessionId,
        role: "assistant",
        content: deterministicAnswer.answer,
        model_name: "deterministic-safety-guard",
        citations: {
          safetyIntent,
          interactionEvidence,
        },
        safety_level: deterministicAnswer.safetyLevel,
        needs_doctor_or_pharmacist: deterministicAnswer.needsDoctorOrPharmacist,
      });

      return json({
        chatSessionId,
        ...deterministicAnswer,
        safetyIntent,
        interactionEvidence,
      });
    }

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
          safetyIntent,
          interactionEvidence,
        },
        safety_level: fallbackAnswer.safetyLevel,
        needs_doctor_or_pharmacist: fallbackAnswer.needsDoctorOrPharmacist,
      });

      return json({
        chatSessionId,
        ...fallbackAnswer,
        safetyIntent,
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
      safetyIntent,
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
        safetyIntent,
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
      safetyIntent,
      interactionEvidence,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
