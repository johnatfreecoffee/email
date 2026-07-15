import { Env, jsonResponse, errorResponse, optionsResponse, supabaseQuery, resendAPI, cloudflareDNS, checkAuth } from "./_shared";

interface CFContext {
  request: Request;
  env: Env;
}

// Set up a Resend domain (sending+receiving) end-to-end: create in Resend,
// push DNS records to Cloudflare, trigger verification, and upsert the
// email_domains row. Used for both the base domain and any mirror subdomain.
async function setupResendDomain(
  env: Env,
  domain: string,
  zoneId: string | null,
  capabilities: { sending: boolean; receiving: boolean } = { sending: true, receiving: true },
  zoneName: string | null = null
): Promise<{
  ok: boolean;
  resend_domain_id?: string;
  records?: any[];
  db_row?: any;
  error?: string;
}> {
  // Try creating; if the domain already exists in Resend, fall back to fetching it
  const createRes = await resendAPI(env, "/domains", {
    method: "POST",
    body: { name: domain, capabilities: { sending: capabilities.sending ? "enabled" : "disabled", receiving: capabilities.receiving ? "enabled" : "disabled" } },
  });

  let resendDomainId = "";
  let resendRecords: any[] = [];

  if (createRes.ok) {
    const created = createRes.data as { id: string; records: any[] };
    resendDomainId = created.id;
    resendRecords = created.records || [];
  } else {
    const listRes = await resendAPI(env, "/domains");
    if (listRes.ok) {
      const existing = ((listRes.data as any).data || []).find((d: any) => d.name === domain);
      if (existing) {
        resendDomainId = existing.id;
        if (existing.capabilities?.receiving !== "enabled" && capabilities.receiving) {
          await resendAPI(env, `/domains/${existing.id}`, {
            method: "PATCH",
            body: { capabilities: { sending: "enabled", receiving: "enabled" } },
          });
        }
        const detailRes = await resendAPI(env, `/domains/${existing.id}`);
        if (detailRes.ok) resendRecords = (detailRes.data as any).records || [];
      } else {
        return { ok: false, error: `Resend create failed: ${JSON.stringify(createRes.data)}` };
      }
    } else {
      return { ok: false, error: `Resend create failed: ${JSON.stringify(createRes.data)}` };
    }
  }

  // Push DNS records to Cloudflare. Resend returns record names relative to
  // the zone apex (e.g. `inbox` for the mirror MX on `inbox.<base>` in the
  // `<base>` zone), so we always append the zone apex — not the passed-in
  // domain, which would double-up for subdomain setups like inbox.<base>.
  if (zoneId && resendRecords.length > 0) {
    const apex = zoneName || domain;
    for (const record of resendRecords) {
      let recordName: string;
      if (!record.name || record.name === "") recordName = apex;
      else if (record.name === apex || record.name.endsWith(`.${apex}`)) recordName = record.name;
      else recordName = `${record.name}.${apex}`;

      const dnsBody: any = { type: record.type, name: recordName, content: record.value, ttl: 1 };
      if (record.type === "MX" && record.priority !== undefined) dnsBody.priority = record.priority;
      if (record.type === "TXT" || record.type === "MX" || record.type === "CNAME") dnsBody.proxied = false;

      const existCheck = await cloudflareDNS(env, `/zones/${zoneId}/dns_records?type=${record.type}&name=${recordName}`);
      const existingRecords = (existCheck.data as any)?.result || [];
      const alreadyExists = existingRecords.some((r: any) => r.content === record.value);
      if (!alreadyExists) {
        await cloudflareDNS(env, `/zones/${zoneId}/dns_records`, { method: "POST", body: dnsBody });
      }
    }
  }

  await resendAPI(env, `/domains/${resendDomainId}/verify`, { method: "POST" });

  // Upsert email_domains row
  const existingDb = await supabaseQuery(env, `/email_domains?domain=eq.${domain}&limit=1`);
  let dbResult: any;
  if (existingDb.ok && Array.isArray(existingDb.data) && existingDb.data.length > 0) {
    const updateRes = await supabaseQuery(env, `/email_domains?domain=eq.${domain}`, {
      method: "PATCH",
      body: {
        resend_domain_id: resendDomainId,
        status: zoneId ? "dns_configured" : "pending",
        dns_records: resendRecords,
        cloudflare_zone_id: zoneId,
        capabilities: capabilities,
        updated_at: new Date().toISOString(),
      },
    });
    dbResult = updateRes.data;
  } else {
    const insertRes = await supabaseQuery(env, "/email_domains", {
      method: "POST",
      body: {
        domain,
        resend_domain_id: resendDomainId,
        status: zoneId ? "dns_configured" : "pending",
        dns_records: resendRecords,
        cloudflare_zone_id: zoneId,
        capabilities: capabilities,
      },
    });
    dbResult = insertRes.data;
  }
  return {
    ok: true,
    resend_domain_id: resendDomainId,
    records: resendRecords,
    db_row: Array.isArray(dbResult) ? dbResult[0] : dbResult,
  };
}

// GET: List domains  |  POST: Add new domain  |  DELETE: Remove domain
export const onRequest = async (context: CFContext) => {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || undefined;

  if (request.method === "OPTIONS") return optionsResponse(origin);

  const authError = await checkAuth(context.request, env);
  if (authError) return authError;

  // ─── GET: List domains ───
  if (request.method === "GET") {
    const { data, ok } = await supabaseQuery(env, "/email_domains?order=created_at.desc");
    if (!ok) return errorResponse("Failed to fetch domains", 500, origin);

    const domains = Array.isArray(data) ? data : [];

    for (const d of domains) {
      const addrRes = await supabaseQuery(
        env,
        `/email_addresses?domain_id=eq.${d.id}&select=id,address,display_name,is_active`
      );
      d.addresses = Array.isArray(addrRes.data) ? addrRes.data : [];
    }

    return jsonResponse(domains, 200, origin);
  }

  // ─── DELETE: Remove domain ───
  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const domainId = url.searchParams.get("id");
    if (!domainId) return errorResponse("id is required", 400, origin);

    // Get domain info first
    const { data: domainData } = await supabaseQuery(env, `/email_domains?id=eq.${domainId}&limit=1`);
    const domain = Array.isArray(domainData) && domainData.length > 0 ? domainData[0] : null;

    // Delete from Resend if we have an ID
    if (domain?.resend_domain_id) {
      await resendAPI(env, `/domains/${domain.resend_domain_id}`, { method: "DELETE" });
    }

    // Delete addresses first (FK constraint)
    await supabaseQuery(env, `/email_addresses?domain_id=eq.${domainId}`, { method: "DELETE" });
    // Delete messages
    await supabaseQuery(env, `/email_messages?domain_id=eq.${domainId}`, { method: "DELETE" });
    // Delete domain
    await supabaseQuery(env, `/email_domains?id=eq.${domainId}`, { method: "DELETE" });

    return jsonResponse({ deleted: true, domain: domain?.domain }, 200, origin);
  }

  // ─── POST: Add new domain ───
  if (request.method === "POST") {
    const body = await request.json() as {
      domain: string;
      force_replace_mx?: boolean;
      check_only?: boolean;
    };
    if (!body.domain) return errorResponse("domain is required", 400, origin);

    const domain = body.domain.toLowerCase().trim();

    // Find Cloudflare zone (handle subdomains)
    const parts = domain.split(".");
    let zoneId: string | null = null;
    let zoneName: string | null = null;

    for (let i = 0; i < parts.length - 1; i++) {
      const tryDomain = parts.slice(i).join(".");
      const zoneRes = await cloudflareDNS(env, `/zones?name=${tryDomain}`);
      if (zoneRes.ok && (zoneRes.data as any).result?.length > 0) {
        zoneId = (zoneRes.data as any).result[0].id;
        zoneName = tryDomain;
        break;
      }
    }

    // Check for existing MX records
    let existingMxRecords: any[] = [];
    if (zoneId) {
      const mxRes = await cloudflareDNS(env, `/zones/${zoneId}/dns_records?type=MX&name=${domain}`);
      if (mxRes.ok && (mxRes.data as any).result) {
        existingMxRecords = (mxRes.data as any).result;
      }
    }

    // ─── CHECK ONLY mode ───
    if (body.check_only) {
      const hasConflict = existingMxRecords.length > 0;
      const mxDetails = existingMxRecords.map((r: any) => ({
        name: r.name, content: r.content, priority: r.priority, id: r.id,
      }));

      let provider = "Unknown";
      const mxContent = existingMxRecords.map((r: any) => r.content?.toLowerCase() || "").join(" ");
      if (mxContent.includes("google") || mxContent.includes("gmail")) provider = "Google Workspace";
      else if (mxContent.includes("outlook") || mxContent.includes("microsoft")) provider = "Microsoft 365";
      else if (mxContent.includes("zoho")) provider = "Zoho Mail";
      else if (mxContent.includes("proton")) provider = "ProtonMail";
      else if (mxContent.includes("icloud")) provider = "iCloud Mail";
      else if (existingMxRecords.length > 0) provider = mxContent.split(".").slice(-3, -1).join(".");

      return jsonResponse({
        has_conflict: hasConflict,
        existing_mx: mxDetails,
        provider,
        suggested_subdomain: domain === zoneName ? `mail.${domain}` : null,
        zone_found: !!zoneId,
        zone_name: zoneName,
      }, 200, origin);
    }

    // MX conflict check (if not forcing)
    if (existingMxRecords.length > 0 && !body.force_replace_mx) {
      const mxContent = existingMxRecords.map((r: any) => r.content?.toLowerCase() || "").join(" ");
      let provider = "another email provider";
      if (mxContent.includes("google") || mxContent.includes("gmail")) provider = "Google Workspace";
      else if (mxContent.includes("outlook") || mxContent.includes("microsoft")) provider = "Microsoft 365";
      else if (mxContent.includes("zoho")) provider = "Zoho Mail";

      return jsonResponse({
        conflict: true, provider,
        existing_mx: existingMxRecords.map((r: any) => ({ name: r.name, content: r.content, priority: r.priority, id: r.id })),
        suggested_subdomain: domain === zoneName ? `mail.${domain}` : null,
        message: `This domain has existing MX records (${provider}). Adding Resend will conflict.`,
      }, 409, origin);
    }

    // Delete existing MX if force replacing — but leave Resend's own MX
    // alone, since setupResendDomain pushes it idempotently anyway.
    if (existingMxRecords.length > 0 && body.force_replace_mx && zoneId) {
      for (const mx of existingMxRecords) {
        const content = (mx.content || "").toLowerCase();
        const isResend =
          content.includes("amazonaws.com") ||
          content.includes("amazonses.com");
        if (!isResend) {
          await cloudflareDNS(env, `/zones/${zoneId}/dns_records/${mx.id}`, { method: "DELETE" });
        }
      }
    }

    // ─── Run the Resend setup (domain + DNS + Supabase row) ───
    const baseSetup = await setupResendDomain(env, domain, zoneId, undefined, zoneName);
    if (!baseSetup.ok) {
      return errorResponse(baseSetup.error || "Resend setup failed", 502, origin);
    }

    return jsonResponse({
      domain: baseSetup.db_row,
      dns_auto_configured: !!zoneId,
      resend_domain_id: baseSetup.resend_domain_id,
      records: baseSetup.records,
      mx_replaced: existingMxRecords.length > 0 && body.force_replace_mx,
    }, 201, origin);
  }

  return errorResponse("Method not allowed", 405, origin);
};
