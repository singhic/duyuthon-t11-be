import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  detectedMedicationId: string;
  startDate?: string;
  endDate?: string;
  customName?: string;
};

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
      .select("*")
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

      return json({
        userMedication: existingMedication,
        alreadyExists: true,
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
      .select("*")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: medicationAfterConflict, error: conflictLoadError } = await serviceClient
          .from("user_medications")
          .select("*")
          .eq("user_id", user.id)
          .eq("medication_id", detected.medication_id)
          .eq("active", true)
          .maybeSingle();

        if (conflictLoadError) {
          throw new HttpError(500, "Failed to load existing user medication after conflict", conflictLoadError);
        }
        if (medicationAfterConflict) {
          return json({
            userMedication: medicationAfterConflict,
            alreadyExists: true,
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

    return json({ userMedication, alreadyExists: false }, 201);
  } catch (error) {
    return errorResponse(error);
  }
});
