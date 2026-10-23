import * as v1 from "./protocol.js";
import * as v2 from "./protocol-v2.js";

export type ProtocolMode = "v1" | "v2";
export type DeliveryClaim = v1.Claim | v2.Claim;
export type DeliverySession = v1.Session | v2.Session;
export type DeliveryAck = v1.Ack | v2.Ack;
export function protocol(mode: ProtocolMode) {
  if (mode !== "v1" && mode !== "v2") throw new Error("invalid_protocol_mode");
  return mode === "v1" ? v1 : v2;
}
export function decodeDelivery(
  claim: DeliveryClaim,
  includeVerificationUrl = false,
) {
  switch (claim.version) {
    case v1.VERSION:
      return v1.decodePayload(claim);
    case v2.VERSION:
      return v2.decodePayload(claim, includeVerificationUrl);
  }
}
