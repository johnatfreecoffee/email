import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
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

    // Count-only mode: return just the count using Supabase's count header
    if (countOnly) {
      let countPath = `/email_messages?select=id`;
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
      if (search) countPath += `&or=(subject.ilike.*${search}*,from_address.ilike.*${search}*,body_text.ilike.*${search}*)`;

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

    let path = `/email_messages?order=received_at.desc&limit=${limit}&offset=${offset}`;
    path += `&select=id,domain_id,address_id,direction,from_address,from_name,to_addresses,subject,is_read,is_starred,is_archived,is_trash,is_draft,is_catch_all,is_spam,spam_score,folder,received_at,body_text`;

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
    if (search) path += `&or=(subject.ilike.*${search}*,from_address.ilike.*${search}*,body_text.ilike.*${search}*)`;

    const { data, ok } = await supabaseQuery(env, path);
    if (!ok) return errorResponse("Failed to fetch messages", 500, origin);

    // Add preview text (first 120 chars of body_text)
    const messages = Array.isArray(data) ? data : [];
    for (const msg of messages) {
      msg.preview = msg.body_text ? msg.body_text.substring(0, 120).replace(/\n/g, " ") : "";
      delete msg.body_text; // Don't send full body in list
    }

    return jsonResponse(messages, 200, origin);
  }

  if (request.method === "PATCH") {
    const body = await request.json() as {
      id: string;
      is_read?: boolean;
      is_starred?: boolean;
      is_archived?: boolean;
      is_trash?: boolean;
      is_spam?: boolean;
      folder?: string;
    };

    if (!body.id) return errorResponse("id is required", 400, origin);

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

    const { data, ok } = await supabaseQuery(env, `/email_messages?id=eq.${body.id}`, {
      method: "PATCH",
      body: updates,
    });

    if (!ok) return errorResponse("Failed to update message", 500, origin);

    // After a user spam-mark, upsert sender reputation with user_override=true.
    if (body.is_spam !== undefined) {
      const updated = Array.isArray(data) && data.length > 0 ? data[0] : data;
      const fromAddress = (updated as any)?.from_address;
      if (fromAddress) {
        const verdict = body.is_spam ? "spam" : "trusted";
        const score = body.is_spam ? 1.0 : 0.0;
        const now = new Date().toISOString();
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
