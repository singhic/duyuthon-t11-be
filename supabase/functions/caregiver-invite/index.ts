import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireRestUser, restWriteSingle } from "../_shared/rest.ts";

type RequestBody = {
  patientUserId?: string;
  caregiverUserId?: string;
  permissionScope?: Record<string, boolean>;
};

const DEFAULT_SCOPE = {
  medication_status: true,
  scan_results: false,
  reports: true,
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const user = await requireRestUser(req);
    const body = await readJson<RequestBody>(req);
    const patientUserId = body.patientUserId ?? user.id;
    const caregiverUserId = body.caregiverUserId ?? user.id;

    if (patientUserId === caregiverUserId) {
      throw new HttpError(400, "patientUserId and caregiverUserId must be different");
    }
    if (patientUserId !== user.id && caregiverUserId !== user.id) {
      throw new HttpError(403, "Current user must be the patient or caregiver");
    }

    const invitedByPatient = patientUserId === user.id;
    const link = await restWriteSingle(
      "caregiver_links?on_conflict=patient_user_id,caregiver_user_id&select=*",
      "POST",
      {
        patient_user_id: patientUserId,
        caregiver_user_id: caregiverUserId,
        status: "invited",
        permission_scope: {
          ...DEFAULT_SCOPE,
          ...(body.permissionScope ?? {}),
        },
        invited_by_user_id: user.id,
        consented_at: null,
        revoked_at: null,
      },
      "resolution=merge-duplicates,return=representation",
    );

    return json({
      caregiverLink: link,
      invitedBy: invitedByPatient ? "patient" : "caregiver",
      nextAction: invitedByPatient
        ? "caregiver can view invitation status, but patient consent is already represented by the invite."
        : "patient must call caregiver-respond with action=accepted before caregiver can view data.",
    }, 201);
  } catch (error) {
    return errorResponse(error);
  }
});
