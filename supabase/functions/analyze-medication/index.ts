import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  scanId: string;
  confirmMedicationIds?: string[];
};

type MedicationCandidateMatch = {
  search_text: string;
  id: string;
  item_seq: string | null;
  item_name: string;
  entp_name: string | null;
  edi_code: string | null;
  similarity_score: number;
  match_rank: number;
  match_source?: "exact" | "fuzzy" | "alias" | "edi_code" | "barcode";
  alias_requires_confirmation?: boolean;
  alias_type?: string | null;
};

type DetectedMedicationRow = {
  id: string;
  medication_id: string | null;
  needs_confirmation: boolean;
  match_quality: string;
  medications?: {
    id: string;
    item_name: string;
    entp_name: string | null;
    efficacy: string | null;
    dosage: string | null;
    precautions: string | null;
    side_effects: string | null;
    storage_method: string | null;
    administration_timing: string | null;
    information_completeness: Record<string, boolean> | null;
    source: string | null;
    source_updated_at: string | null;
  } | null;
};

type ResultMode = "ready" | "review_required" | "no_candidates";

function matchQuality(confidence: number, hasMatch: boolean): "high" | "medium" | "low" | "none" {
  if (!hasMatch) return "none";
  if (confidence >= 0.82) return "high";
  if (confidence >= 0.65) return "medium";
  return "low";
}

function getResultMode(params: {
  candidateCount: number;
  detectedRows: Array<{ needs_confirmation: boolean; match_quality: string }>;
  unmatchedCount: number;
}): ResultMode {
  if (params.candidateCount === 0 || params.detectedRows.length === 0) return "no_candidates";
  if (params.unmatchedCount > 0) return "review_required";
  if (params.detectedRows.some((row) => row.needs_confirmation || !["high", "medium"].includes(row.match_quality))) {
    return "review_required";
  }
  return "ready";
}

function recommendedActionForMode(mode: ResultMode): string {
  if (mode === "ready") {
    return "약품 후보를 바로 표시할 수 있습니다. 사용자가 최종 확인하면 현재 복용약으로 등록하세요.";
  }
  if (mode === "review_required") {
    return "인식 결과에 확인이 필요한 약품이 있습니다. 자동 등록하지 말고 사용자 확인 또는 재촬영을 안내하세요.";
  }
  return "약품명을 찾지 못했습니다. 약봉투나 처방전처럼 글자가 보이는 사진을 다시 촬영하거나 약사에게 확인하도록 안내하세요.";
}

function summarizeInformationAvailability(rows: DetectedMedicationRow[]): {
  hasMedicationDetails: boolean;
  missingFields: string[];
} {
  const requiredFields = ["efficacy", "dosage", "precautions", "storage_method"];
  const missing = new Set<string>();
  let hasMedicationDetails = false;

  for (const row of rows) {
    if (!row.medications) {
      for (const field of requiredFields) missing.add(field);
      continue;
    }
    hasMedicationDetails = true;
    for (const field of requiredFields) {
      const value = row.medications[field as keyof typeof row.medications];
      if (typeof value !== "string" || value.trim().length === 0) {
        missing.add(field);
      }
    }
  }

  return {
    hasMedicationDetails,
    missingFields: [...missing],
  };
}

function normalizeText(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s.%()[\]-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulCandidateLine(line: string): boolean {
  if (line.length < 2 || line.length > 80) return false;
  if (/^\d+$/.test(line)) return false;

  const hasKorean = /[가-힣]/.test(line);
  const hasDrugForm = /(정|캡슐|시럽|액|주|연고|크림|겔|패취|산|과립|점안액|흡입제)/.test(line);
  if (hasKorean || hasDrugForm) return true;

  // Google OCR often returns tiny Latin fragments around pill logos, e.g. "ru" or "ER".
  // Keep longer Latin brand candidates; short fragments are handled by explicit brand extraction below.
  if (/^[A-Za-z]{1,3}$/.test(line)) return false;

  return line.length >= 4;
}

function extractCandidates(ocrText: string): string[] {
  const normalizedLines = ocrText
    .split(/[\n\r,;]+|\s{2,}/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const combinedLatinCandidates: string[] = [];

  for (let index = 0; index < normalizedLines.length - 1; index += 1) {
    const current = normalizedLines[index];
    const next = normalizedLines[index + 1];
    if (/^[A-Z][A-Z0-9-]{3,}$/.test(current) && /^[A-Z0-9-]{2,4}$/.test(next)) {
      combinedLatinCandidates.push(`${current} ${next}`);
    }
  }

  const lines = [
    ...combinedLatinCandidates,
    ...normalizedLines.filter(isUsefulCandidateLine),
  ];

  const medicineLike = lines.flatMap((line) => {
    const chunks = [line];
    const koreanDrugPattern = /[가-힣A-Za-z0-9()[\]-]{2,}(정|캡슐|시럽|액|주|연고|크림|겔|패취|산|과립|점안액|흡입제)/g;
    for (const match of line.matchAll(koreanDrugPattern)) {
      chunks.push(match[0]);
    }
    const latinBrandPattern = /\b[A-Z][A-Z0-9-]{3,}\b/g;
    for (const match of line.matchAll(latinBrandPattern)) {
      chunks.push(match[0]);
    }
    return chunks;
  });

  const uniqueCandidates = [...new Set(medicineLike.filter((candidate) => !/^[A-Z]$|^\d+$/.test(candidate)))];
  const specificCandidates = uniqueCandidates.filter(
    (candidate) => !uniqueCandidates.some((other) => other !== candidate && other.startsWith(`${candidate} `)),
  );

  return specificCandidates.slice(0, 30);
}

function isBroadLatinBrand(candidate: string): boolean {
  return /^[A-Z][A-Z0-9-]{3,}$/.test(candidate);
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.scanId) {
      throw new HttpError(400, "scanId is required");
    }

    const { data: scan, error: scanError } = await serviceClient
      .from("scan_sessions")
      .select("id,user_id,ocr_text")
      .eq("id", body.scanId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (scanError) throw new HttpError(500, "Failed to load scan session", scanError);
    if (!scan) throw new HttpError(404, "Scan session not found");
    if (!scan.ocr_text) throw new HttpError(400, "Scan session has no OCR text");

    const candidates = extractCandidates(scan.ocr_text);
    const detectedRows = [];
    const unmatchedCandidates: string[] = [];
    const { data: matches, error: matchError } = candidates.length > 0
      ? await serviceClient
        .rpc("find_medication_candidates_bulk", {
          search_texts: candidates,
          max_results: 1,
        })
      : { data: [], error: null };

    if (matchError) throw new HttpError(500, "Failed to match medication candidates", matchError);

    const bestByCandidate = new Map<string, MedicationCandidateMatch>();
    for (const match of (matches ?? []) as MedicationCandidateMatch[]) {
      if (!bestByCandidate.has(match.search_text)) {
        bestByCandidate.set(match.search_text, match);
      }
    }

    for (const candidate of candidates) {
      const best = bestByCandidate.get(candidate);
      const confidence = best?.similarity_score ?? 0;
      const isExact = best?.item_name === candidate || best?.edi_code === candidate || best?.match_source === "exact";
      const matchSource = best?.match_source ?? (isExact ? "exact" : best ? "fuzzy" : "none");
      const needsBrandConfirmation = Boolean(best) &&
        (best?.alias_requires_confirmation ?? (!isExact && isBroadLatinBrand(candidate)));
      const quality = needsBrandConfirmation ? "medium" : matchQuality(isExact ? 1 : confidence, Boolean(best));
      if (!best) unmatchedCandidates.push(candidate);

      if (best || candidate.length >= 3) {
        detectedRows.push({
          scan_id: scan.id,
          medication_id: best?.id ?? null,
          detected_name: candidate,
          matched_name: best?.item_name ?? null,
          confidence: isExact ? 1 : Math.min(Math.max(confidence, 0), 0.99),
          match_method: matchSource,
          match_quality: quality,
          needs_confirmation: needsBrandConfirmation || (!isExact && confidence < 0.82),
          warning_message: !best
            ? "공식 의약품 DB에서 확실한 매칭을 찾지 못했습니다. 약사 또는 의사에게 확인하세요."
            : needsBrandConfirmation
            ? "브랜드명만으로는 여러 제품이 있을 수 있습니다. 포장에 적힌 세부 제품명, 함량, 제형을 사용자가 확인해야 합니다."
            : null,
        });
      }
    }

    await serviceClient
      .from("scan_detected_medications")
      .delete()
      .eq("scan_id", scan.id);

    const { data: inserted, error: insertError } = detectedRows.length > 0
      ? await serviceClient
        .from("scan_detected_medications")
        .insert(detectedRows)
        .select("*")
      : { data: [], error: null };

    if (insertError) throw new HttpError(500, "Failed to save detected medications", insertError);

    const insertedIds = (inserted ?? []).map((row) => row.id);
    const { data: enrichedDetected, error: enrichedError } = insertedIds.length > 0
      ? await serviceClient
        .from("scan_detected_medications")
        .select("*, medications(id,item_name,entp_name,efficacy,dosage,precautions,side_effects,storage_method,administration_timing,information_completeness,source,source_updated_at)")
        .in("id", insertedIds)
        .order("confidence", { ascending: false })
      : { data: [], error: null };

    if (enrichedError) throw new HttpError(500, "Failed to load detected medication details", enrichedError);

    await serviceClient
      .from("scan_sessions")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", scan.id);

    const resultMode = getResultMode({
      candidateCount: candidates.length,
      detectedRows,
      unmatchedCount: unmatchedCandidates.length,
    });
    const informationAvailability = summarizeInformationAvailability((enrichedDetected ?? []) as DetectedMedicationRow[]);

    return json({
      scanId: scan.id,
      candidates,
      detectedMedications: enrichedDetected ?? [],
      resultMode,
      matchQuality: inserted?.some((row) => row.match_quality === "high")
        ? "high"
        : inserted?.some((row) => row.match_quality === "medium")
        ? "medium"
        : inserted?.some((row) => row.match_quality === "low")
        ? "low"
        : "none",
      unmatchedCandidates,
      needsUserConfirmation: resultMode !== "ready",
      autoDisplayReady: resultMode === "ready",
      informationAvailability,
      recommendedAction: recommendedActionForMode(resultMode),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
