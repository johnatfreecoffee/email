import assert from "node:assert/strict";
import test from "node:test";
import { parseRawMime } from "./_mime";

test("a DKIM signed-header list is not the message content type", () => {
  const raw = [
    "DKIM-Signature: v=1; h=from:content-type:date:from:mime-version:subject;",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "Message-ID: <plain@example.com>",
    "Subject: hello there",
    "",
    "Hello=20there",
    "",
  ].join("\r\n");
  const parsed = parseRawMime(raw);
  assert.equal(parsed.text, "Hello there");
  assert.equal(parsed.html, null);
});

test("multipart boundaries keep their original case", () => {
  const raw = [
    "DKIM-Signature: v=1; h=content-type:subject;",
    'Content-Type: multipart/alternative; boundary="AbC123"',
    "Message-ID: <multi@example.com>",
    "Subject: hello there",
    "",
    "--AbC123",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain line",
    "--AbC123",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>html line</p>",
    "--AbC123--",
    "",
  ].join("\r\n");
  const parsed = parseRawMime(raw);
  assert.equal(parsed.text, "plain line");
  assert.equal(parsed.html, "<p>html line</p>");
});

test("nested multipart and quoted-printable html are both kept", () => {
  const raw = [
    'Content-Type: multipart/mixed; boundary="OuterMix"',
    "Message-ID: <nested@example.com>",
    "Subject: hello there",
    "",
    "--OuterMix",
    'Content-Type: multipart/alternative; boundary="InnerAlt"',
    "",
    "--InnerAlt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "nested plain",
    "--InnerAlt",
    "Content-Type: text/html; charset=iso-8859-1",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>code=20here</p>",
    "--InnerAlt--",
    "--OuterMix--",
    "",
  ].join("\r\n");
  const parsed = parseRawMime(raw);
  assert.equal(parsed.text, "nested plain");
  assert.equal(parsed.html, "<p>code here</p>");
});
