import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  detectedMedicationId?: string;
  userMedicationId?: string;
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

function normalizeCustomName(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function updateCustomNameIfChanged(
  serviceClient: any,
  existingMedication: any,
  customName?: string,
): Promise<any> {
  const nextCustomName = normalizeCustomName(customName);
  if (!nextCustomName) return existingMedication;

  const currentCustomName = typeof existingMedication.custom_name === "string"
    ? existingMedication.custom_name.trim()
    : "";
  if (currentCustomName === nextCustomName) return existingMedication;

  const { data: updatedMedication, error } = await serviceClient
    .from("user_medications")
    .update({ custom_name: nextCustomName })
    .eq("id", existingMedication.id)
    .select(USER_MEDICATION_SELECT)
    .single();

  if (error) throw new HttpError(500, "Failed to update existing user medication custom name", error);
  return updatedMedication;
}

async function markDetectedMedicationConfirmed(serviceClient: any, detectedMedicationId: string): Promise<void> {
  const { error } = await serviceClient
    .from("scan_detected_medications")
    .update({
      needs_confirmation: false,
      match_method: "manual_review",
    })
    .eq("id", detectedMedicationId);

  if (error) throw new HttpError(500, "Failed to update detected medication confirmation status", error);
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.detectedMedicationId && !body.userMedicationId) {
      throw new HttpError(400, "detectedMedicationId or userMedicationId is required");
    }

    if (body.userMedicationId) {
      const nextCustomName = normalizeCustomName(body.customName);
      if (!nextCustomName) {
        throw new HttpError(400, "customName is required when updating an existing user medication");
      }

      const { data: existingUserMedication, error: userMedicationError } = await serviceClient
        .from("user_medications")
        .select(USER_MEDICATION_SELECT)
        .eq("id", body.userMedicationId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (userMedicationError) throw new HttpError(500, "Failed to load user medication", userMedicationError);
      if (!existingUserMedication) throw new HttpError(404, "User medication not found");

      const updatedUserMedication = await updateCustomNameIfChanged(
        serviceClient,
        existingUserMedication,
        nextCustomName,
      );
      const schedules = await loadActiveSchedules(serviceClient, updatedUserMedication.id);

      return json({
        userMedication: updatedUserMedication,
        alreadyExists: true,
        schedules,
      });
    }

    const detectedMedicationId = body.detectedMedicationId;
    if (!detectedMedicationId) {
      throw new HttpError(400, "detectedMedicationId is required");
    }

    const { data: detected, error: detectedError } = await serviceClient
      .from("scan_detected_medications")
      .select("id, medication_id, matched_name, scan_sessions(id,user_id)")
      .eq("id", detectedMedicationId)
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
      const updatedExistingMedication = await updateCustomNameIfChanged(
        serviceClient,
        existingMedication,
        body.customName,
      );
      await markDetectedMedicationConfirmed(serviceClient, detectedMedicationId);

      const schedules = await loadActiveSchedules(serviceClient, updatedExistingMedication.id);
      return json({
        userMedication: updatedExistingMedication,
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
        custom_name: normalizeCustomName(body.customName) ?? detected.matched_name ?? null,
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
          const updatedConflictMedication = await updateCustomNameIfChanged(
            serviceClient,
            medicationAfterConflict,
            body.customName,
          );
          await markDetectedMedicationConfirmed(serviceClient, detectedMedicationId);

          const schedules = await loadActiveSchedules(serviceClient, updatedConflictMedication.id);
          return json({
            userMedication: updatedConflictMedication,
            alreadyExists: true,
            schedules,
          });
        }
      }

      throw new HttpError(500, "Failed to create user medication", insertError);
    }

    await markDetectedMedicationConfirmed(serviceClient, detectedMedicationId);

    return json({ userMedication, alreadyExists: false, schedules: [] }, 201);
  } catch (error) {
    return errorResponse(error);
  }
});
