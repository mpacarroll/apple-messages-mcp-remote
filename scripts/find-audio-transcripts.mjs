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
