import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  userMedicationId: string;
  scheduleId?: string;
  plannedDate: string;
  plannedTime?: string;
  status?: "taken" | "missed" | "skipped";
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.userMedicationId || !body.plannedDate) {
      throw new HttpError(400, "userMedicationId and plannedDate are required");
    }

    const { data: medication, error: medicationError } = await serviceClient
      .from("user_medications")
      .select("id")
      .eq("id", body.userMedicationId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (medicationError) throw new HttpError(500, "Failed to verify user medication", medicationError);
    if (!medication) throw new HttpError(404, "User medication not found");

    if (body.scheduleId) {
      const { data: schedule, error: scheduleError } = await serviceClient
        .from("medication_schedules")
        .select("id")
        .eq("id", body.scheduleId)
        .eq("user_medication_id", body.userMedicationId)
        .maybeSingle();

      if (scheduleError) throw new HttpError(500, "Failed to verify medication schedule", scheduleError);
      if (!schedule) throw new HttpError(404, "Medication schedule not found for this user medication");
    }

    const status = body.status ?? "taken";
    const payload = {
      user_medication_id: body.userMedicationId,
      schedule_id: body.scheduleId ?? null,
      planned_date: body.plannedDate,
      planned_time: body.plannedTime ?? null,
      status,
      taken_at: status === "taken" ? new Date().toISOString() : null,
    };

    if (!body.scheduleId) {
      const { data: existingLog, error: existingLogError } = await serviceClient
        .from("medication_logs")
        .select("id")
        .eq("user_medication_id", body.userMedicationId)
        .eq("planned_date", body.plannedDate)
        .is("schedule_id", null)
        .maybeSingle();

      if (existingLogError) throw new HttpError(500, "Failed to check existing medication log", existingLogError);
      if (existingLog) {
        const { data: log, error: updateError } = await serviceClient
          .from("medication_logs")
          .update(payload)
          .eq("id", existingLog.id)
          .select("*")
          .single();

        if (updateError) throw new HttpError(500, "Failed to update medication log", updateError);
        return json({ log });
      }
    }

    const { data: log, error: logError } = await serviceClient
      .from("medication_logs")
      .upsert(payload, { onConflict: "user_medication_id,schedule_id,planned_date" })
      .select("*")
      .single();

    if (logError) throw new HttpError(500, "Failed to save medication log", logError);

    return json({ log });
  } catch (error) {
    return errorResponse(error);
  }
});
