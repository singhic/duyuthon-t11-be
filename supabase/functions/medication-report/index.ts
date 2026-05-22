import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireRestUser, restSelect, restSelectSingle } from "../_shared/rest.ts";

type RequestBody = {
  patientUserId?: string;
  startDate: string;
  endDate: string;
};

type MedicationLogRow = {
  planned_date: string;
  status: "pending" | "taken" | "missed" | "skipped";
};

type ReportRow = {
  report_date: string;
  planned_count: number;
  taken_count: number;
  missed_count: number;
  skipped_count: number;
  adherence_rate: number;
};

function summarize(rows: Array<{ planned_count: number; taken_count: number; missed_count: number; skipped_count: number }>): string {
  const planned = rows.reduce((sum, row) => sum + row.planned_count, 0);
  const taken = rows.reduce((sum, row) => sum + row.taken_count, 0);
  const missed = rows.reduce((sum, row) => sum + row.missed_count, 0);
  const skipped = rows.reduce((sum, row) => sum + row.skipped_count, 0);

  if (planned === 0) return "선택한 기간에 기록된 복약 일정이 없습니다.";
  const rate = Math.round((taken / planned) * 100);
  return `선택한 기간의 복약 완료율은 ${rate}%입니다. 완료 ${taken}건, 미복용 ${missed}건, 건너뜀 ${skipped}건입니다.`;
}

function parseDate(value: string, fieldName: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${fieldName} must be YYYY-MM-DD`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${fieldName} is invalid`);
  }

  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000);
}

async function canReadReport(currentUserId: string, patientUserId: string): Promise<boolean> {
  if (currentUserId === patientUserId) return true;

  const profile = await restSelectSingle<{ role: string | null }>(
    `user_profiles?select=role&user_id=eq.${encodeURIComponent(currentUserId)}`,
  );
  if (profile?.role === "admin") return true;

  const link = await restSelectSingle<{ id: string }>(
    [
      "caregiver_links?select=id",
      `patient_user_id=eq.${encodeURIComponent(patientUserId)}`,
      `caregiver_user_id=eq.${encodeURIComponent(currentUserId)}`,
      "status=eq.accepted",
      "revoked_at=is.null",
      "permission_scope->>reports=eq.true",
    ].join("&"),
  );

  return Boolean(link);
}

function buildReport(start: Date, end: Date, logs: MedicationLogRow[]): ReportRow[] {
  const byDate = new Map<string, ReportRow>();
  const totalDays = daysBetween(start, end);

  for (let offset = 0; offset <= totalDays; offset += 1) {
    const date = new Date(start.getTime() + offset * 86_400_000);
    const key = isoDate(date);
    byDate.set(key, {
      report_date: key,
      planned_count: 0,
      taken_count: 0,
      missed_count: 0,
      skipped_count: 0,
      adherence_rate: 0,
    });
  }

  for (const log of logs) {
    const row = byDate.get(log.planned_date);
    if (!row) continue;
    row.planned_count += 1;
    if (log.status === "taken") row.taken_count += 1;
    if (log.status === "missed") row.missed_count += 1;
    if (log.status === "skipped") row.skipped_count += 1;
  }

  return [...byDate.values()].map((row) => ({
    ...row,
    adherence_rate: row.planned_count === 0
      ? 0
      : Math.round((row.taken_count / row.planned_count) * 10_000) / 100,
  }));
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const user = await requireRestUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.startDate || !body.endDate) {
      throw new HttpError(400, "startDate and endDate are required");
    }

    const startDate = parseDate(body.startDate, "startDate");
    const endDate = parseDate(body.endDate, "endDate");
    const rangeDays = daysBetween(startDate, endDate);
    if (rangeDays < 0) {
      throw new HttpError(400, "endDate must be greater than or equal to startDate");
    }
    if (rangeDays > 120) {
      throw new HttpError(400, "Medication report range must be 120 days or less");
    }

    const patientUserId = body.patientUserId ?? user.id;
    if (!(await canReadReport(user.id, patientUserId))) {
      throw new HttpError(403, "Current user cannot read this medication report");
    }

    const logs = await restSelect<MedicationLogRow>(
      [
        "medication_logs?select=planned_date,status,user_medications!inner(user_id)",
        `user_medications.user_id=eq.${encodeURIComponent(patientUserId)}`,
        `planned_date=gte.${encodeURIComponent(body.startDate)}`,
        `planned_date=lte.${encodeURIComponent(body.endDate)}`,
      ].join("&"),
    );
    const report = buildReport(startDate, endDate, logs);

    return json({
      patientUserId,
      startDate: body.startDate,
      endDate: body.endDate,
      daily: report,
      summary: summarize(report),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
