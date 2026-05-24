// supabase/functions/_shared/jamo_matcher.ts

// 1. OCR 엔진이 선, 접힘, 흐림 때문에 가장 자주 혼동하는 자모 쌍의 오차 가중치 정의
const VISUAL_SUBSTITUTION_COSTS: Record<string, Record<string, number>> = {
  "ㅌ": { "ㄷ": 0.4, "ㄹ": 0.7 },
  "ㄷ": { "ㅌ": 0.4, "ㄴ": 0.6 },
  "ㄲ": { "ㄱ": 0.4 },
  "ㄱ": { "ㄲ": 0.4, "ㅋ": 0.6 },
  "ㅂ": { "ㅍ": 0.5, "ㅁ": 0.7 },
  "ㅍ": { "ㅂ": 0.5 },
  "ㅏ": { "ㅣ": 0.3, "ㅓ": 0.5 },
  "ㅣ": { "ㅏ": 0.3, "ㅔ": 0.5 },
  "ㅗ": { "ㅜ": 0.4, "ㅡ": 0.5 },
  "ㅜ": { "ㅗ": 0.4, "ㅡ": 0.5 },
  "ㅡ": { "ㅜ": 0.5, "ㅗ": 0.5, "ㅣ": 0.6 },
};

/**
 * 한글 유니코드를 분석하여 초성, 중성, 종성 자모 문자열로 완전히 해체하는 함수
 */
export function disassembleHangeul(text: string): string {
  const result: string[] = [];
  const CHOSUNG = [
    "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", 
    "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"
  ];
  const JOONSUNG = [
    "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", 
    "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅛ", "ㅡ", "ㅢ", "ㅣ"
  ];
  const JONGSUNG = [
    "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄴㅈ", "ㄴㅎ", "ㄷ", "ㄹ", "ㄹㄱ", 
    "ㄹㅁ", "ㄹㅂ", "ㄹㅅ", "ㄹㅌ", "ㄹㅍ", "ㄹㅎ", "ㅁ", "ㅂ", "ㅄ", 
    "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"
  ];

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) - 44032;
    if (code > -1 && code < 11172) {
      const cho = Math.floor(code / 588);
      const jung = Math.floor((code - cho * 588) / 28);
      const jong = code % 28;
      result.push(CHOSUNG[cho], JOONSUNG[jung]);
      if (JONGSUNG[jong]) result.push(JONGSUNG[jong]);
    } else {
      result.push(text[i].toLowerCase());
    }
  }
  return result.join("");
}

/**
 * 시각적 유사성을 고려한 두 자모 문자 간의 변형 비용 반환
 */
function getSubstitutionCost(charA: string, charB: string): number {
  if (charA === charB) return 0;
  if (VISUAL_SUBSTITUTION_COSTS[charA]?.[charB] !== undefined) {
    return VISUAL_SUBSTITUTION_COSTS[charA][charB];
  }
  if (VISUAL_SUBSTITUTION_COSTS[charB]?.[charA] !== undefined) {
    return VISUAL_SUBSTITUTION_COSTS[charB][charA];
  }
  return 1.0;
}

/**
 * 시각적 혼동 가중치 행렬이 결합된 Levenshtein Edit Distance 계산 (낮을수록 일치)
 */
export function calculateWeightedJamoDistance(strA: string, strB: string): number {
  const jamoA = disassembleHangeul(strA.replace(/\s+/g, ""));
  const jamoB = disassembleHangeul(strB.replace(/\s+/g, ""));
  
  const lenA = jamoA.length;
  const lenB = jamoB.length;

  const dp: number[][] = Array.from({ length: lenA + 1 }, () => Array(lenB + 1).fill(0));

  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const deletion = dp[i - 1][j] + 1;
      const insertion = dp[i][j - 1] + 1;
      const substitution = dp[i - 1][j - 1] + getSubstitutionCost(jamoA[i - 1], jamoB[j - 1]);
      dp[i][j] = Math.min(deletion, insertion, substitution);
    }
  }
  return dp[lenA][lenB];
}