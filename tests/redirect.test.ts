import test from "node:test";
import assert from "node:assert/strict";
import { authRedirect, safeRedirect } from "../src/lib/redirect";
test("auth redirects retain local booking paths and reject external or normalized external URLs", () => {
  assert.equal(
    safeRedirect("/book?court=2&date=2026-10-24"),
    "/book?court=2&date=2026-10-24",
  );
  assert.equal(safeRedirect("/login?recovery=true"), "/login?recovery=true");
  for (const value of [
    undefined,
    null,
    ["/admin", "/book"],
    42,
    "https://example.com",
    "//example.com",
    "/book/..//example.com",
    "/\\example.com",
    "/\n/example.com",
    "/\t/example.com",
    "javascript:alert(1)",
  ])
    assert.equal(safeRedirect(value), "/my-bookings");
});

test("staff land on the dashboard and customers land on their bookings by default", () => {
  for (const value of [undefined, null, "", "https://example.com", ["/book"]]) {
    assert.equal(authRedirect(value, true), "/staff");
    assert.equal(authRedirect(value, false), "/my-bookings");
  }
});

test("sign-in return links preserve bookings, staff pages, and password recovery", () => {
  for (const value of [
    "/book?court=2&date=2026-10-24",
    "/booking/00000000-0000-4000-a000-000000000001",
    "/admin/settings",
    "/my-bookings",
    "/login?recovery=true",
  ]) {
    assert.equal(authRedirect(value, true), value);
    assert.equal(authRedirect(value, false), value);
  }
});
