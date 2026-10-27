import { describe, expect, it } from "vitest";

import { parseServerMessage } from "@/lib/collaboration/protocol";

describe("authoritative access-role protocol", () => {
  it.each(["owner", "editor", "viewer"])("accepts only the server role enum: %s", (role) => {
    expect(parseServerMessage(JSON.stringify({ type: "access-role", role }))).toEqual({ type: "access-role", role });
  });

  it.each([null, true, 0, "", "admin", "OWNER", ["editor"], { role: "editor" }])("rejects invalid roles: %j", (role) => {
    expect(parseServerMessage(JSON.stringify({ type: "access-role", role }))).toBeNull();
  });

  it("rejects extra or missing authority fields", () => {
    expect(parseServerMessage('{"type":"access-role"}')).toBeNull();
    expect(parseServerMessage('{"type":"access-role","role":"editor","canManage":true}')).toBeNull();
    expect(parseServerMessage('{"type":"access-role","role":"owner","__proto__":{}}')).toBeNull();
  });
});
