import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

// Apple's epoch: 2001-01-01 00:00:00 UTC
// Offset from Unix epoch (1970-01-01) in seconds
const APPLE_EPOCH_OFFSET = 978307200;

// SQL expression to convert Apple nanosecond timestamps to ISO strings.
// Apple timestamps in chat.db are nanoseconds since 2001-01-01 and exceed
// Number.MAX_SAFE_INTEGER, so we must convert in SQL to avoid BigInt errors.
const DATE_SQL = (col: string) =>
  `datetime(${col} / 1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch')`;

/**
 * Convert an Apple Core Data timestamp (nanoseconds since 2001-01-01) to an ISO string.
 * For use with values that are already safe JavaScript numbers (e.g. in unit tests).
 * Returns null for null/zero/undefined timestamps.
 */
export function appleTimestampToISO(timestamp: number | null | undefined): string | null {
  if (timestamp == null || timestamp === 0) return null;
  const unixSeconds = timestamp / 1e9 + APPLE_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Extract plain text from an NSAttributedString binary blob (attributedBody column).
 *
 * The blob is an NSArchiver typedstream. The plain text follows an "NSString"
 * marker as a length-prefixed UTF-8 string, with the length (in bytes) in
 * typedstream integer encoding: a single byte below 0x80, or the tag 0x81
 * followed by an int16, or 0x82 followed by an int32, both little-endian.
 */
export function extractTextFromAttributedBody(blob: Buffer | Uint8Array | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;

  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const marker = Buffer.from("NSString");
  let idx = buf.indexOf(marker);
  if (idx === -1) return null;

  // Skip past the marker and some overhead bytes
  // The pattern is: ...NSString...{type indicator byte}{length}{UTF-8 text}
  // We need to find the length-prefixed text after the marker.
  // Typically there are 5 bytes between "NSString" and the start of the length prefix:
  //   marker(8 bytes) + overhead(5 bytes) + length + text
  idx += marker.length + 5;
  if (idx >= buf.length) return null;

  const lengthByte = buf[idx];
  let textLength: number;
  let textStart: number;

  if (lengthByte < 0x80) {
    textLength = lengthByte;
    textStart = idx + 1;
  } else if (lengthByte === 0x81 && idx + 3 <= buf.length) {
    textLength = buf.readUInt16LE(idx + 1);
    textStart = idx + 3;
  } else if (lengthByte === 0x82 && idx + 5 <= buf.length) {
    textLength = buf.readUInt32LE(idx + 1);
    textStart = idx + 5;
  } else {
    return null;
  }

  if (textStart + textLength > buf.length) {
    // Fallback: return whatever we can
    textLength = buf.length - textStart;
  }
  if (textLength <= 0) return null;

  return buf.subarray(textStart, textStart + textLength).toString("utf-8");
}

/**
 * Read a voice message's transcript from its audio attachment's user_info,
 * a binary plist dict that keeps it under "audio-transcription". Only that
 * key is read: the same dict holds the attachment's decryption key and
 * download URL, which must never be returned. Malformed input yields null.
 */
export function extractAudioTranscript(userInfo: Buffer | Uint8Array | null | undefined): string | null {
  if (!userInfo || userInfo.length === 0) return null;
  const buf = Buffer.isBuffer(userInfo) ? userInfo : Buffer.from(userInfo);
  try {
    return readBinaryPlistDictString(buf, "audio-transcription");
  } catch {
    return null;
  }
}

// Minimal reader for Apple's bplist00 format: enough to look up one string
// value in a top-level dict. Every offset is bounds-checked; anything that
// doesn't fit the format throws and the caller turns it into null.
function readBinaryPlistDictString(buf: Buffer, wanted: string): string | null {
  const TRAILER = 32;
  if (buf.length < 8 + TRAILER || buf.toString("latin1", 0, 8) !== "bplist00") return null;

  const t = buf.length - TRAILER;
  const offsetSize = buf[t + 6];
  const refSize = buf[t + 7];
  const numObjects = Number(buf.readBigUInt64BE(t + 8));
  const topObject = Number(buf.readBigUInt64BE(t + 16));
  const offsetTable = Number(buf.readBigUInt64BE(t + 24));
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) return null;
  if (topObject >= numObjects || offsetTable + numObjects * offsetSize > t) return null;

  const uint = (at: number, size: number): number => {
    if (at < 0 || at + size > t) throw new RangeError("out of bounds");
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + buf[at + i];
    return value;
  };
  const objectAt = (ref: number): number => {
    if (ref >= numObjects) throw new RangeError("bad object ref");
    const at = uint(offsetTable + ref * offsetSize, offsetSize);
    if (at < 8 || at >= offsetTable) throw new RangeError("bad object offset");
    return at;
  };
  // Low nibble 0xF means the count follows as its own integer object.
  const countAt = (at: number): [count: number, start: number] => {
    const nibble = buf[at] & 0x0f;
    if (nibble !== 0x0f) return [nibble, at + 1];
    const marker = buf[at + 1];
    if ((marker & 0xf0) !== 0x10) throw new RangeError("bad count");
    const size = 1 << (marker & 0x0f);
    return [uint(at + 2, size), at + 2 + size];
  };
  const stringAt = (ref: number): string | null => {
    const at = objectAt(ref);
    const type = buf[at] & 0xf0;
    if (type !== 0x50 && type !== 0x60) return null;
    const [count, start] = countAt(at);
    const bytes = type === 0x50 ? count : count * 2;
    if (start + bytes > offsetTable) throw new RangeError("string out of bounds");
    if (type === 0x50) return buf.toString("latin1", start, start + bytes);
    // 0x60 is UTF-16 big-endian; Node only decodes little-endian.
    return Buffer.from(buf.subarray(start, start + bytes)).swap16().toString("utf16le");
  };

  const top = objectAt(topObject);
  if ((buf[top] & 0xf0) !== 0xd0) return null;
  const [entries, refs] = countAt(top);
  if (refs + entries * 2 * refSize > offsetTable) return null;
  for (let i = 0; i < entries; i++) {
    if (stringAt(uint(refs + i * refSize, refSize)) === wanted) {
      return stringAt(uint(refs + (entries + i) * refSize, refSize));
    }
  }
  return null;
}

/**
 * Get the message text, preferring the text column and falling back to attributedBody blob parsing.
 */
export function getMessageText(text: string | null, attributedBody: Buffer | Uint8Array | null): string | null {
  if (text) return text;
  return extractTextFromAttributedBody(attributedBody);
}

/**
 * Open chat.db in read-only mode and return the database handle.
 */
export function openDb(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

export interface Chat {
  chat_id: string;
  display_name: string | null;
  last_message_date: string | null;
  last_message_text: string | null;
}

/**
 * List recent chats with last message preview.
 */
export function listChats(limit: number = 50): Chat[] {
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT
        c.chat_identifier as chat_id,
        c.display_name,
        ${DATE_SQL("m.date")} as last_message_date,
        m.text,
        m.attributedBody
      FROM chat c
      LEFT JOIN (
        SELECT
          cmj.chat_id,
          m.date,
          m.text,
          m.attributedBody,
          ROW_NUMBER() OVER (PARTITION BY cmj.chat_id ORDER BY m.date DESC) as rn
        FROM chat_message_join cmj
        JOIN message m ON m.ROWID = cmj.message_id
      ) m ON m.chat_id = c.ROWID AND m.rn = 1
      ORDER BY m.date DESC NULLS LAST
      LIMIT ?
    `).all(limit) as Array<{
      chat_id: string;
      display_name: string | null;
      last_message_date: string | null;
      text: string | null;
      attributedBody: Buffer | null;
    }>;

    return rows.map((row) => ({
      chat_id: row.chat_id,
      display_name: row.display_name || null,
      last_message_date: row.last_message_date,
      last_message_text: getMessageText(row.text, row.attributedBody),
    }));
  } finally {
    db.close();
  }
}

export interface Message {
  rowid: number;
  text: string | null;
  is_from_me: boolean;
  is_audio_message: boolean;
  audio_transcript: string | null;
  date: string | null;
  sender: string | null;
  service: string | null;
}

/**
 * Get messages for a specific chat, ordered by date descending.
 * Optionally filter by date range (ISO 8601 strings like '2025-01-01' or '2025-03-15T14:00:00').
 */
export function getChatMessages(chatId: string, limit: number = 100, fromDate?: string, toDate?: string): Message[] {
  const db = openDb();
  try {
    let dateFilter = "";
    const params: (string | number)[] = [chatId];

    if (fromDate) {
      // Convert ISO date to Apple timestamp (nanoseconds since 2001-01-01)
      const fromUnix = new Date(fromDate).getTime() / 1000;
      const fromApple = (fromUnix - APPLE_EPOCH_OFFSET) * 1e9;
      dateFilter += " AND m.date >= ?";
      params.push(fromApple);
    }
    if (toDate) {
      const toUnix = new Date(toDate).getTime() / 1000;
      const toApple = (toUnix - APPLE_EPOCH_OFFSET) * 1e9;
      dateFilter += " AND m.date <= ?";
      params.push(toApple);
    }

    params.push(limit);

    const rows = db.prepare(`
      SELECT
        m.ROWID as rowid,
        m.text,
        m.attributedBody,
        m.is_from_me,
        m.is_audio_message,
        CASE WHEN m.is_audio_message = 1 THEN (
          SELECT a.user_info FROM message_attachment_join maj
          JOIN attachment a ON a.ROWID = maj.attachment_id
          WHERE maj.message_id = m.ROWID AND a.user_info IS NOT NULL
          LIMIT 1
        ) END as audio_user_info,
        ${DATE_SQL("m.date")} as date,
        m.service,
        h.id as sender
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE c.chat_identifier = ?${dateFilter}
      ORDER BY m.date DESC
      LIMIT ?
    `).all(...params) as Array<{
      rowid: number;
      text: string | null;
      attributedBody: Buffer | null;
      is_from_me: number;
      is_audio_message: number;
      audio_user_info: Uint8Array | null;
      date: string | null;
      service: string | null;
      sender: string | null;
    }>;

    return rows.map((row) => ({
      rowid: row.rowid,
      text: getMessageText(row.text, row.attributedBody),
      is_from_me: row.is_from_me === 1,
      is_audio_message: row.is_audio_message === 1,
      audio_transcript: extractAudioTranscript(row.audio_user_info),
      date: row.date,
      sender: row.sender,
      service: row.service,
    }));
  } finally {
    db.close();
  }
}

export interface SearchResult {
  rowid: number;
  text: string | null;
  is_from_me: boolean;
  is_audio_message: boolean;
  audio_transcript: string | null;
  date: string | null;
  sender: string | null;
  chat_id: string;
}

/**
 * Search messages by text content using LIKE.
 */
export function searchMessages(query: string, chatId?: string, limit: number = 50): SearchResult[] {
  const db = openDb();
  try {
    const likePattern = `%${query}%`;
    let sql: string;
    let params: (string | number)[];

    if (chatId) {
      sql = `
        SELECT
          m.ROWID as rowid,
          m.text,
          m.attributedBody,
          m.is_from_me,
          m.is_audio_message,
          CASE WHEN m.is_audio_message = 1 THEN (
            SELECT a.user_info FROM message_attachment_join maj
            JOIN attachment a ON a.ROWID = maj.attachment_id
            WHERE maj.message_id = m.ROWID AND a.user_info IS NOT NULL
            LIMIT 1
          ) END as audio_user_info,
          ${DATE_SQL("m.date")} as date,
          h.id as sender,
          c.chat_identifier as chat_id
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE c.chat_identifier = ?
          AND (m.text LIKE ? OR m.attributedBody LIKE ?)
        ORDER BY m.date DESC
        LIMIT ?
      `;
      params = [chatId, likePattern, likePattern, limit];
    } else {
      sql = `
        SELECT
          m.ROWID as rowid,
          m.text,
          m.attributedBody,
          m.is_from_me,
          m.is_audio_message,
          CASE WHEN m.is_audio_message = 1 THEN (
            SELECT a.user_info FROM message_attachment_join maj
            JOIN attachment a ON a.ROWID = maj.attachment_id
            WHERE maj.message_id = m.ROWID AND a.user_info IS NOT NULL
            LIMIT 1
          ) END as audio_user_info,
          ${DATE_SQL("m.date")} as date,
          h.id as sender,
          c.chat_identifier as chat_id
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.text LIKE ? OR m.attributedBody LIKE ?
        ORDER BY m.date DESC
        LIMIT ?
      `;
      params = [likePattern, likePattern, limit];
    }

    const rows = db.prepare(sql).all(...params) as Array<{
      rowid: number;
      text: string | null;
      attributedBody: Buffer | null;
      is_from_me: number;
      is_audio_message: number;
      audio_user_info: Uint8Array | null;
      date: string | null;
      sender: string | null;
      chat_id: string;
    }>;

    return rows.map((row) => ({
      rowid: row.rowid,
      text: getMessageText(row.text, row.attributedBody),
      is_from_me: row.is_from_me === 1,
      is_audio_message: row.is_audio_message === 1,
      audio_transcript: extractAudioTranscript(row.audio_user_info),
      date: row.date,
      sender: row.sender,
      chat_id: row.chat_id,
    }));
  } finally {
    db.close();
  }
}

export interface Participant {
  handle_id: string;
  service: string | null;
}

/**
 * Get participants of a chat.
 */
export function getChatParticipants(chatId: string): Participant[] {
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT
        h.id as handle_id,
        h.service
      FROM handle h
      JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
      JOIN chat c ON c.ROWID = chj.chat_id
      WHERE c.chat_identifier = ?
    `).all(chatId) as Array<{
      handle_id: string;
      service: string | null;
    }>;

    return rows;
  } finally {
    db.close();
  }
}
