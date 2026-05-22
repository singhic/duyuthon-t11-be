import { handleCors } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type RequestBody = {
  scanId: string;
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, serviceClient } = await requireUser(req);
    const body = await readJson<RequestBody>(req);

    if (!body.scanId) {
      throw new HttpError(400, "scanId is required");
    }

    const { data: scan, error: scanError } = await serviceClient
      .from("scan_sessions")
      .select("id,user_id,image_path")
      .eq("id", body.scanId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (scanError) throw new HttpError(500, "Failed to load scan session", scanError);
    if (!scan) throw new HttpError(404, "Scan session not found");

    if (scan.image_path) {
      const { error: removeError } = await serviceClient.storage
        .from("prescription-temp")
        .remove([scan.image_path]);

      if (removeError) throw new HttpError(500, "Failed to delete scan image", removeError);
    }

    await serviceClient
      .from("scan_sessions")
      .update({
        image_path: null,
        image_deleted_at: new Date().toISOString(),
      })
      .eq("id", scan.id);

    return json({
      scanId: scan.id,
      deleted: true,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
