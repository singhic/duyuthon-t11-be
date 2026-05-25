export type DrugNameParts = {
  raw: string;
  normalized: string;
  baseName: string;
  coreName: string;
  manufacturerName: string | null;
  ingredient: string | null;
  form: string | null;
  strength: string | null;
};

const STRENGTH_PATTERN =
  /\d+(?:\.\d+)?(?:mg|g|mcg|ug|μg|㎎|밀리그램|밀리그람|ml|mL|㎖|IU|iu|단위)(?:\/\d+(?:\.\d+)?(?:ml|mL|㎖))?/gi;

const FORM_ENDINGS = [
  "구강붕해정",
  "필름코팅정",
  "서방캡슐",
  "건조시럽",
  "장용정",
  "서방정",
  "점안액",
  "흡입제",
  "캡슐",
  "시럽",
  "과립",
  "패취",
  "패치",
  "연고",
  "크림",
  "겔",
  "액",
  "주",
  "산",
  "정",
];

const COMPANY_SUFFIXES = [
  "바이오",
  "제약",
  "약품",
  "신약",
  "메디칼",
  "메디카",
  "메디텍",
  "헬스케어",
  "생명과학",
  "팜",
];

function normalizeDrugText(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/㎎/g, "mg")
    .replace(/㎖/g, "mL")
    .trim();
}

function normalizeStrength(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/\s+/g, "")
    .replace(/㎎/g, "mg")
    .replace(/㎖/g, "mL")
    .replace(/밀리그람|밀리그램/g, "mg")
    .toLowerCase();
}

function extractIngredient(value: string): string | null {
  const matches = [...value.matchAll(/\(([^)]{2,})\)/g)];
  const ingredient = matches.at(-1)?.[1]?.trim();
  return ingredient ? normalizeDrugText(ingredient) : null;
}

function stripParentheses(value: string): string {
  return value.replace(/\([^)]*\)/g, "");
}

function extractStrength(value: string): string | null {
  const matches = [...value.matchAll(STRENGTH_PATTERN)];
  return normalizeStrength(matches.at(-1)?.[0] ?? null);
}

function stripStrength(value: string): string {
  return value.replace(STRENGTH_PATTERN, "");
}

function extractForm(value: string): string | null {
  return FORM_ENDINGS.find((form) => value.endsWith(form)) ?? null;
}

function stripForm(value: string, form: string | null): string {
  return form ? value.slice(0, -form.length) : value;
}

function splitManufacturerPrefix(baseName: string): { manufacturerName: string | null; coreName: string } {
  for (const suffix of COMPANY_SUFFIXES) {
    const index = baseName.indexOf(suffix);
    const end = index + suffix.length;
    if (index >= 1 && end <= 10 && baseName.length - end >= 3) {
      return {
        manufacturerName: baseName.slice(0, end),
        coreName: baseName.slice(end),
      };
    }
  }
  return {
    manufacturerName: null,
    coreName: baseName,
  };
}

function uniqueTerms(terms: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const term of terms) {
    const normalized = normalizeDrugText(term ?? "");
    if (normalized.length >= 2) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

export function parseDrugNameParts(raw: string | null | undefined): DrugNameParts {
  const normalized = normalizeDrugText(raw ?? "");
  const ingredient = extractIngredient(normalized);
  const withoutParentheses = stripParentheses(normalized);
  const strength = extractStrength(withoutParentheses);
  const withoutStrength = stripStrength(withoutParentheses);
  const form = extractForm(withoutStrength);
  const baseName = stripForm(withoutStrength, form);
  const { manufacturerName, coreName } = splitManufacturerPrefix(baseName);

  return {
    raw: raw ?? "",
    normalized,
    baseName,
    coreName,
    manufacturerName,
    ingredient,
    form,
    strength,
  };
}

export function drugNameSearchTerms(raw: string | null | undefined): string[] {
  const parts = parseDrugNameParts(raw);
  const withoutStrength = stripStrength(stripParentheses(parts.normalized));
  const withoutForm = stripForm(withoutStrength, extractForm(withoutStrength));

  return uniqueTerms([
    parts.normalized,
    withoutStrength,
    withoutForm,
    parts.baseName,
    parts.coreName,
    parts.ingredient,
  ]).slice(0, 8);
}

export function drugCoreTerms(raw: string | null | undefined): string[] {
  const parts = parseDrugNameParts(raw);
  return uniqueTerms([
    parts.ingredient,
    parts.coreName,
    parts.baseName,
  ]);
}

export function isCompatibleDrugCore(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftTerms = drugCoreTerms(left).filter((term) => term.length >= 3);
  const rightTerms = drugCoreTerms(right).filter((term) => term.length >= 3);

  return leftTerms.some((leftTerm) =>
    rightTerms.some((rightTerm) =>
      leftTerm === rightTerm ||
      leftTerm.startsWith(rightTerm) ||
      rightTerm.startsWith(leftTerm) ||
      leftTerm.includes(rightTerm) ||
      rightTerm.includes(leftTerm)
    )
  );
}

export function formCompatible(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  if (left === right) return true;
  return left.endsWith("정") && right.endsWith("정");
}

export function strengthCompatible(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  return normalizeStrength(left) === normalizeStrength(right);
}

export function variantKey(raw: string | null | undefined): string {
  const parts = parseDrugNameParts(raw);
  return `${parts.form ?? ""}|${parts.strength ?? ""}`;
}
