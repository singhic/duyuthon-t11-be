// supabase/functions/_shared/api_preprocessor.ts

export function generateOcrCorrectionVariants(rawText: string): string[] {
  const compact = rawText.replace(/\s+/g, "").trim();
  if (!compact) return [];

  const variants = new Set<string>();

  if (compact.startsWith("대응바이오클래리트로마")) {
    variants.add(compact.replace(/^대응바이오클래리트로마/, "대웅바이오클래리트로마"));
  }

  return Array.from(variants);
}

export function generateNgramApiParams(rawText: string, n: number = 2): string[] {
  const compact = rawText.replace(/\s+/g, "").trim();
  if (!compact) return [];

  const grams = new Set<string>();
  const correctedVariants = generateOcrCorrectionVariants(compact);
  const withoutDoseUnit = compact.replace(/(밀리그램|밀리그람|mg|mL|ml)$/i, "");
  const withoutDrugForm = withoutDoseUnit.replace(/(정|캡슐|시럽|액|주|연고|크림|겔|패취|패치|산|과립|점안액|흡입제)$/i, "");

  // Exact-first: public APIs often match official item_name only when the full
  // photographed drug name is preserved.
  grams.add(compact);
  grams.add(withoutDoseUnit);
  grams.add(withoutDrugForm);
  for (const corrected of correctedVariants) {
    grams.add(corrected);
    grams.add(corrected.replace(/(정|캡슐|시럽|액|주|연고|크림|겔|패취|패치|산|과립|점안액|흡입제)$/i, ""));
  }

  // Korean product names often start with a short manufacturer prefix, e.g.
  // 안국레바미피드정 -> 레바미피드정. Try the tail before falling back to n-grams.
  for (const prefixLength of [2, 3]) {
    if (compact.length > prefixLength + n) {
      const tail = compact.slice(prefixLength);
      grams.add(tail);
      grams.add(tail.replace(/(정|캡슐|시럽|액|주|연고|크림|겔|패취|패치|산|과립|점안액|흡입제)$/i, ""));
    }
  }

  if (compact.length < n) return Array.from(grams).filter(Boolean);

  for (let i = 0; i <= compact.length - n; i++) {
    grams.add(compact.substring(i, i + n));
  }

  return Array.from(grams).filter(Boolean).slice(0, 6);
}
