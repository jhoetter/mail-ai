#!/usr/bin/env node
// Generate a synthetic MIME fixture corpus matching the categories in
// prompt.md §Fixture Corpus. These are SYNTHETIC and tagged as such in
// fixtures/mime-samples/INDEX.json — replace with real-world .eml files
// before production.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "fixtures/mime-samples";
mkdirSync(OUT, { recursive: true });

const today = "Tue, 21 Apr 2026 09:00:00 +0000";

function mkSimple(id, { from, to, subject, body, headers = [] }) {
  return [
    `Message-ID: <${id}@mailai.test>`,
    `Date: ${today}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    ...headers,
    "",
    body,
    "",
  ].join("\r\n");
}

function mkAlt(id, { from, to, subject, html, text }) {
  const boundary = `=_b_${id}`;
  return [
    `Message-ID: <${id}@mailai.test>`,
    `Date: ${today}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

const samples = [];

function add(category, name, body) {
  const fname = `${category}-${name}.eml`;
  writeFileSync(join(OUT, fname), body);
  samples.push({ file: fname, category, synthetic: true });
}

// Gmail-style HTML + inline image stand-in
for (let i = 0; i < 5; i++) {
  add(
    "gmail",
    `simple-${i}`,
    mkAlt(`gmail-${i}`, {
      from: "alice@gmail.com",
      to: "bob@example.com",
      subject: `Gmail-style sample ${i}`,
      text: `Hi,\nThis is plaintext part ${i}.\n-- \nAlice`,
      html: `<div dir="ltr"><p>This is HTML part ${i}.</p><div class="gmail_signature">Alice</div></div>`,
    }),
  );
}

// Outlook-style with References chain
for (let i = 0; i < 3; i++) {
  const refs = Array.from({ length: 5 }, (_, k) => `<thread-${i}-${k}@outlook.com>`).join(" ");
  add(
    "outlook",
    `refs-${i}`,
    mkSimple(`outlook-${i}`, {
      from: "carol@outlook.com",
      to: "team@example.com",
      subject: `RE: Q3 numbers ${i}`,
      headers: [
        `In-Reply-To: <thread-${i}-4@outlook.com>`,
        `References: ${refs}`,
        "X-Microsoft-Antispam: synthetic",
      ],
      body: `Carol here, replying to thread ${i}.`,
    }),
  );
}

// Apple Mail signature div
add(
  "apple",
  "signature",
  mkAlt("apple-1", {
    from: "dan@icloud.com",
    to: "bob@example.com",
    subject: "Sent from Apple Mail",
    text: "Hello\n\nSent from my iPhone",
    html: '<div>Hello</div><div class="apple-mail-signature">Sent from my iPhone</div>',
  }),
);

// Thunderbird format=flowed
add(
  "thunderbird",
  "flowed",
  mkSimple("tb-1", {
    from: "ed@example.org",
    to: "bob@example.com",
    subject: "Plain flowed",
    headers: ['Content-Type: text/plain; charset=UTF-8; format=flowed; delsp=no'],
    body: "Line one is long enough to wrap and wrap and wrap and wrap and wrap and wrap and wrap. \nLine two.",
  }),
);

// Multilingual: UTF-8 subject (RFC 2047 encoded-word)
add(
  "multilingual",
  "utf8",
  mkSimple("ml-utf8", {
    from: "fran\u00e7ois@example.fr",
    to: "bob@example.com",
    subject: "=?UTF-8?B?VG9rb24gw6lww6ljaWFsZQ==?=",
    body: "Bonjour\u00a0le monde. \u00c9p\u00e9cial.",
  }),
);

// Malformed: unterminated boundary (must not crash parser)
const malformedBoundary = "=_oops";
writeFileSync(
  join(OUT, "malformed-unterminated.eml"),
  [
    "Message-ID: <bad-1@mailai.test>",
    `Date: ${today}`,
    "From: x@x.test",
    "To: y@y.test",
    "Subject: malformed",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${malformedBoundary}"`,
    "",
    `--${malformedBoundary}`,
    "Content-Type: text/plain",
    "",
    "Part one",
    "(boundary never closed)",
    "",
  ].join("\r\n"),
);
samples.push({ file: "malformed-unterminated.eml", category: "malformed", synthetic: true });

// Index file
writeFileSync(
  join(OUT, "INDEX.json"),
  JSON.stringify(
    { generated_at: new Date().toISOString(), note: "Synthetic fixtures. Replace with real .eml files before production.", samples },
    null,
    2,
  ),
);

console.log(`Wrote ${samples.length} fixtures to ${OUT}`);
