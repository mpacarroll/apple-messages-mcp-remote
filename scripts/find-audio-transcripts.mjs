#!/usr/bin/env node
// Read-only. Finds where this Mac's chat.db keeps voice-message transcripts.
// Prints only table/column names and counts, never any message content, so
// the output is safe to paste into an issue or a chat.
//
// Usage, from the repo root after `npm run build`:
//   node scripts/find-audio-transcripts.mjs [days]     (default: 90)
//
// macOS checks Full Disk Access for the app you run this from (Terminal),
// not for node itself, so Terminal needs the grant for this one-off run.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, dirname, extname } from "node:path";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extractTextFromAttributedBody } from "../build/database.js";

const days = Number(process.argv[2] ?? 90);
// Matches both "Transcription" and "transcription" as raw bytes, so it also
// finds the word inside binary archives where a text LIKE would stop at NUL.
const NEEDLE = Buffer.from("ranscri");
const APPLE_EPOCH_OFFSET = 978307200;

let db;
try {
  db = new DatabaseSync(join(homedir(), "Library", "Messages", "chat.db"), { readOnly: true });
} catch (err) {
  console.error(`Could not open chat.db: ${err.message}`);
  console.error("'unable to open database file' here means Terminal needs Full Disk Access.");
  process.exit(1);
}

// chat.db dates are nanoseconds and overflow a JS number, hence BigInt reads.
function rows(sql, ...params) {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt.all(...params);
}

function toBuffer(value) {
  if (typeof value === "string") return Buffer.from(value, "utf-8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function bump(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

const cutoff =
  BigInt(Math.floor(Date.now() / 1000) - APPLE_EPOCH_OFFSET - days * 86400) * 1_000_000_000n;

const schemaHits = rows("SELECT type, name FROM sqlite_master WHERE lower(sql) LIKE '%transcri%'");
const audio = rows("SELECT * FROM message WHERE is_audio_message = 1 AND date > ?", cutoff);
const attachments = rows(
  `SELECT a.* FROM attachment a
   JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
   JOIN message m ON m.ROWID = maj.message_id
   WHERE m.is_audio_message = 1 AND m.date > ?`,
  cutoff
);

const columnHits = {};
for (const [table, set] of [["message", audio], ["attachment", attachments]]) {
  for (const row of set) {
    for (const [column, value] of Object.entries(row)) {
      const buf = toBuffer(value);
      if (buf && buf.includes(NEEDLE)) bump(columnHits, `${table}.${column}`);
    }
  }
}

// A transcript might also simply be the message body. ￼ is the
// placeholder character an attachment-only message carries as its text.
let bodyWithText = 0;
for (const m of audio) {
  const text = m.text ?? extractTextFromAttributedBody(toBuffer(m.attributedBody));
  if (text && text.replace(/￼/g, "").trim().length > 0) bodyWithText++;
}

// Or it could sit in a separate file beside the audio on disk.
const siblingExtensions = {};
for (const a of attachments) {
  if (typeof a.filename !== "string") continue;
  try {
    for (const name of readdirSync(dirname(a.filename.replace(/^~/, homedir())))) {
      bump(siblingExtensions, extname(name).toLowerCase() || "(no extension)");
    }
  } catch {
    bump(siblingExtensions, "(folder unreadable)");
  }
}

const list = (counts) =>
  Object.keys(counts).length === 0
    ? "  none"
    : Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");

console.log(`Voice messages in the last ${days} days: ${audio.length}`);
console.log(`  with an attachment row: ${attachments.length}`);
console.log(`  whose body decodes to real text: ${bodyWithText}`);
console.log(`\nSchema objects mentioning "transcri":`);
console.log(schemaHits.length ? schemaHits.map((s) => `  ${s.type} ${s.name}`).join("\n") : "  none");
console.log(`\nColumns containing "transcri" on those rows:`);
console.log(list(columnHits));
console.log(`\nFiles next to the audio attachments, by extension:`);
console.log(list(siblingExtensions));

// ---------------------------------------------------------------------------
// Layout around the transcript, per voice message, still without content:
// the attribute names in attributedBody, the bytes between the transcript key
// and its value (printable runs shown only when they look like identifiers),
// the value's size, and the key/type layout of the attachment's user_info.
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_.$]*$/;

function describeBytes(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    let j = i;
    while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x7e) j++;
    if (j - i >= 3) {
      const run = buf.subarray(i, j).toString("latin1");
      parts.push(IDENTIFIER.test(run) ? `"${run}"` : `<${j - i} text bytes>`);
      i = j;
    } else {
      parts.push(buf[i].toString(16).padStart(2, "0"));
      i++;
    }
  }
  return parts.join(" ");
}

function attributeNames(buf) {
  const s = buf.toString("latin1");
  return [...new Set(s.match(/__k[A-Za-z]+|\bNS[A-Z][A-Za-z]+|\bIM[A-Z][a-z][A-Za-z]+/g) ?? [])];
}

function readTypedInt(buf, at) {
  const b = buf[at];
  if (b === undefined) return null;
  if (b < 0x80) return [b, 1];
  if (b === 0x81 && at + 3 <= buf.length) return [buf.readUInt16LE(at + 1), 3];
  if (b === 0x82 && at + 5 <= buf.length) return [buf.readUInt32LE(at + 1), 5];
  return null;
}

function valueShape(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return `${bytes.length} bytes, valid UTF-8, ${text.trim().split(/\s+/).filter(Boolean).length} words`;
  } catch {
    return `${bytes.length} bytes, not valid UTF-8`;
  }
}

function transcriptInAttributedBody(buf) {
  const hit = buf.indexOf(NEEDLE);
  if (hit === -1) return ["  no transcript key"];
  const word = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
  let start = hit;
  let end = hit + NEEDLE.length;
  while (start > 0 && word(buf[start - 1])) start--;
  while (end < buf.length && word(buf[end])) end++;
  const out = [`  key: "${buf.subarray(start, end).toString("latin1")}"`];
  const plus = buf.indexOf(0x2b, end);
  const len = plus === -1 || plus - end > 64 ? null : readTypedInt(buf, plus + 1);
  if (!len) {
    out.push(`  next 32 bytes: ${describeBytes(buf.subarray(end, end + 32))}`);
    out.push("  no length-prefixed value found within 64 bytes");
    return out;
  }
  out.push(`  bytes from key to value: ${describeBytes(buf.subarray(end, plus + 1 + len[1]))}`);
  const valueStart = plus + 1 + len[1];
  out.push(`  value: ${valueShape(buf.subarray(valueStart, valueStart + len[0]))}${valueStart + len[0] > buf.length ? " (runs past end)" : ""}`);
  return out;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function plistLayout(buf) {
  const magic = buf.subarray(0, 8).toString("latin1");
  const head = /^[\x20-\x7e]+$/.test(magic) ? magic : buf.subarray(0, 8).toString("hex");
  if (process.platform !== "darwin") return [`  format: ${head} (layout needs plutil, macOS only)`];
  const r = spawnSync("plutil", ["-convert", "xml1", "-o", "-", "-"], { input: buf });
  if (r.status !== 0) return [`  format: ${head}; plutil could not read it`];
  const out = [`  format: ${head}`];
  const VALUE = new Set(["string", "integer", "real", "true", "false", "data", "date", "dict", "array"]);
  let depth = 0;
  let pendingKey = null;
  let lines = 0;
  for (const m of r.stdout.toString("utf-8").matchAll(/<(\/?)(\w+)(\/?)>([^<]*)/g)) {
    const [, closing, tag, selfClosing, text] = m;
    if (tag === "plist") continue;
    if (closing) {
      if (tag === "dict" || tag === "array") depth--;
      continue;
    }
    if (tag === "key") {
      pendingKey = decodeEntities(text);
      continue;
    }
    if (!VALUE.has(tag)) continue;
    let detail = "";
    if (tag === "string") {
      const s = decodeEntities(text);
      detail = ` (${s.length} chars${/\s/.test(s) ? ", has spaces" : ""})`;
    }
    if (lines++ < 60) out.push(`  ${"  ".repeat(depth)}${pendingKey ?? "(unkeyed)"}: ${tag}${detail}`);
    pendingKey = null;
    if ((tag === "dict" || tag === "array") && !selfClosing) depth++;
  }
  if (lines > 60) out.push(`  ... ${lines - 60} more entries`);
  return out;
}

console.log("\n== Layout per voice message (names, types and sizes only) ==");
audio.forEach((m, i) => {
  console.log(`\nVoice message ${i + 1}:`);
  const body = toBuffer(m.attributedBody);
  if (body) {
    console.log(`  attribute names: ${attributeNames(body).join(", ") || "none"}`);
    for (const line of transcriptInAttributedBody(body)) console.log(line);
  } else {
    console.log("  no attributedBody");
  }
  const infos = rows(
    `SELECT a.user_info FROM attachment a
     JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
     WHERE maj.message_id = ?`,
    m.ROWID
  );
  for (const { user_info } of infos) {
    const info = toBuffer(user_info);
    console.log("  attachment user_info:");
    for (const line of info ? plistLayout(info) : ["  none"]) console.log(`  ${line}`);
  }
});
