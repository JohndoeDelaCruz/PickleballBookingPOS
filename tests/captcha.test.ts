import test from "node:test";
import assert from "node:assert/strict";
import {
  captchaOptions,
  defaultTurnstileSiteKey,
  resolveTurnstileSiteKey,
} from "../src/lib/captcha";

test("authentication token options reject missing, blank, and oversized tokens", () => {
  for (const value of [undefined, null, "", " \n", 123, {}, "x".repeat(2049)])
    assert.throws(() => captchaOptions(value));
  assert.deepEqual(captchaOptions(" issued-token "), {
    captchaToken: "issued-token",
  });
  assert.equal(captchaOptions("x".repeat(2048)).captchaToken.length, 2048);
});

test("production uses the configured public widget key and refuses Cloudflare test keys", () => {
  assert.equal(resolveTurnstileSiteKey(), defaultTurnstileSiteKey);
  assert.equal(resolveTurnstileSiteKey(" ", true), defaultTurnstileSiteKey);
  assert.equal(
    resolveTurnstileSiteKey(" 0x-production-key ", true),
    "0x-production-key",
  );
  for (const key of [
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
    "1x00000000000000000000BB",
    "2x00000000000000000000BB",
    "3x00000000000000000000FF",
  ]) {
    assert.equal(resolveTurnstileSiteKey(key, true), null);
    assert.equal(resolveTurnstileSiteKey(key, false), key);
  }
});
