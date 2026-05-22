import { HttpError, requireEnv } from "./http.ts";

type GoogleServiceAccount = {
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
};

const cachedAccessTokens = new Map<string, { token: string; expiresAt: number }>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64UrlEncode(value: string | Uint8Array): string {
  const base64 = typeof value === "string"
    ? btoa(value)
    : bytesToBase64(value);

  return base64
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function readServiceAccount(): GoogleServiceAccount {
  const rawServiceAccount = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!rawServiceAccount) {
    throw new HttpError(500, "GOOGLE_SERVICE_ACCOUNT_JSON is required");
  }

  let serviceAccount: GoogleServiceAccount;
  try {
    serviceAccount = JSON.parse(rawServiceAccount) as GoogleServiceAccount;
  } catch {
    throw new HttpError(500, "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new HttpError(500, "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }

  return serviceAccount;
}

async function signJwtWithServiceAccount(serviceAccount: GoogleServiceAccount, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claimSet = {
    iss: serviceAccount.client_email,
    scope,
    aud: serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const unsignedToken = `${encodedHeader}.${encodedClaimSet}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export function getGoogleServiceAccountProjectId(): string | null {
  const rawServiceAccount = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!rawServiceAccount) {
    return null;
  }

  try {
    const serviceAccount = JSON.parse(rawServiceAccount) as GoogleServiceAccount;
    return serviceAccount.project_id ?? null;
  } catch {
    throw new HttpError(500, "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
}

export async function getGoogleServiceAccountAccessToken(scope = "https://www.googleapis.com/auth/cloud-platform"): Promise<string | null> {
  if (!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const cachedAccessToken = cachedAccessTokens.get(scope);
  if (cachedAccessToken && cachedAccessToken.expiresAt - 300 > now) {
    return cachedAccessToken.token;
  }

  const serviceAccount = readServiceAccount();
  const tokenUri = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = await signJwtWithServiceAccount(serviceAccount, scope);
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await response.json();

  if (!response.ok) {
    throw new HttpError(response.status, "Google service account token request failed", body);
  }

  if (!body.access_token) {
    throw new HttpError(502, "Google service account token response is missing access_token", body);
  }

  cachedAccessTokens.set(scope, {
    token: body.access_token,
    expiresAt: now + Number(body.expires_in ?? 3600),
  });

  return body.access_token;
}

export async function imageBlobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(bytes);
}

export type GoogleOcrResult = {
  text: string;
  confidence: number | null;
  raw: unknown;
};

export async function runGoogleOcr(imageBase64: string): Promise<GoogleOcrResult> {
  const featureType = Deno.env.get("GOOGLE_VISION_FEATURE") ?? "DOCUMENT_TEXT_DETECTION";
  const accessToken = await getGoogleServiceAccountAccessToken();
  const apiKey = accessToken ? null : requireEnv("GOOGLE_VISION_API_KEY");
  const url = accessToken
    ? "https://vision.googleapis.com/v1/images:annotate"
    : `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      requests: [
        {
          image: { content: imageBase64 },
          features: [{ type: featureType }],
          imageContext: {
            languageHints: ["ko", "en"],
          },
        },
      ],
    }),
  });

  const body = await response.json();

  if (!response.ok) {
    throw new HttpError(response.status, "Google Vision OCR request failed", body);
  }

  const first = body.responses?.[0];
  if (first?.error) {
    throw new HttpError(502, "Google Vision OCR returned an error", first.error);
  }

  const text = first?.fullTextAnnotation?.text ?? first?.textAnnotations?.[0]?.description ?? "";
  const pages = first?.fullTextAnnotation?.pages ?? [];
  const confidences = pages
    .flatMap((page: { blocks?: Array<{ confidence?: number }> }) => page.blocks ?? [])
    .map((block: { confidence?: number }) => block.confidence)
    .filter((value: unknown): value is number => typeof value === "number");

  const confidence = confidences.length > 0
    ? confidences.reduce((sum: number, value: number) => sum + value, 0) / confidences.length
    : null;

  return {
    text,
    confidence,
    raw: body,
  };
}
