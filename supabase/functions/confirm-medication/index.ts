import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  detectedMedicationId: string;
  startDate?: string;
  endDate?: string;
  customName?: string;
};

const USER_MEDICATION_SELECT = `
  *,
  medications(
    id,
    item_name,
    entp_name,
    efficacy,
    dosage,
    precautions,
    storage_method,
    administration_timing
  )
`;

async function loadActiveSchedules(serviceClient: any, userMedicationId: string): Promise<any[]> {
  const { data: schedules, error } = await serviceClient
    .from("medication_schedules")
    .select("*")
    .eq("user_medication_id", userMedicationId)
    .eq("active", true)
    .order("take_time", { ascending: true });

  if (error) throw new HttpError(500, "Failed to load medication schedules", error);
  return schedules ?? [];
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.detectedMedicationId) {
      throw new HttpError(400, "detectedMedicationId is required");
    }

    const { data: detected, error: detectedError } = await serviceClient
      .from("scan_detected_medications")
      .select("id, medication_id, matched_name, scan_sessions(id,user_id)")
      .eq("id", body.detectedMedicationId)
      .maybeSingle();

    if (detectedError) throw new HttpError(500, "Failed to load detected medication", detectedError);
    if (!detected) throw new HttpError(404, "Detected medication not found");
    if (!detected.medication_id) {
      throw new HttpError(400, "Detected medication is not matched to a medication master record");
    }

    const scanSession = Array.isArray(detected.scan_sessions)
      ? detected.scan_sessions[0]
      : detected.scan_sessions;

    if (!scanSession || scanSession.user_id !== user.id) {
      throw new HttpError(403, "Detected medication does not belong to the current user");
    }

    const { data: existingMedication, error: existingError } = await serviceClient
      .from("user_medications")
      .select(USER_MEDICATION_SELECT)
      .eq("user_id", user.id)
      .eq("medication_id", detected.medication_id)
      .eq("active", true)
      .maybeSingle();

    if (existingError) throw new HttpError(500, "Failed to check existing user medication", existingError);
    if (existingMedication) {
      await serviceClient
        .from("scan_detected_medications")
        .update({
          needs_confirmation: false,
          match_method: "manual_review",
        })
        .eq("id", body.detectedMedicationId);

      const schedules = await loadActiveSchedules(serviceClient, existingMedication.id);
      return json({
        userMedication: existingMedication,
        alreadyExists: true,
        schedules,
      });
    }

    const { data: userMedication, error: insertError } = await serviceClient
      .from("user_medications")
      .insert({
        user_id: user.id,
        medication_id: detected.medication_id,
        source_scan_id: scanSession.id,
        custom_name: body.customName ?? detected.matched_name ?? null,
        start_date: body.startDate ?? new Date().toISOString().slice(0, 10),
        end_date: body.endDate ?? null,
        source: "manual_confirmed",
        active: true,
      })
      .select(USER_MEDICATION_SELECT)
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: medicationAfterConflict, error: conflictLoadError } = await serviceClient
          .from("user_medications")
          .select(USER_MEDICATION_SELECT)
          .eq("user_id", user.id)
          .eq("medication_id", detected.medication_id)
          .eq("active", true)
          .maybeSingle();

        if (conflictLoadError) {
          throw new HttpError(500, "Failed to load existing user medication after conflict", conflictLoadError);
        }
        if (medicationAfterConflict) {
          const schedules = await loadActiveSchedules(serviceClient, medicationAfterConflict.id);
          return json({
            userMedication: medicationAfterConflict,
            alreadyExists: true,
            schedules,
          });
        }
      }

      throw new HttpError(500, "Failed to create user medication", insertError);
    }

    await serviceClient
      .from("scan_detected_medications")
      .update({
        needs_confirmation: false,
        match_method: "manual_review",
      })
        .eq("id", body.detectedMedicationId);

    return json({ userMedication, alreadyExists: false, schedules: [] }, 201);
  } catch (error) {
    return errorResponse(error);
  }
});
