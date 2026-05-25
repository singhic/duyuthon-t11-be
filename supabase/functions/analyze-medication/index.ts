import { handleCors } from "../_shared/cors.ts";
import { generateNgramApiParams, generateOcrCorrectionVariants } from "../_shared/api_preprocessor.ts";
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

type AlternativeMedicationCandidate = {
  id: string;
  item_seq: string | null;
  item_name: string;
  entp_name: string | null;
  edi_code: string | null;
  search_text: string;
  similarity_score: number;
  match_rank: number;
  match_source?: string;
};

type MatchLookupResult = {
  bestByCandidate: Map<string, MedicationCandidateMatch>;
  alternativesByCandidate: Map<string, AlternativeMedicationCandidate[]>;
};

type CandidateEntry = {
  value: string;
  score: number;
  index: number;
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

function compactText(text: string): string {
  return text.replace(/\s+/g, "").trim();
}

const DRUG_FORM_ENDING = /(정|캡슐|시럽|액|주|연고|크림|겔|패취|패치|산|과립|점안액|흡입제)$/i;

const NON_DRUG_TEXT_PATTERN =
  /(환자정보|환자정|교부번호|병원정보|병원정|약품사진|약품명|영수증|현금|전액|혼인|공휴|휴원|하세요|공공심야|경기도|봉투|조은봉투|조제약|복약안내|서식|마크로라이드|비스테로이드|스테로이드|진해거담|기침|감염증|치료|항생제|통증|증상|완화|내려주|와주는|약입니다|면역억제|소염작용|호르몬|위점막보호|소화성|위궤양|위염|보호제|코막힘|콧물|졸음|감기로|구형과립|필름코팅|원형정제|장방형|담황색|흰색|황색|주황색|회백색)/i;

const APPEARANCE_WORDS = new Set([
  // 색상
  "흰색","하얀색","백색","노란색","황색","담황색","연황색","주황색","등황색",
  "분홍색","연분홍색","빨간색","적색","담적색","파란색","청색","담청색",
  "녹색","연녹색","갈색","황갈색","적갈색","보라색","자색","회색","회백색",
  "무색","투명","반투명",
  // 모양
  "원형","타원형","장방형","삼각형","사각형","오각형","육각형",
  "팔각형","반원형","렌즈형","캡슐형",
  // 제형
  "정제","필름코팅정","당의정","장용정","구강붕해정","서방정","지속성정",
  "발포정","저작정","경질캡슐","연질캡슐","장용캡슐","과립","세립",
  "미립","분말","시럽","용액","현탁액","유제","주사제",
  // 외용제
  "연고","크림","겔","로션","패취","패치",
  // 투여 경로
  "점안액","점이액","점비액","흡입제","스프레이","에어로졸",
  // 기타
  "장용성","필름코팅","당코팅","코팅",
]);

function normalizeAppearanceText(text: string): string {
  return text
    .replace(/의/g, " ")
    .replace(/제$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPureAppearanceLine(line: string): boolean {
  const normalized = normalizeAppearanceText(line);
  const compact = compactText(normalized);

  let count = 0;

  for (const token of normalized.split(/\s+/)) {
    if (APPEARANCE_WORDS.has(token)) {
      count++;

      if (count >= 2) {
        return true;
      }
    }
  }

  for (const word of APPEARANCE_WORDS) {
    if (word.length >= 2 && compact.includes(word)) {
      count++;
      if (count >= 2) {
        return true;
      }
    }
  }

  return false;
}

function isDoseOrReceiptLine(line: string): boolean {
  const compact = compactText(line);
  return /^\d+\s*(회|일|정|포|캡슐|mg|ml|밀리그램|밀리리터|원)$/i.test(line.trim()) ||
    /^[\d원]+$/.test(compact) ||
    /^\d+\s+\d+$/.test(line.trim());
}

function isLikelyNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (isDoseOrReceiptLine(trimmed)) return true;
  if (NON_DRUG_TEXT_PATTERN.test(trimmed)) return true;
  if (isPureAppearanceLine(trimmed)) return true;
  return false;
}

function isStrongDrugNameCandidate(candidate: string): boolean {
  const compact = compactText(candidate);
  if (compact.length < 3 || compact.length > 60) return false;
  if (!/[가-힣]/.test(compact)) return false;
  if (isLikelyNoiseLine(candidate)) return false;
  if (DRUG_FORM_ENDING.test(compact)) return true;
  return /[가-힣]{4,}/.test(compact);
}

function scoreCandidate(candidate: string, index: number, medicationSectionStart: number): number {
  let score = 0;
  const compact = compactText(candidate);

  if (isStrongDrugNameCandidate(candidate)) score += 100;
  if (DRUG_FORM_ENDING.test(compact)) score += 40;
  if (index > medicationSectionStart) score += 25;
  if (/\d{5,}/.test(compact)) score -= 30;
  if (isLikelyNoiseLine(candidate)) score -= 120;
  if (/^[A-Z][A-Z0-9-]{3,}(?:\s+[A-Z0-9-]{2,})?$/.test(candidate)) score += 30;

  return score;
}

export function isUsefulCandidateLine(line: string): boolean {
  const trimmed = line.trim();

  // 1. 길이 제한
  if (trimmed.length < 2 || trimmed.length > 80) {
    return false;
  }

  // 2. 순수 숫자 제거
  if (/^\d+$/.test(trimmed)) {
    return false;
  }

  // 3. 복약 지시문 / 약국 정보 제거
  const instructionNoise =
    /(약국|전화|tel|주의|보관|용법|용량|식후|식전|취침전|복용|처방|조제)/i;

  if (instructionNoise.test(trimmed)) {
    return false;
  }

  if (isDoseOrReceiptLine(trimmed)) {
    return false;
  }

  // 4. 순수 성상 정보 제거
  if (isPureAppearanceLine(trimmed)) {
    return false;
  }

  // 5. OCR 영문 파편 제거
  if (/^[A-Za-z]{1,3}$/.test(trimmed)) {
    return false;
  }

  // 6. 최종 화이트리스트
  const hasKorean = /[가-힣]/.test(trimmed);

  const hasDrugForm =
    /(정|캡슐|시럽|액|주|연고|크림|겔|패취|산|과립|점안액|흡입제)/.test(
      trimmed
    );

  return hasKorean || hasDrugForm || trimmed.length >= 3; //4->3: 피디정 같은건 3글자라 완화
}

function extractCandidates(ocrText: string): string[] {
  const normalizedLines = ocrText
    .split(/[\n\r,;]+|\s{3,}/) /* 스플릿 기준 변경 2 -> 3 : 약제 설명 오인식 문제 해결용임. */
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const medicationSectionStart = normalizedLines.findIndex((line) => /약품명/.test(line));
  const entries: CandidateEntry[] = [];

  for (let index = 0; index < normalizedLines.length - 1; index += 1) {
    const current = normalizedLines[index];
    const next = normalizedLines[index + 1];
    if (/^[A-Z][A-Z0-9-]{3,}$/.test(current) && /^[A-Z0-9-]{2,4}$/.test(next)) {
      const value = `${current} ${next}`;
      entries.push({
        value,
        score: scoreCandidate(value, index, medicationSectionStart),
        index,
      });
    }
  }

  normalizedLines.forEach((line, index) => {
    if (!isUsefulCandidateLine(line)) return;

    entries.push({
      value: line,
      score: scoreCandidate(line, index, medicationSectionStart),
      index,
    });

    const koreanDrugPattern = /[가-힣A-Za-z0-9()[\]-]{2,}(정|캡슐|시럽|액|주|연고|크림|겔|패취|산|과립|점안액|흡입제)/g;
    for (const match of line.matchAll(koreanDrugPattern)) {
      entries.push({
        value: match[0],
        score: scoreCandidate(match[0], index, medicationSectionStart) + 30,
        index,
      });
    }

    const latinBrandPattern = /\b[A-Z][A-Z0-9-]{3,}\b/g;
    for (const match of line.matchAll(latinBrandPattern)) {
      entries.push({
        value: match[0],
        score: scoreCandidate(match[0], index, medicationSectionStart),
        index,
      });
    }
  });

  const bestByValue = new Map<string, CandidateEntry>();
  for (const entry of entries) {
    const value = entry.value.trim();
    if (!value || /^[A-Z]$|^\d+$/.test(value)) continue;
    if (entry.score < 20) continue;

    const previous = bestByValue.get(value);
    if (!previous || entry.score > previous.score || (entry.score === previous.score && entry.index < previous.index)) {
      bestByValue.set(value, { ...entry, value });
    }
  }

  const uniqueCandidates = [...bestByValue.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.value);
  const specificCandidates = uniqueCandidates.filter(
    (candidate) => !uniqueCandidates.some((other) => other !== candidate && other.startsWith(`${candidate} `)),
  );

  return specificCandidates.slice(0, 40);
}

function isBroadLatinBrand(candidate: string): boolean {
  return /^[A-Z][A-Z0-9-]{3,}$/.test(candidate);
}

function isPublicLookupCandidate(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (isLikelyNoiseLine(trimmed)) return false;
  if (/(아침|점심|저녁|식후|식전|복용|처방|약국|전화|주의|보관|용법|용량)/.test(trimmed)) return false;
  if (/(정|캡슐|시럽|액|연고|크림|겔|패취|패치|산|과립|점안액|mg|ml|밀리그램|밀리리터)$/i.test(compactText(trimmed))) {
    return isStrongDrugNameCandidate(trimmed);
  }
  if (/^[A-Z][A-Z0-9-]{3,}(?:\s+[A-Z0-9-]{2,})?$/.test(trimmed)) return true;
  return isStrongDrugNameCandidate(trimmed);
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort("timeout"), ms);
  return controller.signal;
}

function normalizeDrugNameForCompare(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isStrongNamePrefix(searchText: string, itemName: string | null | undefined): boolean {
  const search = normalizeDrugNameForCompare(searchText);
  const item = normalizeDrugNameForCompare(itemName);
  const minLength = DRUG_FORM_ENDING.test(search) ? 3 : 4;
  return search.length >= minLength && item.startsWith(search);
}

function isAcceptableCandidateMatch(match: MedicationCandidateMatch): boolean {
  if (match.match_source === "exact" || ["alias", "edi_code", "barcode"].includes(match.match_source ?? "")) {
    return true;
  }
  if ((match.similarity_score ?? 0) >= 0.65) {
    return true;
  }
  return isStrongNamePrefix(match.search_text, match.item_name);
}

function candidateSearchVariants(candidate: string): string[] {
  return [
    candidate,
    ...generateOcrCorrectionVariants(candidate),
  ].map((variant) => variant.trim()).filter(Boolean);
}

function toAlternativeCandidate(match: MedicationCandidateMatch): AlternativeMedicationCandidate {
  return {
    id: match.id,
    item_seq: match.item_seq,
    item_name: match.item_name,
    entp_name: match.entp_name,
    edi_code: match.edi_code,
    search_text: match.search_text,
    similarity_score: match.similarity_score,
    match_rank: match.match_rank,
    match_source: match.match_source,
  };
}

function getAmbiguousPrefixMatches(
  originalCandidate: string,
  matches: MedicationCandidateMatch[],
): MedicationCandidateMatch[] {
  if (DRUG_FORM_ENDING.test(compactText(originalCandidate))) return [];

  const prefixMatches = matches.filter((match) =>
    match.match_source === "fuzzy" &&
    isStrongNamePrefix(match.search_text, match.item_name)
  );
  const distinctIds = new Set(prefixMatches.map((match) => match.id));
  return distinctIds.size > 1 ? prefixMatches : [];
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
      score: isStrongNamePrefix(ocrTerm, item.ITEM_NAME || item.item_name)
        ? 0.5
        : calculateWeightedJamoDistance(ocrTerm, item.ITEM_NAME || item.item_name || "")
    }))
    .sort((a, b) => a.score - b.score);

  // 2.5점 이내(신뢰 구간)인 경우만 승인
  return ranked[0].score < 2.5 ? ranked[0] : null;
}

async function loadMatches(
  serviceClient: any,
  candidates: string[],
): Promise<MatchLookupResult> {
  const variantToCandidate = new Map<string, string>();
  for (const candidate of candidates) {
    for (const variant of candidateSearchVariants(candidate)) {
      if (!variantToCandidate.has(variant)) {
        variantToCandidate.set(variant, candidate);
      }
    }
  }

  const searchTexts = [...variantToCandidate.keys()];
  const { data: matches, error: matchError } = searchTexts.length > 0
    ? await serviceClient
      .rpc("find_medication_candidates_bulk", {
        search_texts: searchTexts,
        max_results: 5,
      })
    : { data: [], error: null };

    if (matchError) throw new HttpError(500, "Failed to match medication candidates", matchError);
    
    const groupedMatches = new Map<string, MedicationCandidateMatch[]>();
    for (const match of (matches ?? []) as MedicationCandidateMatch[]) {
      if (!isAcceptableCandidateMatch(match)) {
        continue;
      }

      const originalCandidate = variantToCandidate.get(match.search_text) ?? match.search_text;
      const existing = groupedMatches.get(originalCandidate) ?? [];
      if (!existing.some((item) => item.id === match.id)) {
        existing.push(match);
      }
      groupedMatches.set(originalCandidate, existing);
    }

    const bestByCandidate = new Map<string, MedicationCandidateMatch>();
    const alternativesByCandidate = new Map<string, AlternativeMedicationCandidate[]>();

    for (const [candidate, candidateMatches] of groupedMatches.entries()) {
      const sortedMatches = candidateMatches.sort((a, b) =>
        a.match_rank - b.match_rank ||
        b.similarity_score - a.similarity_score ||
        a.item_name.localeCompare(b.item_name)
      );

      const ambiguousPrefixMatches = getAmbiguousPrefixMatches(candidate, sortedMatches);
      if (ambiguousPrefixMatches.length > 0) {
        alternativesByCandidate.set(candidate, ambiguousPrefixMatches.map(toAlternativeCandidate));
        continue;
      }

      bestByCandidate.set(candidate, sortedMatches[0]);
    }

    return {
      bestByCandidate,
      alternativesByCandidate,
    };
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

  const lookupCandidates = unmatched
    .filter(isPublicLookupCandidate)
    .sort((a, b) => scoreCandidate(b, 0, -1) - scoreCandidate(a, 0, -1))
    .slice(0, 5);
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
      const requestSignal = timeoutSignal(Math.min(4000, remaining));
      const apiResults = await Promise.all(
        keywords.map((keyword) =>
          fetchDrugItemsByName(keyword, { signal: requestSignal }).catch(() => [])
        )
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
    let matchLookup = await loadMatches(serviceClient, candidates);
    let bestByCandidate = matchLookup.bestByCandidate;
    let alternativesByCandidate = matchLookup.alternativesByCandidate;

    //===
    const publicLookup = await runPublicDrugLookup(
      serviceClient,
      candidates,
      bestByCandidate,
      typeof scan.confidence === "number" ? scan.confidence : null,
    );
    if (publicLookup.insertedMedicationCount > 0) {
      const refreshedMatches = await loadMatches(serviceClient, candidates);
      bestByCandidate = new Map([...refreshedMatches.bestByCandidate, ...bestByCandidate]);
      alternativesByCandidate = new Map([
        ...alternativesByCandidate,
        ...refreshedMatches.alternativesByCandidate,
      ]);
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
      const rawBest = bestByCandidate.get(candidate);
      const alternativeCandidates = alternativesByCandidate.get(candidate) ?? [];
      const rawConfidence = rawBest?.similarity_score ?? 0;
      const rawIsExact = rawBest?.item_name === candidate || rawBest?.edi_code === candidate || rawBest?.match_source === "exact";
      const best = rawBest && (
        rawIsExact ||
        rawConfidence >= 0.65 ||
        ["alias", "edi_code", "barcode"].includes(rawBest.match_source ?? "") ||
        isStrongNamePrefix(candidate, rawBest.item_name)
      )
        ? rawBest
        : undefined;
      const confidence = best?.similarity_score ?? 0;
      const isExact = best?.item_name === candidate || best?.edi_code === candidate || best?.match_source === "exact";
      const matchSource = best?.match_source ?? (isExact ? "exact" : best ? "fuzzy" : "none");
      const forcePublicConfirmation = publicLookup.forceConfirmationCandidates.has(candidate);
      const needsAlternativeConfirmation = alternativeCandidates.length > 0;
      const displayConfidence = confidence || alternativeCandidates[0]?.similarity_score || 0;
      const effectiveMatchSource = needsAlternativeConfirmation ? "fuzzy" : matchSource;
      const needsBrandConfirmation = Boolean(best) &&
        (forcePublicConfirmation || (best?.alias_requires_confirmation ?? (!isExact && isBroadLatinBrand(candidate))));
      const quality = needsAlternativeConfirmation || needsBrandConfirmation || forcePublicConfirmation
        ? "medium"
        : matchQuality(isExact ? 1 : confidence, Boolean(best));
      if (!best && !needsAlternativeConfirmation) unmatchedCandidates.push(candidate);

      if (best || needsAlternativeConfirmation || candidate.length >= 3) {
        detectedRows.push({
          scan_id: scan.id,
          medication_id: best?.id ?? null,
          detected_name: candidate,
          matched_name: best?.item_name ?? null,
          confidence: isExact ? 1 : Math.min(Math.max(displayConfidence, 0), 0.99),
          match_method: effectiveMatchSource,
          match_quality: quality,
          needs_confirmation: needsAlternativeConfirmation || forcePublicConfirmation || needsBrandConfirmation || (!isExact && confidence < 0.82),
          warning_message: needsAlternativeConfirmation
            ? "여러 의약품 후보가 확인되었습니다. 함량과 제형을 사용자가 확인해야 합니다."
            : !best
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
    const enrichedDetectedWithAlternatives = (enrichedDetected ?? []).map((row: any) => ({
      ...row,
      alternativeCandidates: alternativesByCandidate.get(row.detected_name) ?? [],
    }));

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
    const informationAvailability = summarizeInformationAvailability(enrichedDetectedWithAlternatives as DetectedMedicationRow[]);

    return json({
      scanId: scan.id,
      candidates,
      detectedMedications: enrichedDetectedWithAlternatives,
      alternativeMedicationCandidates: Object.fromEntries(alternativesByCandidate),
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
