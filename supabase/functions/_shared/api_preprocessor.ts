// supabase/functions/_shared/api_preprocessor.ts

export function generateNgramApiParams(rawText: string, n: number = 2): string[] {
  // 1. 노이즈 제거
  let cleaned = rawText.replace(/\s+/g, "").trim().replace(/(정|캡슐|시럽|밀리그램|mg)/g, "");
  if (cleaned.length < n) return [cleaned];

  const grams = new Set<string>();
  
  // 전체 문자열 주입
  grams.add(cleaned);

  // n-gram 생성
  for (let i = 0; i <= cleaned.length - n; i++) {
    grams.add(cleaned.substring(i, i + n));
  }

  // 너무 많은 API 호출 방지를 위해 상위 3개만 반환
  return Array.from(grams).slice(0, 3);
}