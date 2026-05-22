import { handleCors } from "../_shared/cors.ts";
import { errorResponse, json } from "../_shared/http.ts";
import { requireRestUser, restSelect } from "../_shared/rest.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const user = await requireRestUser(req);
    const data = await restSelect<Record<string, string>>(
      `caregiver_links?select=*&or=(patient_user_id.eq.${encodeURIComponent(user.id)},caregiver_user_id.eq.${encodeURIComponent(user.id)})&order=created_at.desc`,
    );

    return json({
      caregiverLinks: data,
      asPatient: data.filter((row) => row.patient_user_id === user.id),
      asCaregiver: data.filter((row) => row.caregiver_user_id === user.id),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
