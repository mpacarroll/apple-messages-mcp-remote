import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as userInfo from "./fixtures/audio-user-info.ts";
import {
  appleTimestampToISO,
  extractAudioTranscript,
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

  // Builds a blob shaped like a real attributedBody: "NSString", the five
  // typedstream bytes that always follow it in chat.db, then the length in
  // typedstream integer encoding (one byte below 0x80, 0x81 + int16 LE,
  // 0x82 + int32 LE), then the UTF-8 bytes, then trailing attribute data.
  function attributedBody(text: string): Buffer {
    const textBuf = Buffer.from(text, "utf-8");
    let length: Buffer;
    if (textBuf.length < 0x80) {
      length = Buffer.from([textBuf.length]);
    } else if (textBuf.length <= 0x7fff) {
      length = Buffer.alloc(3);
      length[0] = 0x81;
      length.writeUInt16LE(textBuf.length, 1);
    } else {
      length = Buffer.alloc(5);
      length[0] = 0x82;
      length.writeUInt32LE(textBuf.length, 1);
    }
    return Buffer.concat([
      Buffer.from("streamtyped NSAttributedString "),
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
      length,
      textBuf,
      Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]),
    ]);
  }

  it("extracts a short message (single-byte length)", () => {
    assert.equal(extractTextFromAttributedBody(attributedBody("Hello, world!")), "Hello, world!");
  });

  it("extracts a 127-byte message, the largest single-byte length", () => {
    const text = "a".repeat(127);
    assert.equal(extractTextFromAttributedBody(attributedBody(text)), text);
  });

  it("extracts a 200-byte message (0x81 + 2-byte length)", () => {
    const text = "b".repeat(200);
    assert.equal(extractTextFromAttributedBody(attributedBody(text)), text);
  });

  it("does not cut off a 300-byte message", () => {
    // Regression: 0x81 was read as "one length byte follows", so this came
    // back as a stray 0x01 plus the first 43 characters.
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(7).slice(0, 300);
    assert.equal(extractTextFromAttributedBody(attributedBody(text)), text);
  });

  it("counts length in bytes, not characters, for multibyte text", () => {
    const text = "café 🙂 ".repeat(30);
    assert.ok(Buffer.byteLength(text) > 127 && text.length < Buffer.byteLength(text));
    assert.equal(extractTextFromAttributedBody(attributedBody(text)), text);
  });

  it("extracts a very long message (0x82 + 4-byte length)", () => {
    const text = "c".repeat(70_000);
    assert.equal(extractTextFromAttributedBody(attributedBody(text)), text);
  });
});

describe("extractAudioTranscript", () => {
  it("reads a transcript whose length is inline", () => {
    assert.equal(extractAudioTranscript(userInfo.INLINE_LENGTH), "Be right there");
  });

  it("returns only the transcript, never the other user_info keys", () => {
    const result = extractAudioTranscript(userInfo.WITH_SENSITIVE_KEYS);
    assert.equal(result, "Running ten minutes late");
  });

  it("reads a long transcript in full", () => {
    const result = extractAudioTranscript(userInfo.LONG_TRANSCRIPT);
    assert.equal(result?.length, 900);
    assert.ok(result?.startsWith("Long ascii transcript sentence."));
  });

  it("decodes UTF-16 text, including surrogate pairs", () => {
    assert.equal(
      extractAudioTranscript(userInfo.UNICODE),
      "On my way, café first 🙂 back soon — really"
    );
  });

  it("returns null when the message was not transcribed", () => {
    assert.equal(extractAudioTranscript(userInfo.NO_TRANSCRIPT), null);
  });

  it("returns null when the top-level object is not a dict", () => {
    assert.equal(extractAudioTranscript(userInfo.TOP_LEVEL_ARRAY), null);
  });

  it("returns null for null, empty, and non-plist input", () => {
    assert.equal(extractAudioTranscript(null), null);
    assert.equal(extractAudioTranscript(Buffer.alloc(0)), null);
    assert.equal(extractAudioTranscript(Buffer.from("not a plist at all, just text")), null);
  });

  it("returns null instead of throwing on truncated or corrupted data", () => {
    const full = userInfo.WITH_SENSITIVE_KEYS;
    for (const cut of [8, 40, full.length - 32, full.length - 1]) {
      assert.equal(extractAudioTranscript(full.subarray(0, cut)), null, `cut at ${cut}`);
    }
    const corrupted = Buffer.from(full);
    corrupted.fill(0xff, full.length - 32);
    assert.equal(extractAudioTranscript(corrupted), null);
  });
});

describe("getMessageText", () => {
  it("returns text when text is available", () => {
    assert.equal(getMessageText("hello", null), "hello");
  });

  it("falls back to blob when text is null", () => {
    const blob = Buffer.concat([
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
      Buffer.from([9]),
      Buffer.from("from blob", "utf-8"),
    ]);
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
        assert.equal(typeof msg.is_audio_message, "boolean");
      }
      for (const m of messages) {
        if (!m.is_audio_message) assert.equal(m.audio_transcript, null);
        else assert.ok(m.audio_transcript === null || typeof m.audio_transcript === "string");
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
