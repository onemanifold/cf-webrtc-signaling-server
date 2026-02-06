import { describe, expect, it } from "vitest";
import { parseBearerToken, signJoinToken, verifyJoinToken } from "../src/join-token";

describe("join token", () => {
  it("signs and verifies token", async () => {
    const secret = "test-secret";
    const now = Math.floor(Date.now() / 1_000);
    const token = await signJoinToken(
      {
        sub: "user-1",
        room: "room-1",
        name: "alice",
        exp: now + 60,
        iat: now,
      },
      secret,
    );

    const payload = await verifyJoinToken(token, secret, {
      expectedRoom: "room-1",
      nowEpochSeconds: now,
    });

    expect(payload.sub).toBe("user-1");
    expect(payload.room).toBe("room-1");
    expect(payload.name).toBe("alice");
  });

  it("rejects invalid signature", async () => {
    const secret = "test-secret";
    const now = Math.floor(Date.now() / 1_000);
    const token = await signJoinToken(
      {
        sub: "user-1",
        room: "room-1",
        exp: now + 60,
      },
      secret,
    );

    await expect(verifyJoinToken(token, "wrong-secret", { nowEpochSeconds: now })).rejects.toThrow(
      "Invalid signature",
    );
  });

  it("parses bearer token", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer xyz")).toBe("xyz");
    expect(parseBearerToken("token xyz")).toBeNull();
    expect(parseBearerToken(null)).toBeNull();
  });
});
