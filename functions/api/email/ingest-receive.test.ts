import assert from "node:assert/strict";
import test from "node:test";
import { deliverInboundMessage } from "./_inbound-deliver";
import { onRequest } from "./ingest";

const ENV = {
  EMAIL_INGEST_SECRET: "test-ingest-secret",
  SUPABASE_URL: "https://db.example.test",
  SUPABASE_SERVICE_KEY: "service-key",
  RESEND_API_KEY: "resend-key",
  CLOUDFLARE_API_TOKEN: "cf-token",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installMailbox(options: { conflict?: boolean } = {}) {
  const messages: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }

    if (url.includes("/email_domains?")) {
      if (url.includes("domain=eq.myphone.host")) {
        return json([
          { id: "host-id", domain: "myphone.host", catch_all_enabled: false, catch_all_subject_prefix: null },
        ]);
      }
      if (url.includes("domain=eq.myphone.solutions")) {
        return json([
          {
            id: "sol-id",
            domain: "myphone.solutions",
            catch_all_enabled: true,
            catch_all_subject_prefix: "[Catch-All]",
          },
        ]);
      }
      return json([]);
    }

    if (url.includes("/email_addresses?")) {
      const local = decodeURIComponent((url.match(/address=eq\.([^&]+)/) || [])[1] || "");
      if (local === "hello") return json([{ id: "addr-hello", address: "hello", is_active: true }]);
      return json([]);
    }

    if (url.includes("/email_messages") && method === "GET") {
      if (options.conflict) return json([]);
      if (url.includes("ingest_message_id=eq.")) {
        const id = decodeURIComponent((url.match(/ingest_message_id=eq\.([^&]+)/) || [])[1] || "");
        return json(messages.filter((m) => m.ingest_message_id === id).slice(0, 1));
      }
      if (url.includes("resend_email_id=eq.")) {
        const id = decodeURIComponent((url.match(/resend_email_id=eq\.([^&]+)/) || [])[1] || "");
        return json(messages.filter((m) => m.resend_email_id === id).slice(0, 1));
      }
      return json([]);
    }

    if (url.endsWith("/email_messages") && method === "POST") {
      if (options.conflict || (body?.ingest_message_id && messages.some((m) => m.ingest_message_id === body?.ingest_message_id))) {
        return json(
          { code: "23505", message: 'duplicate key value violates unique constraint "idx_email_messages_ingest_dedup"' },
          409
        );
      }
      const row = { id: `msg-${messages.length + 1}`, ...(body || {}) };
      messages.push(row);
      return json([row], 201);
    }

    if (method === "GET") return json([]);
    return json({ ok: true });
  };

  return {
    messages,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function ingestRequest(body: unknown, secret?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret) headers.set("X-Email-Ingest-Secret", secret);
  return new Request("https://email.example/api/email/ingest", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const SOLUTIONS_MAIL = {
  domain: "myphone.solutions",
  from: "Ada <ada@example.com>",
  to: "hello@myphone.solutions",
  subject: "hello there",
  text: "plain body",
  ingest_message_id: "repair-test@example.com",
  headers: { "message-id": "<repair-test@example.com>" },
};

test("ingest rejects missing, wrong, and unconfigured secrets", async () => {
  const missing = await onRequest({
    request: ingestRequest(SOLUTIONS_MAIL),
    env: ENV,
  });
  assert.equal(missing.status, 401);

  const wrong = await onRequest({
    request: ingestRequest(SOLUTIONS_MAIL, "other-secret"),
    env: ENV,
  });
  assert.equal(wrong.status, 401);

  const unconfigured = await onRequest({
    request: ingestRequest(SOLUTIONS_MAIL, "test-ingest-secret"),
    env: { ...ENV, EMAIL_INGEST_SECRET: undefined },
  });
  assert.equal(unconfigured.status, 503);
});

test("normal receipt stores one solutions message and a repeat is a duplicate", async () => {
  const box = installMailbox();
  try {
    const first = await onRequest({
      request: ingestRequest(SOLUTIONS_MAIL, "test-ingest-secret"),
      env: ENV,
    });
    const second = await onRequest({
      request: ingestRequest(SOLUTIONS_MAIL, "test-ingest-secret"),
      env: ENV,
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.received, true);
    assert.equal(firstBody.duplicate, undefined);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.duplicate, true);
    assert.equal(secondBody.message_id, firstBody.message_id);
    assert.equal(box.messages.length, 1);
    assert.equal(box.messages[0].domain_id, "sol-id");
    assert.equal(box.messages[0].ingest_message_id, "repair-test@example.com");
    assert.deepEqual(box.messages[0].to_addresses, ["hello@myphone.solutions"]);
  } finally {
    box.restore();
  }
});

test("a unique-constraint race is an idempotent duplicate", async () => {
  const box = installMailbox({ conflict: true });
  try {
    const res = await onRequest({
      request: ingestRequest(SOLUTIONS_MAIL, "test-ingest-secret"),
      env: ENV,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.duplicate, true);
    assert.equal(box.messages.length, 0);
  } finally {
    box.restore();
  }
});

test("myphone.host delivery stays independent of solutions ingest", async () => {
  const box = installMailbox();
  try {
    const host = await deliverInboundMessage(ENV, "https://email.example/api/email/inbound", {
      envelopeTo: ["hello@myphone.host"],
      ccAddresses: [],
      bccAddresses: [],
      subject: "host note",
      fromRaw: "Host Sender <host@example.com>",
      bodyHtml: null,
      bodyText: "host body",
      headers: { "message-id": "<host-msg@example.com>" },
      createdAt: "2026-11-06T12:00:00.000Z",
      resendEmailId: "re_host_1",
      domainHint: "myphone.host",
      spamVerdictOverride: { is_spam: false, score: 0, reason: "test" },
      skipLlmSpam: true,
    });
    assert.equal(host.status, 200);

    const solutions = await onRequest({
      request: ingestRequest(SOLUTIONS_MAIL, "test-ingest-secret"),
      env: ENV,
    });
    assert.equal(solutions.status, 200);

    const hostAgain = await deliverInboundMessage(ENV, "https://email.example/api/email/inbound", {
      envelopeTo: ["hello@myphone.host"],
      ccAddresses: [],
      bccAddresses: [],
      subject: "host note",
      fromRaw: "Host Sender <host@example.com>",
      bodyHtml: null,
      bodyText: "host body changed",
      headers: { "message-id": "<host-msg@example.com>" },
      createdAt: "2026-11-06T12:00:00.000Z",
      resendEmailId: "re_host_1",
      domainHint: "myphone.host",
      spamVerdictOverride: { is_spam: false, score: 0, reason: "test" },
      skipLlmSpam: true,
    });
    const hostAgainBody = await hostAgain.json();
    assert.equal(hostAgainBody.duplicate, true);

    const hostRows = box.messages.filter((m) => m.domain_id === "host-id");
    const solRows = box.messages.filter((m) => m.domain_id === "sol-id");
    assert.equal(hostRows.length, 1);
    assert.equal(hostRows[0].subject, "host note");
    assert.equal(hostRows[0].body_text, "host body");
    assert.equal(hostRows[0].resend_email_id, "re_host_1");
    assert.equal(solRows.length, 1);
    assert.equal(solRows[0].ingest_message_id, "repair-test@example.com");
  } finally {
    box.restore();
  }
});
