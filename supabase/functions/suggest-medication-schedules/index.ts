import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  userMedicationId: string;
  scanId?: string;
};

type ScheduleSuggestion = {
  takeTime: string;
  timingRule: "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom";
  doseAmount: number | null;
  doseUnit: string | null;
  daysOfWeek: number[];
  source: "ocr" | "drug_db" | "fallback";
  confidence: "high" | "medium" | "low";
  reason: string;
};

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

function stripXml(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function timingRuleFromText(text: string): ScheduleSuggestion["timingRule"] {
  if (/식전|식사\s*전/.test(text)) return "before_meal";
  if (/식후|식사\s*후|식직후|식사\s*직후/.test(text)) return "after_meal";
  if (/식중|식사\s*중/.test(text)) return "with_meal";
  if (/취침|자기\s*전|잠들기\s*전/.test(text)) return "bedtime";
  return "custom";
}

function doseFromText(text: string): { doseAmount: number | null; doseUnit: string | null } {
  const match = text.match(/(?:1회|한\s*번에|매회)?\s*(\d+(?:\.\d+)?)\s*(정|캡슐|포|ml|mL|밀리리터|스푼|방울|개)/);
  if (!match) return { doseAmount: null, doseUnit: null };
  return {
    doseAmount: Number(match[1]),
    doseUnit: match[2],
  };
}

function timesFromText(text: string): Array<{ label: string; takeTime: string }> {
  const times: Array<{ label: string; takeTime: string }> = [];
  if (/아침|조식|오전/.test(text)) times.push({ label: "아침", takeTime: "08:00:00" });
  if (/점심|중식|낮/.test(text)) times.push({ label: "점심", takeTime: "13:00:00" });
  if (/저녁|석식|오후/.test(text)) times.push({ label: "저녁", takeTime: "19:00:00" });
  if (/취침|자기\s*전|잠들기\s*전/.test(text)) times.push({ label: "취침 전", takeTime: "22:00:00" });

  if (times.length > 0) return times;

  const dailyCount = text.match(/(?:1일|하루)\s*(\d+)\s*회/);
  if (!dailyCount) return [];

  const count = Number(dailyCount[1]);
  if (count >= 3) {
    return [
      { label: "아침", takeTime: "08:00:00" },
      { label: "점심", takeTime: "13:00:00" },
      { label: "저녁", takeTime: "19:00:00" },
    ];
  }
  if (count === 2) {
    return [
      { label: "아침", takeTime: "08:00:00" },
      { label: "저녁", takeTime: "19:00:00" },
    ];
  }
  if (count === 1) return [{ label: "하루 1회", takeTime: "09:00:00" }];

  return [];
}

function suggestionsFromText(
  text: string,
  source: ScheduleSuggestion["source"],
): ScheduleSuggestion[] {
  const normalized = stripXml(text);
  if (!normalized) return [];

  const rule = timingRuleFromText(normalized);
  const dose = doseFromText(normalized);
  const times = timesFromText(normalized);

  return times.map((time) => ({
    takeTime: time.takeTime,
    timingRule: rule,
    doseAmount: dose.doseAmount,
    doseUnit: dose.doseUnit,
    daysOfWeek: EVERY_DAY,
    source,
    confidence: source === "ocr" ? "medium" : "low",
    reason: `${time.label} 복용 표현을 인식했습니다. 사용자가 실제 처방 지시와 맞는지 확인해야 합니다.`,
  }));
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.userMedicationId) {
      throw new HttpError(400, "userMedicationId is required");
    }

    const { data: userMedication, error: medicationError } = await serviceClient
      .from("user_medications")
      .select("id,user_id,source_scan_id,medications(id,item_name,dosage,administration_timing)")
      .eq("id", body.userMedicationId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (medicationError) throw new HttpError(500, "Failed to load user medication", medicationError);
    if (!userMedication) throw new HttpError(404, "User medication not found");

    const scanId = body.scanId ?? userMedication.source_scan_id;
    const { data: scan, error: scanError } = scanId
      ? await serviceClient
        .from("scan_sessions")
        .select("id,ocr_text")
        .eq("id", scanId)
        .eq("user_id", user.id)
        .maybeSingle()
      : { data: null, error: null };

    if (scanError) throw new HttpError(500, "Failed to load scan session", scanError);

    const fromOcr = suggestionsFromText(scan?.ocr_text ?? "", "ocr");
    const medication = Array.isArray(userMedication.medications)
      ? userMedication.medications[0]
      : userMedication.medications;
    const fromDrugDb = suggestionsFromText(medication?.dosage ?? "", "drug_db");
    const suggestions = fromOcr.length > 0 ? fromOcr : fromDrugDb;

    return json({
      userMedicationId: userMedication.id,
      medicationName: medication?.item_name ?? null,
      suggestions,
      needsUserConfirmation: true,
      message: suggestions.length > 0
        ? "복용 일정 후보를 만들었습니다. 처방전/약봉투 지시와 맞는지 사용자가 확인한 뒤 일정으로 등록하세요."
        : "복용 시간 후보를 만들 수 없습니다. 사용자가 약봉투 또는 처방전 지시에 따라 직접 일정을 설정해야 합니다.",
    });
  } catch (error) {
    return errorResponse(error);
  }
});
