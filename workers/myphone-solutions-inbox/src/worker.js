/**
 * Cloudflare Email Routing handler for myphone.solutions.
 * KV audit trail (14d) + POST to email app ingest (no forward / no send).
 */
export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).text();
    const headers = {};
    for (const [k, v] of message.headers) {
      headers[k] = v;
    }

    const key = `${new Date().toISOString()}_${crypto.randomUUID().slice(0, 8)}`;
    const kvPayload = {
      from: message.from,
      to: message.to,
      subject: headers.subject || headers.Subject || "",
      raw: raw.slice(0, 200000),
    };
    ctx.waitUntil(
      env.INBOX.put(key, JSON.stringify(kvPayload), { expirationTtl: 1209600 })
    );

    const ingestUrl = env.INGEST_URL;
    const secret = env.EMAIL_INGEST_SECRET;
    if (!ingestUrl || !secret) {
      console.error("myphone-solutions-inbox: missing INGEST_URL or EMAIL_INGEST_SECRET");
      return;
    }

    const body = {
      domain: env.DOMAIN || "myphone.solutions",
      from: message.from,
      to: message.to,
      headers,
      raw,
      received_at: new Date().toISOString(),
    };

    ctx.waitUntil(
      fetch(ingestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Email-Ingest-Secret": secret,
        },
        body: JSON.stringify(body),
      }).then(async (res) => {
        if (!res.ok) {
          console.error("ingest failed", res.status, await res.text().catch(() => ""));
        }
      })
    );
  },
};
