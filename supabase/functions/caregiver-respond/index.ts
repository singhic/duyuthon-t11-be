import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireRestUser, restSelectSingle, restWriteSingle } from "../_shared/rest.ts";

type RequestBody = {
  caregiverLinkId: string;
  action: "accepted" | "revoked";
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const user = await requireRestUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.caregiverLinkId || !body.action) {
      throw new HttpError(400, "caregiverLinkId and action are required");
    }

    const existing = await restSelectSingle<Record<string, string | null>>(
      `caregiver_links?select=*&id=eq.${encodeURIComponent(body.caregiverLinkId)}`,
    );
    if (!existing) throw new HttpError(404, "Caregiver link not found");

    const isPatient = existing.patient_user_id === user.id;
    const isCaregiver = existing.caregiver_user_id === user.id;
    if (!isPatient && !isCaregiver) {
      throw new HttpError(403, "Current user is not a participant of this caregiver link");
    }
    const patientInvitedCaregiver = existing.invited_by_user_id === existing.patient_user_id;
    if (body.action === "accepted" && !(isPatient || (isCaregiver && patientInvitedCaregiver))) {
      throw new HttpError(403, "Only the patient can approve caregiver requests");
    }

    const patch = body.action === "accepted"
      ? {
        status: "accepted",
        consented_at: new Date().toISOString(),
        revoked_at: null,
      }
      : {
        status: "revoked",
        revoked_at: new Date().toISOString(),
      };

    const caregiverLink = await restWriteSingle(
      `caregiver_links?id=eq.${encodeURIComponent(body.caregiverLinkId)}&select=*`,
      "PATCH",
      patch,
    );

    return json({ caregiverLink });
  } catch (error) {
    return errorResponse(error);
  }
});
