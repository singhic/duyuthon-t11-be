import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson, requireEnv } from "../_shared/http.ts";
import { logApiUsage, requireAdmin, requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  pageNo?: number;
  numOfRows?: number;
  itemName?: string;
};

type DrugApiItem = {
  ITEM_SEQ?: string;
  item_seq?: string;
  ITEM_NAME?: string;
  item_name?: string;
  ENTP_NAME?: string;
  entp_name?: string;
  EDI_CODE?: string;
  edi_code?: string;
  ATC_CODE?: string;
  atc_code?: string;
  BAR_CODE?: string;
  bar_code?: string;
  MAIN_ITEM_INGR?: string;
  main_item_ingr?: string;
  STORAGE_METHOD?: string;
  storage_method?: string;
  EE_DOC_DATA?: string;
  ee_doc_data?: string;
  UD_DOC_DATA?: string;
  ud_doc_data?: string;
  NB_DOC_DATA?: string;
  nb_doc_data?: string;
  MATERIAL_NAME?: string;
  material_name?: string;
  VALID_TERM?: string;
  raw?: unknown;
};

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getField(item: DrugApiItem, upper: keyof DrugApiItem, lower: keyof DrugApiItem): string | null {
  const value = item[upper] ?? item[lower];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseBarCodes(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseIngredients(value: string | null): Array<{ code: string | null; name: string }> {
  if (!value) return [];
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^\[([^\]]+)\](.+)$/);
      return match
        ? { code: match[1].trim(), name: match[2].trim() }
        : { code: null, name: part };
    })
    .filter((ingredient) => ingredient.name.length > 0);
}

function normalizeIngredientName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

function detectAdministrationTiming(dosage: string | null): "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom" | "unknown" {
  if (!dosage) return "unknown";
  if (/식전|식사\s*전/.test(dosage)) return "before_meal";
  if (/식후|식사\s*후/.test(dosage)) return "after_meal";
  if (/식사\s*중|식중/.test(dosage)) return "with_meal";
  if (/취침|자기\s*전/.test(dosage)) return "bedtime";
  return "custom";
}

function completeness(payload: Record<string, string | null>): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, Boolean(value?.trim())]),
  );
}

function knownAliasesForItem(itemName: string): string[] {
  const aliases = new Set<string>();
  if (/타이레놀/i.test(itemName)) aliases.add("TYLENOL");
  if (/타이레놀/i.test(itemName) && /(이알|서방|8시간)/i.test(itemName)) aliases.add("TYLENOL ER");
  if (/아스피린/i.test(itemName)) aliases.add("ASPIRIN");
  return [...aliases];
}

function aliasPolicy(alias: string): {
  alias_type: "broad_brand" | "specific_brand";
  requires_confirmation: boolean;
  priority: number;
} {
  if (alias === "TYLENOL ER") {
    return {
      alias_type: "specific_brand",
      requires_confirmation: false,
      priority: 20,
    };
  }
  return {
    alias_type: "broad_brand",
    requires_confirmation: true,
    priority: 200,
  };
}

async function upsertIngredient(
  serviceClient: { from: (table: string) => any },
  ingredient: { code: string | null; name: string },
): Promise<{ id: string }> {
  const { data, error } = await serviceClient
    .from("ingredients")
    .upsert({
      code: ingredient.code,
      name: ingredient.name,
    }, { onConflict: ingredient.code ? "code" : "normalized_name" })
    .select("id")
    .single();

  if (!error && data) return data;

  if (error?.code !== "23505") {
    throw new HttpError(500, "Failed to upsert ingredient", error);
  }

  const { data: existingByName, error: nameError } = await serviceClient
    .from("ingredients")
    .select("id")
    .eq("normalized_name", normalizeIngredientName(ingredient.name))
    .maybeSingle();

  if (nameError) throw new HttpError(500, "Failed to load existing ingredient by name", nameError);
  if (existingByName) return existingByName;

  throw new HttpError(500, "Failed to upsert ingredient", error);
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    await requireAdmin(serviceClient, user.id);

    const body = await readJson<RequestBody>(req);
    const serviceKey = requireEnv("DATA_GO_KR_SERVICE_KEY");
    const pageNo = body.pageNo ?? 1;
    const numOfRows = Math.min(body.numOfRows ?? 100, 500);
    const endpoint = "https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService07/getDrugPrdtPrmsnDtlInq06";
    const params = new URLSearchParams({
      serviceKey,
      pageNo: String(pageNo),
      numOfRows: String(numOfRows),
      type: "json",
    });

    if (body.itemName) {
      params.set("item_name", body.itemName);
    }

    const response = await fetch(`${endpoint}?${params.toString()}`);
    const apiBody = await response.json();

    if (!response.ok) {
      throw new HttpError(response.status, "Public drug API request failed", apiBody);
    }

    const items = asArray<DrugApiItem>(
      apiBody?.body?.items?.item ?? apiBody?.body?.items ?? apiBody?.response?.body?.items?.item,
    );

    let medicationCount = 0;
    let ingredientCount = 0;

    for (const item of items) {
      const itemSeq = getField(item, "ITEM_SEQ", "item_seq");
      const itemName = getField(item, "ITEM_NAME", "item_name");
      if (!itemSeq || !itemName) continue;

      const mainIngredients = getField(item, "MAIN_ITEM_INGR", "main_item_ingr");
      const efficacy = getField(item, "EE_DOC_DATA", "ee_doc_data");
      const dosage = getField(item, "UD_DOC_DATA", "ud_doc_data");
      const precautions = getField(item, "NB_DOC_DATA", "nb_doc_data");
      const storageMethod = getField(item, "STORAGE_METHOD", "storage_method");
      const { data: medication, error: medError } = await serviceClient
        .from("medications")
        .upsert({
          item_seq: itemSeq,
          item_name: itemName,
          entp_name: getField(item, "ENTP_NAME", "entp_name"),
          edi_code: getField(item, "EDI_CODE", "edi_code"),
          atc_code: getField(item, "ATC_CODE", "atc_code"),
          bar_codes: parseBarCodes(getField(item, "BAR_CODE", "bar_code")),
          efficacy,
          dosage,
          precautions,
          storage_method: storageMethod,
          administration_timing: detectAdministrationTiming(dosage),
          information_completeness: completeness({
            efficacy,
            dosage,
            precautions,
            side_effects: null,
            storage_method: storageMethod,
          }),
          source: "data.go.kr",
          raw_source: item,
          source_updated_at: new Date().toISOString(),
        }, { onConflict: "item_seq" })
        .select("id")
        .single();

      if (medError) throw new HttpError(500, "Failed to upsert medication", medError);
      medicationCount += 1;

      const aliases = knownAliasesForItem(itemName);
      if (aliases.length > 0) {
        const { error: aliasError } = await serviceClient
          .from("medication_aliases")
          .upsert(
            aliases.map((alias) => ({
              medication_id: medication.id,
              alias,
              source: "known_brand_alias",
              ...aliasPolicy(alias),
            })),
            { onConflict: "medication_id,normalized_alias" },
          );

        if (aliasError) throw new HttpError(500, "Failed to upsert medication aliases", aliasError);
      }

      await serviceClient
        .from("medication_ingredients")
        .delete()
        .eq("medication_id", medication.id);

      for (const ingredient of parseIngredients(mainIngredients)) {
        const ingredientRow = await upsertIngredient(serviceClient, ingredient);

        await serviceClient
          .from("medication_ingredients")
          .upsert({
            medication_id: medication.id,
            ingredient_id: ingredientRow.id,
          });

        ingredientCount += 1;
      }
    }

    await logApiUsage(serviceClient, {
      userId: user.id,
      provider: "data_go_kr",
      endpoint: "getDrugPrdtPrmsnDtlInq06",
      requestCount: 1,
    });

    return json({
      pageNo,
      numOfRows,
      medicationCount,
      ingredientCount,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
