import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  date?: string;
};

function todayInSeoul(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function dayOfWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00+09:00`));
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);
    const date = body.date ?? todayInSeoul();

    if (!isValidDate(date)) {
      throw new HttpError(400, "date must be YYYY-MM-DD");
    }

    const dow = dayOfWeek(date);
    const { data: schedules, error: scheduleError } = await serviceClient
      .from("medication_schedules")
      .select(`
        id,
        take_time,
        timing_rule,
        dose_amount,
        dose_unit,
        days_of_week,
        start_date,
        end_date,
        active,
        notification_enabled,
        user_medications!inner(
          id,
          user_id,
          medication_id,
          custom_name,
          start_date,
          end_date,
          active,
          medications(id,item_name,entp_name)
        )
      `)
      .eq("user_medications.user_id", user.id)
      .eq("user_medications.active", true)
      .eq("active", true)
      .lte("start_date", date)
      .or(`end_date.is.null,end_date.gte.${date}`);

    if (scheduleError) throw new HttpError(500, "Failed to load medication schedules", scheduleError);

    const filtered = (schedules ?? []).filter((schedule) => {
      const medication = Array.isArray(schedule.user_medications)
        ? schedule.user_medications[0]
        : schedule.user_medications;
      if (!medication) return false;
      if (medication.start_date && medication.start_date > date) return false;
      if (medication.end_date && medication.end_date < date) return false;
      return Array.isArray(schedule.days_of_week) && schedule.days_of_week.includes(dow);
    });

    const scheduleIds = filtered.map((schedule) => schedule.id);
    const { data: logs, error: logError } = scheduleIds.length > 0
      ? await serviceClient
        .from("medication_logs")
        .select("*")
        .eq("planned_date", date)
        .in("schedule_id", scheduleIds)
      : { data: [], error: null };

    if (logError) throw new HttpError(500, "Failed to load medication logs", logError);

    const logBySchedule = new Map((logs ?? []).map((log) => [log.schedule_id, log]));
    const items = filtered
      .map((schedule) => {
        const userMedication = Array.isArray(schedule.user_medications)
          ? schedule.user_medications[0]
          : schedule.user_medications;
        const medication = Array.isArray(userMedication.medications)
          ? userMedication.medications[0]
          : userMedication.medications;
        const log = logBySchedule.get(schedule.id) ?? null;

        return {
          scheduleId: schedule.id,
          userMedicationId: userMedication.id,
          medicationId: userMedication.medication_id,
          medicationName: userMedication.custom_name ?? medication?.item_name ?? null,
          entpName: medication?.entp_name ?? null,
          plannedDate: date,
          plannedTime: schedule.take_time,
          timingRule: schedule.timing_rule,
          doseAmount: schedule.dose_amount,
          doseUnit: schedule.dose_unit,
          status: log?.status ?? "pending",
          log,
        };
      })
      .sort((a, b) => `${a.plannedTime}`.localeCompare(`${b.plannedTime}`));

    const summary = {
      total: items.length,
      pending: items.filter((item) => item.status === "pending").length,
      taken: items.filter((item) => item.status === "taken").length,
      missed: items.filter((item) => item.status === "missed").length,
      skipped: items.filter((item) => item.status === "skipped").length,
    };

    return json({
      date,
      dayOfWeek: dow,
      summary,
      items,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
