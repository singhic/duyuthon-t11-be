import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RemoveUserMedicationRequest = {
  userMedicationId: string;
};

function todayInSeoul(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);

    if (req.method === "GET") {
      const url = new URL(req.url);
      const active = url.searchParams.get("active") ?? "true";
      if (!["true", "false", "all"].includes(active)) {
        throw new HttpError(400, "active must be true, false, or all");
      }

      let query = serviceClient
        .from("user_medications")
        .select(`
          *,
          medications(
            id,
            item_name,
            entp_name,
            efficacy,
            dosage,
            precautions,
            side_effects,
            storage_method,
            administration_timing,
            information_completeness
          )
        `)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (active !== "all") {
        query = query.eq("active", active === "true");
      }

      const { data: userMedications, error } = await query;
      if (error) throw new HttpError(500, "Failed to load user medications", error);
      return json({ userMedications: userMedications ?? [] });
    }

    if (req.method === "DELETE") {
      const body = await readJson<RemoveUserMedicationRequest>(req);
      const userMedicationId = normalizeId(body.userMedicationId);
      if (!userMedicationId) {
        throw new HttpError(400, "userMedicationId is required");
      }

      const { data: existing, error: loadError } = await serviceClient
        .from("user_medications")
        .select("id,user_id,medication_id,active,end_date,updated_at")
        .eq("id", userMedicationId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (loadError) throw new HttpError(500, "Failed to load user medication", loadError);
      if (!existing) throw new HttpError(404, "User medication not found");

      if (!existing.active) {
        return json({
          userMedicationId,
          removed: false,
          alreadyInactive: true,
          deactivatedScheduleCount: 0,
          skippedNotificationCount: 0,
          userMedication: existing,
        });
      }

      const endDate = todayInSeoul();
      const { data: userMedication, error: updateError } = await serviceClient
        .from("user_medications")
        .update({
          active: false,
          end_date: endDate,
        })
        .eq("id", userMedicationId)
        .eq("user_id", user.id)
        .select("id,medication_id,active,end_date,updated_at")
        .single();

      if (updateError) throw new HttpError(500, "Failed to deactivate user medication", updateError);

      const { data: deactivatedSchedules, error: scheduleError } = await serviceClient
        .from("medication_schedules")
        .update({
          active: false,
          notification_enabled: false,
          end_date: endDate,
        })
        .eq("user_medication_id", userMedicationId)
        .eq("active", true)
        .select("id");

      if (scheduleError) throw new HttpError(500, "Failed to deactivate medication schedules", scheduleError);

      const { data: skippedDeliveries, error: deliveryError } = await serviceClient
        .from("medication_notification_deliveries")
        .update({
          status: "skipped",
          error: "user_medication_removed",
        })
        .eq("user_medication_id", userMedicationId)
        .eq("status", "pending")
        .select("id");

      if (deliveryError) throw new HttpError(500, "Failed to skip pending medication notifications", deliveryError);

      return json({
        userMedicationId,
        removed: true,
        alreadyInactive: false,
        deactivatedScheduleCount: deactivatedSchedules?.length ?? 0,
        skippedNotificationCount: skippedDeliveries?.length ?? 0,
        userMedication,
      });
    }

    throw new HttpError(405, "Method not allowed");
  } catch (error) {
    return errorResponse(error);
  }
});
