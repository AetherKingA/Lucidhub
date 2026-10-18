// Request signing between the hub and game sites (both directions). See INTEGRATION.md.
//   X-Hub-Timestamp: epoch ms
//   X-Hub-Signature: hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)   (rawBody is "" for GET)

import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_MS = 5 * 60_000;

export function sign(secret: string, body: string, now = Date.now()) {
  const timestamp = String(now);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { "X-Hub-Timestamp": timestamp, "X-Hub-Signature": signature };
}

export function verify(secret: string, body: string, timestamp: string | undefined, signature: string | undefined, now = Date.now()) {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
