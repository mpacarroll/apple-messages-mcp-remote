import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
// http-transport.ts has a local sibling import ("./server.js"), which only
// resolves against the compiled build (tsconfig targets Node16 module
// resolution, so source imports use .js extensions that only exist after
// tsc runs). database.test.ts can import src/database.ts directly because
// database.ts has no local imports of its own; this one can't, so it tests
// the build output instead. `npm run build` runs before this via the test
// and test:clean scripts.
import { isAuthorized, isAllowedHost } from "../build/http-transport.js";

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("isAuthorized", () => {
  const token = "a".repeat(32);

  it("accepts the correct bearer token", () => {
    assert.equal(isAuthorized(fakeReq({ authorization: `Bearer ${token}` }), token), true);
  });

  it("rejects a missing header", () => {
    assert.equal(isAuthorized(fakeReq({}), token), false);
  });

  it("rejects a non-bearer scheme", () => {
    assert.equal(isAuthorized(fakeReq({ authorization: `Basic ${token}` }), token), false);
  });

  it("rejects a wrong token of the same length", () => {
    assert.equal(isAuthorized(fakeReq({ authorization: `Bearer ${"b".repeat(32)}` }), token), false);
  });

  it("rejects a wrong token of a different length", () => {
    assert.equal(isAuthorized(fakeReq({ authorization: "Bearer short" }), token), false);
  });
});

describe("isAllowedHost", () => {
  const publicHost = "messages.example.com";

  it("accepts an exact match", () => {
    assert.equal(isAllowedHost(fakeReq({ host: publicHost }), publicHost), true);
  });

  it("accepts a match regardless of the request's letter case", () => {
    assert.equal(isAllowedHost(fakeReq({ host: publicHost.toUpperCase() }), publicHost), true);
  });

  it("strips a port suffix before comparing", () => {
    assert.equal(isAllowedHost(fakeReq({ host: `${publicHost}:443` }), publicHost), true);
  });

  it("rejects a different host, the DNS-rebinding case", () => {
    assert.equal(isAllowedHost(fakeReq({ host: "attacker.example.com" }), publicHost), false);
  });

  it("rejects a missing Host header", () => {
    assert.equal(isAllowedHost(fakeReq({}), publicHost), false);
  });
});
