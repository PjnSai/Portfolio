import { describe, expect, it } from "vitest";
import {
  creationOptions,
  credentialJSON,
  fromBase64url,
  requestOptions,
  toBase64url,
} from "@/lib/admin/webauthn";

const bytes = (values: number[]) => new Uint8Array(values).buffer;

describe("base64url", () => {
  it("round-trips bytes without padding or unsafe characters", () => {
    const data = new Uint8Array([0, 255, 251, 239, 190, 62, 63, 1]);
    const text = toBase64url(data);

    expect(text).not.toMatch(/[+/=]/);
    expect(Array.from(new Uint8Array(fromBase64url(text)))).toEqual(
      Array.from(data),
    );
  });

  it("refuses text that is not base64url", () => {
    expect(() => fromBase64url("a+b/")).toThrow();
  });
});

describe("options from the API", () => {
  it("turns the challenge, user id and excluded ids into bytes", () => {
    const options = creationOptions({
      rp: { id: "localhost", name: "Portfolio admin" },
      user: { id: "YWRtaW4", name: "admin", displayName: "admin" },
      challenge: "AAEC",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ type: "public-key", id: "AQI" }],
      authenticatorSelection: { residentKey: "required" },
      attestation: "none",
      timeout: 60000,
    });

    expect(Array.from(new Uint8Array(options.challenge as ArrayBuffer))).toEqual(
      [0, 1, 2],
    );
    expect(new TextDecoder().decode(options.user.id as ArrayBuffer)).toBe(
      "admin",
    );
    expect(options.excludeCredentials?.[0].id).toBeInstanceOf(ArrayBuffer);
    expect(options.rp.id).toBe("localhost");
  });

  it("keeps sign-in options free of a credential list", () => {
    const options = requestOptions({
      challenge: "AAEC",
      rpId: "localhost",
      userVerification: "required",
      timeout: 60000,
    });

    expect(options.allowCredentials).toBeUndefined();
    expect(options.userVerification).toBe("required");
  });
});

describe("credential to JSON", () => {
  it("encodes every binary field of a sign-in for the API", () => {
    const json = credentialJSON({
      id: "AQI",
      rawId: bytes([1, 2]),
      type: "public-key",
      response: {
        clientDataJSON: bytes([3]),
        authenticatorData: bytes([4]),
        signature: bytes([5]),
        userHandle: null,
      },
    });

    expect(json).toEqual({
      id: "AQI",
      rawId: "AQI",
      type: "public-key",
      response: {
        clientDataJSON: "Aw",
        authenticatorData: "BA",
        signature: "BQ",
      },
    });
  });

  it("encodes an attestation for registration", () => {
    const json = credentialJSON({
      id: "AQI",
      rawId: bytes([1, 2]),
      type: "public-key",
      response: {
        clientDataJSON: bytes([3]),
        attestationObject: bytes([6]),
      },
    });

    expect(json.response).toEqual({
      clientDataJSON: "Aw",
      attestationObject: "Bg",
    });
  });
});
