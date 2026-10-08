// searchMessages against a small synthetic chat.db, so it runs anywhere.
// database.ts resolves chat.db from HOME when it loads, so HOME is pointed
// at a temp directory before the dynamic import. The test runner gives each
// file its own process, so this doesn't affect the other test files.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shaped like a real attributedBody: class names with NUL bytes before the
// text, attribute names after it.
function attributedBody(text: string): Buffer {
  const t = Buffer.from(text, "utf-8");
  return Buffer.concat([
    Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"),
    Buffer.from([t.length]),
    t,
    Buffer.from("\x86\x84\x02iI\x01\x10\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x01\x92\x84\x96\x96\x1d__kIMMessagePartAttributeName\x86\x92\x84\x84\x84\x08NSNumber\x00\x86\x86", "latin1"),
  ]);
}

const CHAT_A = "iMessage;-;+15550000001";
const CHAT_B = "iMessage;-;+15550000002";
let home: string;
let searchMessages: typeof import("../src/database.ts").searchMessages;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "messages-search-"));
  mkdirSync(join(home, "Library", "Messages"), { recursive: true });
  const db = new DatabaseSync(join(home, "Library", "Messages", "chat.db"));
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER,
      is_audio_message INTEGER, date INTEGER, service TEXT, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, user_info BLOB);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO chat VALUES (1, '${CHAT_A}', NULL), (2, '${CHAT_B}', NULL);
    INSERT INTO handle VALUES (1, '+15550000001', 'iMessage');`);
  const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, 0, 0, ?, 'iMessage', 1)");
  insert.run(1, null, attributedBody("Dinner at seven? Bring 100% of the snacks"), 800000003000000000n);
  insert.run(2, "dinner plans changed", attributedBody("dinner plans changed"), 800000002000000000n);
  insert.run(3, null, attributedBody("See you soon"), 800000001000000000n);
  insert.run(4, "", attributedBody("Empty text column, dinner only in the body"), 800000000000000000n);
  db.exec("INSERT INTO chat_message_join VALUES (1, 1), (1, 2), (1, 3), (2, 4);");
  db.close();

  process.env.HOME = home;
  ({ searchMessages } = await import("../src/database.ts"));
});

after(() => rmSync(home, { recursive: true, force: true }));

const ids = (query: string, chatId?: string) => searchMessages(query, chatId).map((r) => r.rowid).sort();

describe("searchMessages", () => {
  it("finds text that exists only in attributedBody", () => {
    // Regression: LIKE on the blob stopped at its first NUL byte, so only
    // message 2, which has a text column, was found.
    assert.deepEqual(ids("dinner"), [1, 2, 4]);
  });

  it("is case-insensitive and respects the chat filter", () => {
    assert.deepEqual(ids("DINNER", CHAT_A), [1, 2]);
  });

  it("does not match attributedBody class or attribute names", () => {
    assert.deepEqual(ids("name"), []);
    assert.deepEqual(ids("NSString"), []);
  });

  it("treats % and _ in the query literally", () => {
    assert.deepEqual(ids("100%"), [1]);
    assert.deepEqual(ids("0 %"), []);
    assert.deepEqual(ids("_"), []);
  });

  it("returns decoded text, newest first", () => {
    const results = searchMessages("dinner");
    assert.deepEqual(results.map((r) => r.rowid), [1, 2, 4]);
    assert.equal(results[0].text, "Dinner at seven? Bring 100% of the snacks");
  });
});
