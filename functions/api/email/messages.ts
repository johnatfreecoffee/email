import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keyset cursor over (received_at DESC, id DESC): opaque base64url of the last
// row's sort key, echoed back verbatim by the client for the next page. The
// timestamp is kept as PostgREST's own string so precision survives the trip.
function encodeCursor(row: { received_at: string; id: string }): string {
  const json = JSON.stringify({ ts: row.received_at, id: row.id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(atob(pad));
    if (typeof parsed?.ts !== "string" || !UUID_RE.test(parsed?.id)) return null;
    return { ts: parsed.ts, id: parsed.id };
  } catch {
    return null;
  }
}

// PostgREST or=() groups break on these chars; strip them, then URL-encode so
// the value can't inject extra query params.
function sanitizeSearch(search: string): string {
  return encodeURIComponent(search.replace(/[,()"'\\]/g, " ").trim());
}

// GET: List messages  |  PATCH: Update message  |  DELETE: Delete message
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const id = url.searchParams.get("id");

    // Single message fetch
    if (id) {
      const { data, ok } = await supabaseQuery(
        env,
        `/email_messages?id=eq.${id}&select=*`
      );
      if (!ok || !Array.isArray(data) || data.length === 0) {
        return errorResponse("Message not found", 404, origin);
      }

      // Fetch attachments
      const attRes = await supabaseQuery(
        env,
        `/email_attachments?message_id=eq.${id}&order=filename.asc`
      );

      const message = data[0];
      message.attachments = Array.isArray(attRes.data) ? attRes.data : [];

      return jsonResponse(message, 200, origin);
    }

    // List messages with filters
    const folder = url.searchParams.get("folder") || "inbox";
    const domainId = url.searchParams.get("domain_id");
    const addressId = url.searchParams.get("address_id");
    const isStarred = url.searchParams.get("is_starred");
    const search = url.searchParams.get("search");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500);
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const countOnly = url.searchParams.get("count_only") === "true";
    const isRead = url.searchParams.get("is_read");
    const isCatchAllRaw = url.searchParams.get("is_catch_all");
    const showCatchall = url.searchParams.get("show_catchall") === "true";
    // Inbox default behavior: when viewing the inbox folder, hide catch-all
    // mail. Caller can pass is_catch_all=true to view only catch-alls, or
    // show_catchall=true to include catch-alls inline alongside addressed
    // mail. Catch-alls land on the configured catchall destination address,
    // so this default also applies when filtering by address_id.
    const isCatchAll =
      isCatchAllRaw !== null
        ? isCatchAllRaw
        : folder === "inbox" && !showCatchall
        ? "false"
        : null;
    const isSpam = url.searchParams.get("is_spam");
    // Envelope-mode params: presence of either switches the response from the
    // legacy bare array to { messages, total, next_cursor, has_more } so old
    // clients/open tabs keep working untouched.
    const cursorParam = url.searchParams.get("cursor");
    const withTotal = url.searchParams.get("with_total") === "true";
    const hasAttachments = url.searchParams.get("has_attachments") === "true";

    // Count-only mode: return just the count using Supabase's count header
    if (countOnly) {
      let countPath = `/email_messages?select=id${hasAttachments ? ",attachments:email_attachments!inner(id)" : ""}`;
      if (folder === "starred") {
        countPath += "&is_starred=eq.true&is_trash=eq.false";
      } else if (folder === "trash") {
        countPath += "&is_trash=eq.true";
      } else if (folder === "all") {
        countPath += "&is_trash=eq.false";
      } else {
        countPath += `&folder=eq.${folder}&is_trash=eq.false&is_archived=eq.false`;
      }
      if (domainId) countPath += `&domain_id=eq.${domainId}`;
      // Address filter — but when "show catch-alls in inbox" is on, also
      // include catch-alls (which may have a different / null address_id
      // depending on the domain's catchall destination config). Otherwise
      // the toggle has no visible effect for domains without a configured
      // catchall destination.
      if (addressId && showCatchall && folder === "inbox") {
        countPath += `&or=(address_id.eq.${addressId},is_catch_all.eq.true)`;
      } else if (addressId) {
        countPath += `&address_id=eq.${addressId}`;
      }
      if (isRead === "false") countPath += "&is_read=eq.false";
      if (isRead === "true") countPath += "&is_read=eq.true";
      if (isStarred === "true") countPath += "&is_starred=eq.true";
      if (isCatchAll === "true") countPath += "&is_catch_all=eq.true";
      else if (isCatchAll === "false") countPath += "&is_catch_all=eq.false";
      if (isSpam === "true") countPath += "&is_spam=eq.true";
      else if (isSpam === "false") countPath += "&is_spam=eq.false";
      if (search) {
        const q = sanitizeSearch(search);
        countPath += `&or=(subject.ilike.*${q}*,from_address.ilike.*${q}*,body_text.ilike.*${q}*)`;
      }

      const countRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1${countPath}`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            Prefer: "count=exact",
            "Range-Unit": "items",
            Range: "0-0",
          },
        }
      );
      const contentRange = countRes.headers.get("content-range");
      const total = contentRange ? parseInt(contentRange.split("/")[1] || "0") : 0;
      return jsonResponse({ count: total }, 200, origin);
    }

    // Stable sort: id.desc tiebreak (bulk-imported rows share timestamps).
    let path = `/email_messages?order=received_at.desc,id.desc&limit=${limit}`;
    if (!cursorParam) path += `&offset=${offset}`;
    path += `&select=id,domain_id,address_id,direction,from_address,from_name,to_addresses,subject,is_read,is_starred,is_archived,is_trash,is_draft,is_catch_all,is_spam,spam_score,folder,received_at,body_text`;
    // !inner embed doubles as a "has at least one attachment" filter.
    if (hasAttachments) path += `,attachments:email_attachments!inner(id,filename,content_type,size_bytes)`;

    // Apply folder filter
    if (folder === "starred") {
      path += "&is_starred=eq.true&is_trash=eq.false";
    } else if (folder === "trash") {
      path += "&is_trash=eq.true";
    } else if (folder === "all") {
      path += "&is_trash=eq.false";
    } else {
      path += `&folder=eq.${folder}&is_trash=eq.false&is_archived=eq.false`;
    }

    if (domainId) path += `&domain_id=eq.${domainId}`;
    if (addressId && showCatchall && folder === "inbox") {
      path += `&or=(address_id.eq.${addressId},is_catch_all.eq.true)`;
    } else if (addressId) {
      path += `&address_id=eq.${addressId}`;
    }
    if (isStarred === "true") path += "&is_starred=eq.true";
    if (isRead === "false") path += "&is_read=eq.false";
    if (isRead === "true") path += "&is_read=eq.true";
    if (isCatchAll === "true") path += "&is_catch_all=eq.true";
    else if (isCatchAll === "false") path += "&is_catch_all=eq.false";
    if (isSpam === "true") path += "&is_spam=eq.true";
    else if (isSpam === "false") path += "&is_spam=eq.false";
    if (search) {
      const q = sanitizeSearch(search);
      path += `&or=(subject.ilike.*${q}*,from_address.ilike.*${q}*,body_text.ilike.*${q}*)`;
    }

    // Keyset filter for pages after the first. Top-level and=() so it can't
    // collide with the or= params above (address+catchall, search).
    if (cursorParam) {
      const cur = decodeCursor(cursorParam);
      if (!cur) return errorResponse("Invalid cursor", 400, origin);
      const ts = encodeURIComponent(cur.ts); // timestamptz contains "+"
      path += `&and=(or(received_at.lt.${ts},and(received_at.eq.${ts},id.lt.${cur.id})))`;
    }

    // First-page/reset fetches also want the filter's total row count; it
    // rides the same query via PostgREST's count header (one round-trip).
    // Never count on search: ilike over body_text can't use an index, and
    // count=exact turns that into a full scan that trips the statement
    // timeout (measured 8s+ → 500). Search results live off has_more alone.
    const wantTotal = withTotal && !cursorParam && !search;
    const { data, ok, headers } = await supabaseQuery(
      env,
      path,
      wantTotal ? { headers: { Prefer: "count=exact" } } : {}
    );
    if (!ok) return errorResponse("Failed to fetch messages", 500, origin);

    // Add preview text (first 120 chars of body_text)
    const messages = Array.isArray(data) ? data : [];
    for (const msg of messages) {
      msg.preview = msg.body_text ? msg.body_text.substring(0, 120).replace(/\n/g, " ") : "";
      delete msg.body_text; // Don't send full body in list
    }

    if (cursorParam || withTotal) {
      let total: number | null = null;
      if (wantTotal) {
        const contentRange = headers.get("content-range");
        total = contentRange ? parseInt(contentRange.split("/")[1] || "0") : 0;
      }
      const last = messages.length > 0 ? messages[messages.length - 1] : null;
      const hasMore = messages.length === limit;
      return jsonResponse(
        {
          messages,
          total,
          next_cursor: hasMore && last ? encodeCursor(last) : null,
          has_more: hasMore,
        },
        200,
        origin
      );
    }

    return jsonResponse(messages, 200, origin);
  }

  if (request.method === "PATCH") {
    const body = await request.json() as {
      id?: string;
      ids?: string[];
      is_read?: boolean;
      is_starred?: boolean;
      is_archived?: boolean;
      is_trash?: boolean;
      is_spam?: boolean;
      folder?: string;
    };

    // Bulk mode: ids[] updates every row in one request (single response,
    // one spam-reputation pass per distinct sender).
    const bulkIds = Array.isArray(body.ids) && body.ids.length > 0 ? body.ids : null;
    if (!body.id && !bulkIds) return errorResponse("id or ids is required", 400, origin);
    if (bulkIds && (bulkIds.length > 500 || bulkIds.some((i) => !UUID_RE.test(i)))) {
      return errorResponse("ids must be at most 500 valid UUIDs", 400, origin);
    }

    const updates: Record<string, any> = {};
    if (body.is_read !== undefined) updates.is_read = body.is_read;
    if (body.is_starred !== undefined) updates.is_starred = body.is_starred;
    if (body.is_archived !== undefined) updates.is_archived = body.is_archived;
    if (body.is_trash !== undefined) updates.is_trash = body.is_trash;
    if (body.folder !== undefined) updates.folder = body.folder;

    // is_spam toggle moves folder appropriately (spam <-> inbox) and updates
    // the per-sender reputation cache with user_override=true so the next
    // message from this sender skips the classifier and uses the user's call.
    if (body.is_spam !== undefined) {
      updates.is_spam = body.is_spam;
      if (body.is_spam) {
        updates.folder = "spam";
      } else if (body.folder === undefined) {
        // Restore: if no explicit folder was sent, default to inbox.
        updates.folder = "inbox";
      }
    }

    const target = bulkIds ? `id=in.(${bulkIds.join(",")})` : `id=eq.${body.id}`;
    const { data, ok } = await supabaseQuery(env, `/email_messages?${target}`, {
      method: "PATCH",
      body: updates,
    });

    if (!ok) return errorResponse("Failed to update message", 500, origin);

    // After a user spam-mark, upsert sender reputation with user_override=true
    // for every distinct sender touched.
    if (body.is_spam !== undefined) {
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      const senders = [...new Set(rows.map((r: any) => r?.from_address).filter(Boolean))] as string[];
      const verdict = body.is_spam ? "spam" : "trusted";
      const score = body.is_spam ? 1.0 : 0.0;
      const now = new Date().toISOString();
      for (const fromAddress of senders) {
        const updRes = await supabaseQuery(
          env,
          `/email_sender_reputation?from_address=eq.${encodeURIComponent(fromAddress)}`,
          {
            method: "PATCH",
            body: { verdict, spam_score: score, last_seen_at: now, user_override: true, updated_at: now },
          }
        );
        if (!updRes.ok || !Array.isArray(updRes.data) || updRes.data.length === 0) {
          await supabaseQuery(env, "/email_sender_reputation", {
            method: "POST",
            body: { from_address: fromAddress, verdict, spam_score: score, user_override: true },
          });
        }
      }
    }

    if (bulkIds) return jsonResponse(Array.isArray(data) ? data : [], 200, origin);
    return jsonResponse(Array.isArray(data) ? data[0] : data, 200, origin);
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return errorResponse("id is required", 400, origin);

    const { ok } = await supabaseQuery(env, `/email_messages?id=eq.${id}`, {
      method: "DELETE",
    });
    if (!ok) return errorResponse("Failed to delete message", 500, origin);
    return jsonResponse({ deleted: true }, 200, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
