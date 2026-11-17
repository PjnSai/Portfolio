// Passkeys in the browser. The API sends WebAuthn options as JSON with binary
// fields in base64url; the browser wants ArrayBuffers, and back again.

type Json = Record<string, unknown>;
type Descriptor = { type: "public-key"; id: string; transports?: string[] };

export function toBase64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error("Not base64url.");
  }
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return (list as Descriptor[]).map((item) => ({
    type: "public-key",
    id: fromBase64url(item.id),
    transports: item.transports as AuthenticatorTransport[] | undefined,
  }));
}

export function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as { id: string; name: string; displayName: string };
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromBase64url(json.challenge as string),
    user: { ...user, id: fromBase64url(user.id) },
    excludeCredentials: descriptors(json.excludeCredentials),
  };
}

export function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  const options: PublicKeyCredentialRequestOptions = {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromBase64url(json.challenge as string),
  };
  const allowed = descriptors(json.allowCredentials);
  if (allowed) options.allowCredentials = allowed;
  else delete options.allowCredentials;
  return options;
}

type CredentialLike = {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  response: Record<string, ArrayBuffer | null | unknown>;
};

const BINARY_FIELDS = [
  "clientDataJSON",
  "attestationObject",
  "authenticatorData",
  "signature",
  "userHandle",
];

export function credentialJSON(credential: CredentialLike) {
  const response: Record<string, string> = {};
  for (const field of BINARY_FIELDS) {
    const value = credential.response[field];
    if (value instanceof ArrayBuffer) response[field] = toBase64url(value);
  }
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response,
  };
}

function unsupported(): Error {
  return new Error("This browser cannot use passkeys.");
}

export async function createPasskey(options: Json) {
  if (!window.PublicKeyCredential) throw unsupported();
  const credential = (await navigator.credentials.create({
    publicKey: creationOptions(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  return credentialJSON(credential as unknown as CredentialLike);
}

export async function signWithPasskey(options: Json) {
  if (!window.PublicKeyCredential) throw unsupported();
  const credential = (await navigator.credentials.get({
    publicKey: requestOptions(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was chosen.");
  return credentialJSON(credential as unknown as CredentialLike);
}
