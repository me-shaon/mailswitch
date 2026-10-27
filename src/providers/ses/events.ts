// SES events through SNS. The SNS `Message` field holds the SES event JSON, from event
// publishing (`eventType`) or from identity notifications (`notificationType`).
// https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html
// https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html
//
// One SES event can name several recipients, so it gives one event per recipient. The
// event key is the SNS MessageId, which SNS keeps across retries. The second and later
// recipients of one message add `:<index>`.

import type { BounceDetail, NormalizedEvent, NormalizedEventType } from "../../core/events";
import { bounceDetail } from "../../internal/bounce-detail";
import { sesMeta } from "./meta";
import { isSnsSubscribeUrl, parseSnsMessage, parseTopicArn } from "./sns-verify";

/** The action that an SNS `SubscriptionConfirmation` asks for. mailswitch never fetches it. */
export interface SnsConfirmAction {
  type: "confirm_subscription";
  /** The topic that asks for the subscription. It is on the allowlist. */
  topicArn: string;
  /** Fetch this URL with GET to confirm the subscription. It is an SNS host of the topic region. */
  subscribeUrl: string;
}

/** A normalized SES event. A `SubscriptionConfirmation` event carries `action`. */
export interface SesEvent extends NormalizedEvent {
  action?: SnsConfirmAction;
}

/** The detail object of an SES event type: its field, its recipient list, and its event type. */
const DETAILS: Readonly<Record<string, readonly [string, string, NormalizedEventType]>> = {
  Delivery: ["delivery", "recipients", "delivered"],
  Bounce: ["bounce", "bouncedRecipients", "bounced"],
  Complaint: ["complaint", "complainedRecipients", "complained"],
};

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

/**
 * Returns the confirm action of an event, or null. Only a verified
 * `SubscriptionConfirmation` from an allowlisted topic has one. Fetch the URL yourself
 * to confirm the subscription.
 */
export function snsConfirmAction(event: NormalizedEvent): SnsConfirmAction | null {
  const action = (event as SesEvent).action;
  return action?.type === "confirm_subscription" ? action : null;
}

/** Turns a verified SNS body into normalized events. A body that is not SNS gives none. */
export function parseSesEvents(body: Uint8Array): SesEvent[] {
  const sns = parseSnsMessage(body);
  if (!sns) return [];
  const time = (value: unknown, fallback?: number): number | undefined => {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const snsTime = time(sns.Timestamp);
  const event = (fields: Partial<SesEvent>, at: number | undefined): SesEvent => {
    const out: SesEvent = {
      provider: sesMeta.id,
      eventKey: sns.MessageId,
      type: "unknown",
      rawType: sns.Type,
      ...fields,
    };
    if (at !== undefined) out.occurredAt = at;
    return out;
  };

  if (sns.Type !== "Notification") {
    const out = event({}, snsTime);
    const topic = parseTopicArn(sns.TopicArn);
    const url = sns.SubscribeURL;
    if (sns.Type === "SubscriptionConfirmation" && topic && typeof url === "string") {
      if (isSnsSubscribeUrl(url, topic)) {
        out.action = { type: "confirm_subscription", topicArn: sns.TopicArn, subscribeUrl: url };
      }
    }
    return [out];
  }

  let ses: Json = {};
  try {
    ses = record(JSON.parse(sns.Message));
  } catch {
    // A message that is not JSON gives one unknown event.
  }
  const kind = ses.eventType ?? ses.notificationType;
  const rawType = typeof kind === "string" && kind !== "" ? kind : "Notification";
  const messageId = record(ses.mail).messageId;
  const [field, list, mapped] = DETAILS[rawType] ?? ["", "", "unknown"];
  const detail = record(ses[field]);
  const fields: Partial<SesEvent> = { rawType, type: mapped };
  if (typeof messageId === "string") fields.providerMessageId = messageId;
  // Permanent is a hard bounce. Transient and Undetermined are soft.
  if (mapped === "bounced") fields.bounce = detail.bounceType === "Permanent" ? "hard" : "soft";
  // A "not-spam" feedback report is not a complaint.
  if (detail.complaintFeedbackType === "not-spam") fields.type = "unknown";
  const at = time(detail.timestamp, snsTime);
  // Pair each recipient with its own bounce fields before the filter drops bad entries.
  // The filter shifts the indexes, so a later pairing would attach the wrong detail.
  const recipients = (Array.isArray(detail[list]) ? (detail[list] as unknown[]) : [])
    .map((item) => {
      const entry = record(item);
      const address = typeof item === "string" ? item : entry.emailAddress;
      const reason =
        mapped === "bounced"
          ? bounceDetail({ text: entry.diagnosticCode, enhancedCode: entry.status })
          : undefined;
      return { address, reason };
    })
    .filter(
      (item): item is { address: string; reason: BounceDetail | undefined } =>
        typeof item.address === "string" && item.address !== "",
    );
  if (recipients.length === 0) return [event(fields, at)];
  return recipients.map(({ address, reason }, index) => {
    const out = event(
      {
        ...fields,
        recipient: address,
        eventKey: index === 0 ? sns.MessageId : `${sns.MessageId}:${index}`,
      },
      at,
    );
    if (reason !== undefined && out.type === "bounced") out.bounceDetail = reason;
    return out;
  });
}
