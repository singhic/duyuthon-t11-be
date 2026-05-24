import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  scheduleId?: string;
  userMedicationId: string;
  takeTime?: string;
  takeTimes?: string[];
  timingRule?: "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom";
  doseAmount?: number;
  doseUnit?: string;
  daysOfWeek?: number[];
  notificationEnabled?: boolean;
  startDate?: string;
  endDate?: string | null;
  active?: boolean;
};

type ScheduleUpdateBody = Partial<RequestBody> & {
  scheduleId: string;
};

const TIMING_RULES = new Set(["before_meal", "after_meal", "with_meal", "bedtime", "custom"]);

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function normalizeTime(value: string): string {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) {
    throw new HttpError(400, "takeTime must be HH:mm or HH:mm:ss");
  }
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}

function normalizeTakeTimes(body: RequestBody): string[] {
  const hasTakeTime = body.takeTime !== undefined && body.takeTime !== null && body.takeTime !== "";
  const hasTakeTimes = body.takeTimes !== undefined;

  if (hasTakeTime && hasTakeTimes) {
    throw new HttpError(400, "Use either takeTime or takeTimes, not both");
  }
  if (!hasTakeTime && !hasTakeTimes) {
    throw new HttpError(400, "takeTime or takeTimes is required");
  }
  if (hasTakeTimes && (!Array.isArray(body.takeTimes) || body.takeTimes.length === 0)) {
    throw new HttpError(400, "takeTimes must contain at least one time");
  }

  const rawTimes = hasTakeTimes ? body.takeTimes ?? [] : [body.takeTime as string];
  const normalized = rawTimes.map((time) => {
    if (typeof time !== "string") {
      throw new HttpError(400, "takeTimes must contain HH:mm or HH:mm:ss strings");
    }
    return normalizeTime(time);
  });

  return [...new Set(normalized)];
}

function normalizeDaysOfWeek(daysOfWeek?: number[]): number[] {
  const days = daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length === 0 || unique.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new HttpError(400, "daysOfWeek must contain integers from 0 to 6");
  }
  return unique;
}

function validateCommonFields(body: Partial<RequestBody>): void {
  if (body.timingRule && !TIMING_RULES.has(body.timingRule)) {
    throw new HttpError(400, "timingRule is invalid");
  }
  if (body.startDate && !isValidIsoDate(body.startDate)) {
    throw new HttpError(400, "startDate must be YYYY-MM-DD");
  }
  if (body.endDate && !isValidIsoDate(body.endDate)) {
    throw new HttpError(400, "endDate must be YYYY-MM-DD");
  }
  if (body.startDate && body.endDate && body.endDate < body.startDate) {
    throw new HttpError(400, "endDate must be after or equal to startDate");
  }
  if (body.doseAmount !== undefined && body.doseAmount !== null && (!Number.isFinite(body.doseAmount) || body.doseAmount <= 0)) {
    throw new HttpError(400, "doseAmount must be a positive number");
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);

    if (req.method === "GET") {
      const url = new URL(req.url);
      const userMedicationId = url.searchParams.get("userMedicationId");
      const active = url.searchParams.get("active");

      let query = serviceClient
        .from("medication_schedules")
        .select(`
          *,
          user_medications!inner(
            id,
            user_id,
            medication_id,
            custom_name,
            medications(id,item_name,entp_name)
          )
        `)
        .eq("user_medications.user_id", user.id)
        .order("take_time", { ascending: true });

      if (userMedicationId) {
        query = query.eq("user_medication_id", userMedicationId);
      }
      if (active === "true" || active === "false") {
        query = query.eq("active", active === "true");
      }

      const { data: schedules, error } = await query;
      if (error) throw new HttpError(500, "Failed to load medication schedules", error);
      return json({ schedules: schedules ?? [] });
    }

    if (req.method === "PATCH") {
      const body = await readJson<ScheduleUpdateBody>(req);
      if (!body.scheduleId) {
        throw new HttpError(400, "scheduleId is required");
      }
      validateCommonFields(body);

      const { data: existing, error: existingError } = await serviceClient
        .from("medication_schedules")
        .select("id,user_medication_id,user_medications!inner(user_id)")
        .eq("id", body.scheduleId)
        .eq("user_medications.user_id", user.id)
        .maybeSingle();

      if (existingError) throw new HttpError(500, "Failed to verify medication schedule", existingError);
      if (!existing) throw new HttpError(404, "Medication schedule not found");

      const patch: Record<string, unknown> = {};
      if (body.takeTime !== undefined) patch.take_time = normalizeTime(body.takeTime);
      if (body.timingRule !== undefined) patch.timing_rule = body.timingRule;
      if (body.doseAmount !== undefined) patch.dose_amount = body.doseAmount;
      if (body.doseUnit !== undefined) patch.dose_unit = body.doseUnit ?? null;
      if (body.daysOfWeek !== undefined) patch.days_of_week = normalizeDaysOfWeek(body.daysOfWeek);
      if (body.notificationEnabled !== undefined) patch.notification_enabled = body.notificationEnabled;
      if (body.startDate !== undefined) patch.start_date = body.startDate;
      if (body.endDate !== undefined) patch.end_date = body.endDate;
      if (body.active !== undefined) patch.active = body.active;

      if (Object.keys(patch).length === 0) {
        throw new HttpError(400, "No fields to update");
      }

      const { data: schedule, error } = await serviceClient
        .from("medication_schedules")
        .update(patch)
        .eq("id", body.scheduleId)
        .select("*")
        .single();

      if (error) throw new HttpError(500, "Failed to update medication schedule", error);
      return json({ schedule });
    }

    if (req.method === "DELETE") {
      const body = await readJson<{ scheduleId: string }>(req);
      if (!body.scheduleId) {
        throw new HttpError(400, "scheduleId is required");
      }

      const { data: existing, error: existingError } = await serviceClient
        .from("medication_schedules")
        .select("id,user_medications!inner(user_id)")
        .eq("id", body.scheduleId)
        .eq("user_medications.user_id", user.id)
        .maybeSingle();

      if (existingError) throw new HttpError(500, "Failed to verify medication schedule", existingError);
      if (!existing) throw new HttpError(404, "Medication schedule not found");

      const { data: schedule, error } = await serviceClient
        .from("medication_schedules")
        .update({ active: false, notification_enabled: false })
        .eq("id", body.scheduleId)
        .select("*")
        .single();

      if (error) throw new HttpError(500, "Failed to deactivate medication schedule", error);
      return json({ schedule });
    }

    if (req.method !== "POST") {
      throw new HttpError(405, "Method not allowed");
    }

    const body = await readJson<RequestBody>(req);

    if (!body.userMedicationId) {
      throw new HttpError(400, "userMedicationId is required");
    }
    validateCommonFields(body);
    const takeTimes = normalizeTakeTimes(body);

    const { data: medication, error: medicationError } = await serviceClient
      .from("user_medications")
      .select("id")
      .eq("id", body.userMedicationId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (medicationError) throw new HttpError(500, "Failed to verify user medication", medicationError);
    if (!medication) throw new HttpError(404, "User medication not found");

    const { data: existingSchedules, error: existingScheduleError } = await serviceClient
      .from("medication_schedules")
      .select("*")
      .eq("user_medication_id", body.userMedicationId)
      .eq("active", true)
      .in("take_time", takeTimes);

    if (existingScheduleError) throw new HttpError(500, "Failed to load existing medication schedules", existingScheduleError);

    const existingByTime = new Map((existingSchedules ?? []).map((schedule) => [schedule.take_time, schedule]));
    const missingTimes = takeTimes.filter((takeTime) => !existingByTime.has(takeTime));

    let insertedSchedules: any[] = [];
    if (missingTimes.length > 0) {
      const payloads = missingTimes.map((takeTime) => ({
        user_medication_id: body.userMedicationId,
        take_time: takeTime,
        timing_rule: body.timingRule ?? "custom",
        dose_amount: body.doseAmount ?? null,
        dose_unit: body.doseUnit ?? null,
        days_of_week: normalizeDaysOfWeek(body.daysOfWeek),
        notification_enabled: body.notificationEnabled ?? true,
        start_date: body.startDate ?? new Date().toISOString().slice(0, 10),
        end_date: body.endDate ?? null,
        active: body.active ?? true,
      }));

      const { data, error: scheduleError } = await serviceClient
        .from("medication_schedules")
        .insert(payloads)
        .select("*");

      if (scheduleError) throw new HttpError(500, "Failed to create medication schedules", scheduleError);
      insertedSchedules = data ?? [];
    }

    const allSchedules = [...(existingSchedules ?? []), ...insertedSchedules]
      .filter((schedule) => takeTimes.includes(schedule.take_time))
      .sort((a, b) => `${a.take_time}`.localeCompare(`${b.take_time}`));

    return json({ schedule: allSchedules[0] ?? null, schedules: allSchedules }, 201);
  } catch (error) {
    return errorResponse(error);
  }
});
