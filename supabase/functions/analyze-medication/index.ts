import { handleCors } from "../_shared/cors.ts";
import { generateNgramApiParams } from "../_shared/api_preprocessor.ts";
import { calculateWeightedJamoDistance } from "../_shared/jamo_matcher.ts";
import { fetchDrugItemsByName, upsertDrugApiItems } from "../_shared/drug_master.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { logApiUsage, requireUser } from "../_shared/supabase.ts";

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

type PublicLookupStatus = "not_needed" | "succeeded" | "partial" | "failed" | "skipped_low_confidence";

type PublicLookupResult = {
  attempted: boolean;
  status: PublicLookupStatus;
  queriedCandidates: string[];
  insertedMedicationCount: number;
  message: string;
  forceConfirmationCandidates: Set<string>;
};

function defaultPublicLookup(status: PublicLookupStatus, message: string): PublicLookupResult {
  return {
    attempted: false,
    status,
    queriedCandidates: [],
    insertedMedicationCount: 0,
    message,
    forceConfirmationCandidates: new Set(),
  };
}

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

function isPublicLookupCandidate(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/(아침|점심|저녁|식후|식전|복용|처방|약국|전화|주의|보관|용법|용량)/.test(trimmed)) return false;
  if (/(정|캡슐|시럽|액|연고|크림|겔|패취|산|과립|점안액|mg|ml|밀리그램|밀리리터)/i.test(trimmed)) return true;
  if (/^[A-Z][A-Z0-9-]{3,}(?:\s+[A-Z0-9-]{2,})?$/.test(trimmed)) return true;
  return /[가-힣]{2,}/.test(trimmed);
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort("timeout"), ms);
  return controller.signal;
}

/**
 * OCR 원문에서 최소 2글자 이상의 의미 있는 토큰(n-gram)들을 추출하여
 * 공공 API 조회 시 0건 리턴(Zero-hit)을 방지하는 파라미터 후보군 생성 함수
 */
export function generateNgramApiParams(rawText: string, n: number = 2): string[] {
  // 1. 노이즈 제거: 공백, 단위 명칭 등 제거
  let cleaned = rawText.replace(/\s+/g, "").trim().replace(/(정|캡슐|시럽|밀리그램|mg)/g, "");
  if (cleaned.length < n) return [cleaned];

  const grams = new Set<string>();
  
  // 2. 전체 문자열 및 n-gram 토큰들 추출
  grams.add(cleaned);
  for (let i = 0; i <= cleaned.length - n; i++) {
    grams.add(cleaned.substring(i, i + n));
  }

  // 3. API 비용/트래픽을 고려해 상위 3개 키워드만 엄선
  return Array.from(grams).slice(0, 3);
}

/**
 * 자모 혼동 가중치를 반영하여, OCR 오인식(찐빠) 상황에서도
 * 가장 매칭 확률이 높은 약품을 찾아내기 위한 거리 점수 계산 함수
 */
export function getBestMatchByJamo(
  ocrTerm: string, 
  candidates: any[]
): { item: any, score: number } | null {
  if (!candidates || candidates.length === 0) return null;

  const ranked = candidates
    .map(item => ({ 
      item, 
      score: calculateWeightedJamoDistance(ocrTerm, item.ITEM_NAME || "") 
    }))
    .sort((a, b) => a.score - b.score);

  // 2.5점 이내(신뢰 구간)인 경우만 승인
  return ranked[0].score < 2.5 ? ranked[0] : null;
}

async function loadMatches(
  serviceClient: any,
  candidates: string[],
): Promise<Map<string, MedicationCandidateMatch>> {
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
    return bestByCandidate;
  }
  
// =============================== LEGACY ===============================
// async function runPublicDrugLookup(
//   serviceClient: any,
//   candidates: string[],
//   bestByCandidate: Map<string, MedicationCandidateMatch>,
//   ocrConfidence: number | null,
// ): Promise<PublicLookupResult> {
//   const unmatched = candidates.filter((candidate) => !bestByCandidate.has(candidate));
//   if (unmatched.length === 0) {
//     return defaultPublicLookup("not_needed", "내부 의약품 DB에서 후보를 찾았습니다. 공공 API 추가 조회가 필요하지 않습니다.");
//   }
//   if (ocrConfidence !== null && ocrConfidence < 0.65) {
//     return defaultPublicLookup("skipped_low_confidence", "OCR 신뢰도가 낮아 공공 의약품 API 자동 조회를 건너뛰었습니다.");
//   }

//   const lookupCandidates = unmatched.filter(isPublicLookupCandidate).slice(0, 5);
//   if (lookupCandidates.length === 0) {
//     return defaultPublicLookup("not_needed", "공공 API 조회 조건을 만족하는 약품 후보가 없습니다.");
//   }

//   const startedAt = Date.now();
//   const overallTimeoutMs = 8000;
//   let insertedMedicationCount = 0;
//   let successCount = 0;
//   let failureCount = 0;
//   const forceConfirmationCandidates = new Set<string>();

//   for (const candidate of lookupCandidates) {
//     const remaining = overallTimeoutMs - (Date.now() - startedAt);
//     if (remaining <= 0) {
//       failureCount += 1;
//       break;
//     }

//     try {
//       const items = await fetchDrugItemsByName(candidate, {
//         numOfRows: 10,
//         signal: timeoutSignal(Math.min(4000, remaining)),
//       });
//       if (items.length !== 1) {
//         forceConfirmationCandidates.add(candidate);
//       }
//       const upsertResult = await upsertDrugApiItems(serviceClient, items);
//       insertedMedicationCount += upsertResult.medicationCount;
//       successCount += 1;
//     } catch {
//       failureCount += 1;
//     }
//   }

//   const status: PublicLookupStatus = insertedMedicationCount > 0 && failureCount > 0
//     ? "partial"
//     : insertedMedicationCount > 0
//     ? "succeeded"
//     : failureCount > 0 && successCount === 0
//     ? "failed"
//     : "succeeded";

//   return {
//     attempted: true,
//     status,
//     queriedCandidates: lookupCandidates,
//     insertedMedicationCount,
//     message: status === "failed"
//       ? "공공 의약품 API 조회에 실패했습니다. 내부 DB 기준 결과만 반환합니다."
//       : insertedMedicationCount > 0
//       ? "공공 의약품 API에서 찾은 약품 정보를 저장하고 다시 매칭했습니다."
//       : "공공 의약품 API 조회는 완료됐지만 추가로 저장할 약품을 찾지 못했습니다.",
//     forceConfirmationCandidates,
//   };
// }

async function runPublicDrugLookup(
  serviceClient: any,
  candidates: string[],
  bestByCandidate: Map<string, MedicationCandidateMatch>,
  ocrConfidence: number | null,
): Promise<PublicLookupResult> {
  const unmatched = candidates.filter((c) => !bestByCandidate.has(c));
  
  if (unmatched.length === 0) {
    return defaultPublicLookup("not_needed", "내부 의약품 DB에서 후보를 찾았습니다.");
  }
  
  if (ocrConfidence !== null && ocrConfidence < 0.65) {
    return defaultPublicLookup("skipped_low_confidence", "OCR 신뢰도가 낮아 공공 의약품 API 자동 조회를 건너뛰었습니다.");
  }

  const lookupCandidates = unmatched.filter(isPublicLookupCandidate).slice(0, 5);
  if (lookupCandidates.length === 0) {
    return defaultPublicLookup("not_needed", "공공 API 조회 조건을 만족하는 약품 후보가 없습니다.");
  }

  const startedAt = Date.now();
  const overallTimeoutMs = 8000;
  let insertedMedicationCount = 0;
  let successCount = 0;
  let failureCount = 0;
  const forceConfirmationCandidates = new Set<string>();

  for (const rawOcrTerm of lookupCandidates) {
    const remaining = overallTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      failureCount += 1;
      break;
    }

    try {
      // L3: N-gram 파라미터 생성
      const keywords = generateNgramApiParams(rawOcrTerm);
      
      // 외부 API 호출: 여기도 try-catch로 감싸서 API 응답 장애에 대비함
      const apiResults = await Promise.all(
        keywords.map(k => fetchDrugItemsByName(k).catch(() => []))
      );
      const mergedItems = apiResults.flat();

      // L4: 자모 정밀 매칭
      const match = getBestMatchByJamo(rawOcrTerm, mergedItems);
      
      if (match) {
        // DB Upsert: 가장 위험한 부분, 여기서 에러가 나도 파이프라인 전체가 죽지 않도록 예외 처리
        try {
          const upsertResult = await upsertDrugApiItems(serviceClient, [match.item]);
          insertedMedicationCount += upsertResult.medicationCount;
          
          bestByCandidate.set(rawOcrTerm, {
            search_text: rawOcrTerm,
            id: upsertResult.medicationIds[0],
            item_seq: match.item.ITEM_SEQ || match.item.item_seq || null,
            item_name: match.item.ITEM_NAME || match.item.item_name || "",
            entp_name: match.item.ENTP_NAME || match.item.entp_name || null,
            edi_code: match.item.EDI_CODE || match.item.edi_code || null,
            similarity_score: 1.0 - (match.score / 10),
            match_rank: 1,
            match_source: "fuzzy"
          });
          successCount += 1;
        } catch {
          failureCount += 1;
        }
      } else {
        forceConfirmationCandidates.add(rawOcrTerm);
      }
    } catch (pipelineError) {
      // 파이프라인 전체 에러 핸들링
      console.error(`[폴백 파이프라인 실패] ${rawOcrTerm}:`, pipelineError);
      failureCount += 1;
    }
  }

  const status: PublicLookupStatus = insertedMedicationCount > 0 && failureCount > 0
    ? "partial"
    : insertedMedicationCount > 0
    ? "succeeded"
    : failureCount > 0 && successCount === 0
    ? "failed"
    : "succeeded";

  return {
    attempted: true,
    status,
    queriedCandidates: lookupCandidates,
    insertedMedicationCount,
    message: status === "failed"
      ? "공공 의약품 API 조회에 실패했습니다."
      : insertedMedicationCount > 0
      ? "공공 의약품 API에서 정밀 매칭된 정보를 저장했습니다."
      : "조회는 완료됐지만 매칭되는 약품을 찾지 못했습니다.",
    forceConfirmationCandidates,
  };
}

  const status: PublicLookupStatus = insertedMedicationCount > 0 && failureCount > 0
    ? "partial"
    : insertedMedicationCount > 0
    ? "succeeded"
    : failureCount > 0 && successCount === 0
    ? "failed"
    : "succeeded";

  return {
    attempted: true,
    status,
    queriedCandidates: lookupCandidates,
    insertedMedicationCount,
    message: status === "failed"
      ? "공공 의약품 API 조회에 실패했습니다."
      : insertedMedicationCount > 0
      ? "공공 의약품 API에서 정밀 매칭된 정보를 저장했습니다."
      : "조회는 완료됐지만 매칭되는 약품을 찾지 못했습니다.",
    forceConfirmationCandidates,
  };
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
      .select("id,user_id,ocr_text,confidence")
      .eq("id", body.scanId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (scanError) throw new HttpError(500, "Failed to load scan session", scanError);
    if (!scan) throw new HttpError(404, "Scan session not found");
    if (!scan.ocr_text) throw new HttpError(400, "Scan session has no OCR text");

    const candidates = extractCandidates(scan.ocr_text);
    

    
    const detectedRows = [];
    const unmatchedCandidates: string[] = [];
    let bestByCandidate = await loadMatches(serviceClient, candidates);

    //===
    const publicLookup = await runPublicDrugLookup(
      serviceClient,
      candidates,
      bestByCandidate,
      typeof scan.confidence === "number" ? scan.confidence : null,
    );
    if (publicLookup.insertedMedicationCount > 0) {
      bestByCandidate = await loadMatches(serviceClient, candidates);
    }
    if (publicLookup.attempted) {
      await logApiUsage(serviceClient, {
        userId: user.id,
        provider: "data_go_kr",
        endpoint: "getDrugPrdtPrmsnDtlInq06:cache-aside",
        status: publicLookup.status === "failed" ? "failed" : "succeeded",
        requestCount: Math.max(publicLookup.queriedCandidates.length, 1),
      });
    }

    for (const candidate of candidates) {
      const best = bestByCandidate.get(candidate);
      const confidence = best?.similarity_score ?? 0;
      const isExact = best?.item_name === candidate || best?.edi_code === candidate || best?.match_source === "exact";
      const matchSource = best?.match_source ?? (isExact ? "exact" : best ? "fuzzy" : "none");
      const forcePublicConfirmation = publicLookup.forceConfirmationCandidates.has(candidate);
      const needsBrandConfirmation = Boolean(best) &&
        (forcePublicConfirmation || (best?.alias_requires_confirmation ?? (!isExact && isBroadLatinBrand(candidate))));
      const quality = needsBrandConfirmation || forcePublicConfirmation
        ? "medium"
        : matchQuality(isExact ? 1 : confidence, Boolean(best));
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
          needs_confirmation: forcePublicConfirmation || needsBrandConfirmation || (!isExact && confidence < 0.82),
          warning_message: !best
            ? "공식 의약품 DB에서 확실한 매칭을 찾지 못했습니다. 약사 또는 의사에게 확인하세요."
            : forcePublicConfirmation
            ? "공공 의약품 DB에서 여러 후보가 확인되었습니다. 사용자가 세부 제품명, 함량, 제형을 확인해야 합니다."
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
      publicLookup: {
        attempted: publicLookup.attempted,
        status: publicLookup.status,
        queriedCandidates: publicLookup.queriedCandidates,
        insertedMedicationCount: publicLookup.insertedMedicationCount,
        message: publicLookup.message,
      },
      recommendedAction: recommendedActionForMode(resultMode),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
