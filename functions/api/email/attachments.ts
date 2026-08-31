import {
  Env,
  errorResponse,
  optionsResponse,
  supabaseQuery,
  checkAuth,
  fetchStorageObject,
} from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") return data[0] as Record<string, unknown>;
  if (data && typeof data === "object" && !Array.isArray(data) && "id" in (data as object)) {
    return data as Record<string, unknown>;
  }
  return null;
}

export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return optionsResponse(origin);
  if (request.method !== "GET") return errorResponse("method", 405, origin);

  const authError = await checkAuth(request, env);
  if (authError) return authError;

  const id = (url.searchParams.get("id") || "").trim();
  if (!UUID_RE.test(id)) return errorResponse("id required", 400, origin);

  const res = await supabaseQuery(
    env,
    `/email_attachments?id=eq.${encodeURIComponent(id)}&select=id,filename,content_type,size_bytes,storage_path&limit=1`
  );
  const row = asRecord(res.data);
  if (!res.ok || !row) return errorResponse("not found", 404, origin);

  const storagePath = typeof row.storage_path === "string" ? row.storage_path : "";
  if (!storagePath || storagePath.startsWith("pending/")) {
    return errorResponse("file not stored yet", 404, origin);
  }

  const file = await fetchStorageObject(env, "email-attachments", storagePath);
  if (!file) return errorResponse("file missing", 404, origin);

  const filename = String(row.filename || "file");
  const contentType = String(row.content_type || file.headers.get("Content-Type") || "application/octet-stream");
  const inline = contentType.startsWith("image/") || contentType === "application/pdf";
  const body = await file.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=300",
      "Access-Control-Allow-Origin": origin || "*",
    },
  });
};
