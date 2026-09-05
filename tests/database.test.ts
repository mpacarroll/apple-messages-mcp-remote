import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appleTimestampToISO,
  extractTextFromAttributedBody,
  getMessageText,
  listChats,
  getChatMessages,
  searchMessages,
  getChatParticipants,
} from "../src/database.ts";

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("appleTimestampToISO", () => {
  it("converts a known timestamp correctly", () => {
    // 2024-01-15 12:00:00 UTC
    // Unix timestamp: 1705320000
    // Apple seconds: 1705320000 - 978307200 = 727012800
    // Apple nanoseconds: 727012800 * 1e9 = 727012800000000000
    const result = appleTimestampToISO(727012800000000000);
    assert.equal(result, "2024-01-15T12:00:00.000Z");
  });

  it("returns null for null input", () => {
    assert.equal(appleTimestampToISO(null), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(appleTimestampToISO(undefined), null);
  });

  it("returns null for zero", () => {
    assert.equal(appleTimestampToISO(0), null);
  });

  it("converts Apple epoch (1 second) to 2001-01-01T00:00:01", () => {
    const result = appleTimestampToISO(1000000000); // 1 second in nanoseconds
    assert.equal(result, "2001-01-01T00:00:01.000Z");
  });
});

describe("extractTextFromAttributedBody", () => {
  it("returns null for null input", () => {
    assert.equal(extractTextFromAttributedBody(null), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(extractTextFromAttributedBody(undefined), null);
  });

  it("returns null for empty buffer", () => {
    assert.equal(extractTextFromAttributedBody(Buffer.alloc(0)), null);
  });

  it("returns null for buffer without NSString marker", () => {
    assert.equal(extractTextFromAttributedBody(Buffer.from("random data without marker")), null);
  });

  it("extracts text from a synthetic blob with short length", () => {
    const prefix = Buffer.from("some prefix data ");
    const marker = Buffer.from("NSString");
    const overhead = Buffer.alloc(5, 0);
    const text = "Hello, world!";
    const lengthByte = Buffer.from([text.length]);
    const textBuf = Buffer.from(text, "utf-8");

    const blob = Buffer.concat([prefix, marker, overhead, lengthByte, textBuf]);
    assert.equal(extractTextFromAttributedBody(blob), "Hello, world!");
  });

  it("extracts text from a synthetic blob with extended length", () => {
    const prefix = Buffer.from("prefix ");
    const marker = Buffer.from("NSString");
    const overhead = Buffer.alloc(5, 0);
    const text = "A".repeat(200);
    // Extended length: 0x82 means (0x80 | 0x02) = 2 length bytes follow
    const lengthIndicator = Buffer.from([0x82]);
    // 200 in little-endian 2 bytes: 0xC8, 0x00
    const lengthBytes = Buffer.from([0xc8, 0x00]);
    const textBuf = Buffer.from(text, "utf-8");

    const blob = Buffer.concat([prefix, marker, overhead, lengthIndicator, lengthBytes, textBuf]);
    assert.equal(extractTextFromAttributedBody(blob), text);
  });
});

describe("getMessageText", () => {
  it("returns text when text is available", () => {
    assert.equal(getMessageText("hello", null), "hello");
  });

  it("falls back to blob when text is null", () => {
    const prefix = Buffer.from("prefix ");
    const marker = Buffer.from("NSString");
    const overhead = Buffer.alloc(5, 0);
    const text = "from blob";
    const lengthByte = Buffer.from([text.length]);
    const textBuf = Buffer.from(text, "utf-8");
    const blob = Buffer.concat([prefix, marker, overhead, lengthByte, textBuf]);

    assert.equal(getMessageText(null, blob), "from blob");
  });

  it("returns null when both are null", () => {
    assert.equal(getMessageText(null, null), null);
  });
});

// ---------------------------------------------------------------------------
// Integration tests (read-only against real chat.db)
// ---------------------------------------------------------------------------

describe("listChats (integration)", () => {
  it("returns an array", () => {
    const chats = listChats(5);
    assert.ok(Array.isArray(chats));
  });

  it("respects limit", () => {
    const chats = listChats(3);
    assert.ok(chats.length <= 3);
  });

  it("chats have correct shape", () => {
    const chats = listChats(1);
    if (chats.length > 0) {
      const chat = chats[0];
      assert.ok("chat_id" in chat);
      assert.ok("display_name" in chat);
      assert.ok("last_message_date" in chat);
      assert.ok("last_message_text" in chat);
      assert.equal(typeof chat.chat_id, "string");
    }
  });
});

describe("getChatMessages (integration)", () => {
  it("returns messages for a valid chat", () => {
    const chats = listChats(1);
    if (chats.length > 0) {
      const messages = getChatMessages(chats[0].chat_id, 5);
      assert.ok(Array.isArray(messages));
      if (messages.length > 0) {
        const msg = messages[0];
        assert.ok("rowid" in msg);
        assert.ok("text" in msg);
        assert.ok("is_from_me" in msg);
        assert.ok("date" in msg);
        assert.ok("sender" in msg);
        assert.ok("service" in msg);
        assert.equal(typeof msg.is_from_me, "boolean");
      }
    }
  });

  it("returns empty array for non-existent chat", () => {
    const messages = getChatMessages("nonexistent-chat-id-12345", 5);
    assert.deepEqual(messages, []);
  });
});

describe("searchMessages (integration)", () => {
  it("returns an array", () => {
    const results = searchMessages("the", undefined, 5);
    assert.ok(Array.isArray(results));
  });

  it("respects chat_id scope", () => {
    const chats = listChats(1);
    if (chats.length > 0) {
      const results = searchMessages("a", chats[0].chat_id, 5);
      assert.ok(Array.isArray(results));
      for (const r of results) {
        assert.equal(r.chat_id, chats[0].chat_id);
      }
    }
  });
});

describe("getChatParticipants (integration)", () => {
  it("returns participants for a valid chat", () => {
    const chats = listChats(1);
    if (chats.length > 0) {
      const participants = getChatParticipants(chats[0].chat_id);
      assert.ok(Array.isArray(participants));
      if (participants.length > 0) {
        assert.ok("handle_id" in participants[0]);
        assert.ok("service" in participants[0]);
      }
    }
  });

  it("returns empty array for non-existent chat", () => {
    const participants = getChatParticipants("nonexistent-chat-id-12345");
    assert.deepEqual(participants, []);
  });
});
