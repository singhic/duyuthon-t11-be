import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  medicationId: string;
};

function toOverallSeverity(severity: string, hasIngredientPairs: boolean, hasInteractions: boolean): "no_registered_warning" | "caution" | "danger" | "unknown" {
  if (!hasIngredientPairs) return "unknown";
  if (!hasInteractions) return "no_registered_warning";
  if (severity === "contraindicated" || severity === "major") return "danger";
  if (severity === "moderate" || severity === "minor" || severity === "unknown") return "caution";
  return "unknown";
}

function messageForOverallSeverity(overallSeverity: ReturnType<typeof toOverallSeverity>): string {
  if (overallSeverity === "danger") {
    return "등록된 상호작용 경고가 있습니다. 함께 복용하기 전 의사 또는 약사에게 반드시 확인하세요.";
  }
  if (overallSeverity === "caution") {
    return "주의가 필요한 상호작용 후보가 있습니다. 복용 전 약사 또는 의사에게 확인하세요.";
  }
  if (overallSeverity === "no_registered_warning") {
    return "현재 등록된 상호작용 경고는 없습니다. 다만 자동 검사 결과만으로 안전을 단정할 수는 없으니, 처방약은 의사 또는 약사에게 확인하세요.";
  }
  return "성분 정보가 부족해 자동 상호작용 판단이 어렵습니다. 약사 또는 의사에게 확인하세요.";
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.medicationId) {
      throw new HttpError(400, "medicationId is required");
    }

    const { data: currentMedications, error: currentError } = await serviceClient
      .from("user_medications")
      .select("medication_id")
      .eq("user_id", user.id)
      .eq("active", true);

    if (currentError) throw new HttpError(500, "Failed to load current medications", currentError);

    const currentMedicationIds = [...new Set((currentMedications ?? []).map((row) => row.medication_id))];
    if (currentMedicationIds.length === 0) {
      return json({
        severity: "unknown",
        overallSeverity: "no_registered_warning",
        isConfirmedSafe: false,
        interactions: [],
        comparedMedicationCount: 0,
        message: "현재 등록된 복용약이 없어 상호작용 비교 대상이 없습니다. 새 약을 기존 약과 함께 복용 중이라면 먼저 복용약을 등록하거나 의사 또는 약사에게 확인하세요.",
      });
    }

    const { data: currentIngredients, error: currentIngredientError } = currentMedicationIds.length > 0
      ? await serviceClient
        .from("medication_ingredients")
        .select("ingredient_id")
        .in("medication_id", currentMedicationIds)
      : { data: [], error: null };

    if (currentIngredientError) {
      throw new HttpError(500, "Failed to load current medication ingredients", currentIngredientError);
    }

    const { data: newIngredients, error: newError } = await serviceClient
      .from("medication_ingredients")
      .select("ingredient_id")
      .eq("medication_id", body.medicationId);

    if (newError) throw new HttpError(500, "Failed to load new medication ingredients", newError);

    const currentIngredientIds = (currentIngredients ?? []).map((row) => row.ingredient_id);
    const newIngredientIds = (newIngredients ?? []).map((row) => row.ingredient_id);

    const hasIngredientPairs = currentIngredientIds.length > 0 && newIngredientIds.length > 0;
    if (!hasIngredientPairs) {
      return json({
        severity: "unknown",
        overallSeverity: "unknown",
        isConfirmedSafe: false,
        interactions: [],
        comparedMedicationCount: currentMedicationIds.length,
        message: messageForOverallSeverity("unknown"),
      });
    }

    const { data: interactions, error: interactionError } = await serviceClient
      .rpc("check_interactions_for_medications", {
        current_medication_ids: currentMedicationIds,
        new_medication_id: body.medicationId,
      });

    if (interactionError) throw new HttpError(500, "Failed to check drug interactions", interactionError);

    const severityRank: Record<string, number> = {
      contraindicated: 5,
      major: 4,
      moderate: 3,
      minor: 2,
      unknown: 1,
    };
    const maxSeverity = (interactions ?? []).reduce(
      (current, item) => severityRank[item.severity] > severityRank[current] ? item.severity : current,
      "unknown",
    );
    const overallSeverity = toOverallSeverity(maxSeverity, hasIngredientPairs, Boolean(interactions?.length));

    return json({
      severity: maxSeverity,
      overallSeverity,
      isConfirmedSafe: false,
      interactions: interactions ?? [],
      comparedMedicationCount: currentMedicationIds.length,
      message: messageForOverallSeverity(overallSeverity),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
