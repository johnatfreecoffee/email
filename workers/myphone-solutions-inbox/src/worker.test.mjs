import assert from "node:assert/strict";
import test from "node:test";
import { handleEmail, handleReplayRequest, replayInbox } from "./worker.js";

const RAW = [
  "Message-ID: <repair-test@example.com>",
  "From: Ada <ada@example.com>",
  "To: hello@myphone.solutions",
  "Subject: hello there",
  "",
  "plain body",
  "",
].join("\r\n");

function memoryKv() {
  const store = new Map();
  return {
    store,
    async put(key, value, opts) {
      store.set(key, { value, opts });
    },
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async list() {
      return {
        keys: [...store.keys()].map((name) => ({
          name,
          expiration: store.get(name)?.opts?.expiration,
        })),
        list_complete: true,
      };
    },
  };
}

function message() {
  return {
    from: "ada@example.com",
    to: "hello@myphone.solutions",
    raw: RAW,
    headers: new Headers({
      subject: "hello there",
      "message-id": "<repair-test@example.com>",
    }),
  };
}

function savedRecords(kv) {
  return [...kv.store.entries()]
    .filter(([key]) => key !== "__replay_lock")
    .map(([, entry]) => JSON.parse(entry.value));
}

test("missing ingest secret persists the failure and keeps the raw copy", async () => {
  const kv = memoryKv();
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("should not send");
  };
  try {
    await handleEmail(message(), {
      INBOX: kv,
      INGEST_URL: "https://email.example/api/email/ingest",
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetches, 0);
  const records = savedRecords(kv);
  assert.equal(records.length, 1);
  assert.equal(records[0].ingest_status, "failed");
  assert.equal(records[0].ingest_error, "missing_secret");
  assert.equal(records[0].raw, RAW.slice(0, 200000));
  assert.equal(records[0].ingest_message_id, "repair-test@example.com");
});

test("ingest HTTP failure is persisted without the response body", async () => {
  const kv = memoryKv();
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("mailbox code 999111", { status: 500, headers: { "content-type": "text/plain" } });
  try {
    await handleEmail(message(), {
      INBOX: kv,
      INGEST_URL: "https://email.example/api/email/ingest",
      EMAIL_INGEST_SECRET: "test-ingest-secret",
    });
  } finally {
    globalThis.fetch = original;
  }
  const records = savedRecords(kv);
  assert.equal(records[0].ingest_status, "failed");
  assert.equal(records[0].ingest_error, "http");
  assert.equal(records[0].ingest_http_status, 500);
  assert.equal(records[0].raw.includes("plain body"), true);
  const dumped = JSON.stringify(records[0]);
  assert.equal(dumped.includes("999111"), false);
  assert.equal(dumped.includes("mailbox code"), false);
});

test("normal receipt posts the secret header and marks the copy delivered", async () => {
  const kv = memoryKv();
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return Response.json({ received: true, message_id: "msg-1" });
  };
  try {
    await handleEmail(message(), {
      INBOX: kv,
      INGEST_URL: "https://email.example/api/email/ingest",
      EMAIL_INGEST_SECRET: "test-ingest-secret",
      DOMAIN: "myphone.solutions",
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers["X-Email-Ingest-Secret"], "test-ingest-secret");
  assert.equal(seen[0].body.ingest_message_id, "repair-test@example.com");
  assert.equal(seen[0].body.domain, "myphone.solutions");
  assert.equal(seen[0].body.to, "hello@myphone.solutions");
  const records = savedRecords(kv);
  assert.equal(records[0].ingest_status, "ok");
  assert.equal(records[0].ingest_error, null);
});

test("repeated replay is idempotent and does not post a delivered copy again", async () => {
  const kv = memoryKv();
  let posts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    posts += 1;
    if (posts === 1) return Response.json({ received: true, message_id: "msg-1" });
    return Response.json({ received: true, duplicate: true, message_id: "msg-1" });
  };
  const env = {
    INBOX: kv,
    INGEST_URL: "https://email.example/api/email/ingest",
    EMAIL_INGEST_SECRET: "test-ingest-secret",
  };
  try {
    await kv.put(
      "2026-11-07T00:00:00.000Z_abc",
      JSON.stringify({
        from: "ada@example.com",
        to: "hello@myphone.solutions",
        subject: "hello there",
        raw: RAW,
        headers: { "message-id": "<repair-test@example.com>" },
        received_at: "2026-11-07T00:00:00.000Z",
        ingest_message_id: "repair-test@example.com",
        ingest_status: "failed",
        ingest_error: "missing_secret",
      }),
      { expiration: 1893456000 }
    );
    const first = await replayInbox(env);
    const second = await replayInbox(env);
    assert.deepEqual(first, { recovered: 1, duplicate: 0, failed: 0, skipped: 0, attempted: 1 });
    assert.deepEqual(second, { recovered: 0, duplicate: 0, failed: 0, skipped: 1, attempted: 0 });
    assert.equal(posts, 1);
    const records = savedRecords(kv);
    assert.equal(records[0].ingest_status, "ok");
    assert.equal(records[0].raw.includes("plain body"), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("replay derives the same ingest id from a stored raw copy", async () => {
  const kv = memoryKv();
  const posted = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    posted.push(JSON.parse(opts.body).ingest_message_id);
    return Response.json({ received: true, message_id: "msg-raw" });
  };
  try {
    await kv.put(
      "old",
      JSON.stringify({
        from: "ada@example.com",
        to: "hello@myphone.solutions",
        subject: "hello there",
        raw: RAW,
        ingest_status: "failed",
        ingest_error: "missing_secret",
      })
    );
    const first = await replayInbox({
      INBOX: kv,
      INGEST_URL: "https://email.example/api/email/ingest",
      EMAIL_INGEST_SECRET: "test-ingest-secret",
    });
    const second = await replayInbox({
      INBOX: kv,
      INGEST_URL: "https://email.example/api/email/ingest",
      EMAIL_INGEST_SECRET: "test-ingest-secret",
    });
    assert.deepEqual(posted, ["repair-test@example.com"]);
    assert.equal(first.recovered, 1);
    assert.equal(second.skipped, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("replay endpoint requires the nonce and accepts it once", async () => {
  const kv = memoryKv();
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ received: true, duplicate: true, message_id: "msg-1" });
  try {
    await kv.put(
      "2026-11-07T00:00:00.000Z_abc",
      JSON.stringify({
        from: "ada@example.com",
        to: "hello@myphone.solutions",
        subject: "hello there",
        raw: RAW,
        ingest_status: "failed",
        ingest_message_id: "repair-test@example.com",
      })
    );
    const hidden = await handleReplayRequest(new Request("https://worker.example/replay", { method: "POST" }), {
      INBOX: kv,
    });
    assert.equal(hidden.status, 404);

    const denied = await handleReplayRequest(
      new Request("https://worker.example/replay", {
        method: "POST",
        headers: { "X-Replay-Nonce": "nope" },
      }),
      { INBOX: kv, REPLAY_NONCE: "once-nonce", INGEST_URL: "https://email.example/ingest", EMAIL_INGEST_SECRET: "s" }
    );
    assert.equal(denied.status, 401);

    const ok = await handleReplayRequest(
      new Request("https://worker.example/replay", {
        method: "POST",
        headers: { "X-Replay-Nonce": "once-nonce" },
      }),
      { INBOX: kv, REPLAY_NONCE: "once-nonce", INGEST_URL: "https://email.example/ingest", EMAIL_INGEST_SECRET: "s" }
    );
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.duplicate, 1);
    assert.equal(body.recovered, 0);

    const again = await handleReplayRequest(
      new Request("https://worker.example/replay", {
        method: "POST",
        headers: { "X-Replay-Nonce": "once-nonce" },
      }),
      { INBOX: kv, REPLAY_NONCE: "once-nonce", INGEST_URL: "https://email.example/ingest", EMAIL_INGEST_SECRET: "s" }
    );
    assert.equal(again.status, 409);
  } finally {
    globalThis.fetch = original;
  }
});
