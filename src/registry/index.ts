// mailswitch/registry: builds the adapter of a catalog provider id, for example an id
// that a settings screen saved. The app needs no factory map of its own.
//
// - Each provider loads with a dynamic import, so a provider module runs only when the
//   app asks for it. A Worker bundler still puts every provider in the Worker upload.
// - This module has no value import of a provider module. Its provider imports are
//   type-only, and the build removes them.
// - The registry takes no credentials. The credentials go to `createMailer`.

import type { ProviderId } from "../catalog/index";
import type { ProviderAdapter, ProviderWebhooks } from "../core/adapter";
import type { AhasendAdapter, AhasendOptions } from "../providers/ahasend/index";
import type { AutosendAdapter, AutosendOptions } from "../providers/autosend/index";
import type { BrevoAdapter, BrevoOptions } from "../providers/brevo/index";
import type { CloudflareBindingSource, CloudflareRestOptions } from "../providers/cloudflare/index";
import type { HttpConfigOptions, HttpProviderConfig } from "../providers/http/index";
import type { MailchannelsAdapter, MailchannelsOptions } from "../providers/mailchannels/index";
import type { MailersendAdapter, MailersendOptions } from "../providers/mailersend/index";
import type { MailgunAdapter, MailgunOptions } from "../providers/mailgun/index";
import type { MailjetAdapter, MailjetOptions } from "../providers/mailjet/index";
import type { MailtrapAdapter, MailtrapOptions } from "../providers/mailtrap/index";
import type { PostmarkAdapter, PostmarkOptions } from "../providers/postmark/index";
import type { ResendOptions } from "../providers/resend/index";
import type { ScalewayOptions } from "../providers/scaleway/index";
import type { SendgridAdapter, SendgridOptions } from "../providers/sendgrid/index";
import type { SesOptions } from "../providers/ses/index";
import type { SmtpOptions, SmtpWebhookAdapter } from "../providers/smtp/index";
import type { Smtp2goAdapter, Smtp2goOptions } from "../providers/smtp2go/index";
import type { ToSendAdapter, ToSendOptions } from "../providers/tosend/index";
import type { ZeptomailOptions } from "../providers/zeptomail/index";

export type { ProviderId } from "../catalog/index";

/** Options of `createAdapter("cloudflare-binding", ...)`. */
export interface RegistryBindingOptions {
  /** The `send_email` binding, or `{ env }` to find the binding by `bindingName`. */
  binding: CloudflareBindingSource;
}

/** Options of `createAdapter("http", ...)`: the JSON config of `httpProviderFromConfig`. */
export interface RegistryHttpOptions {
  /** The stored JSON config. */
  config: HttpProviderConfig;
  /** The hosts that the config may name. It comes from the deployer, never from the config. */
  allowHosts: HttpConfigOptions["allowHosts"];
}

/**
 * The options of each provider factory, before the registry removes the credential
 * keys. For `cloudflare-binding` and `http`, it is the options of the registry.
 */
export interface RegistryFactoryOptions {
  resend: ResendOptions;
  tosend: ToSendOptions;
  "cloudflare-rest": CloudflareRestOptions;
  "cloudflare-binding": RegistryBindingOptions;
  mailgun: MailgunOptions;
  postmark: PostmarkOptions;
  brevo: BrevoOptions;
  mailersend: MailersendOptions;
  mailjet: MailjetOptions;
  smtp2go: Smtp2goOptions;
  zeptomail: ZeptomailOptions;
  sendgrid: SendgridOptions;
  ses: SesOptions;
  smtp: SmtpOptions;
  mailchannels: MailchannelsOptions;
  ahasend: AhasendOptions;
  mailtrap: MailtrapOptions;
  autosend: AutosendOptions;
  scaleway: ScalewayOptions;
  http: RegistryHttpOptions;
}

/** The adapter type of each provider id. `smtp` with `webhooks` is a `SmtpWebhookAdapter`. */
export interface RegistryAdapters {
  resend: ProviderAdapter;
  tosend: ToSendAdapter;
  "cloudflare-rest": ProviderAdapter;
  "cloudflare-binding": ProviderAdapter;
  mailgun: MailgunAdapter;
  postmark: PostmarkAdapter;
  brevo: BrevoAdapter;
  mailersend: MailersendAdapter;
  mailjet: MailjetAdapter;
  smtp2go: Smtp2goAdapter;
  zeptomail: ProviderAdapter;
  sendgrid: SendgridAdapter;
  ses: ProviderAdapter;
  smtp: ProviderAdapter;
  mailchannels: MailchannelsAdapter;
  ahasend: AhasendAdapter;
  mailtrap: MailtrapAdapter;
  autosend: AutosendAdapter;
  scaleway: ProviderAdapter;
  http: ProviderAdapter;
}

/**
 * The credential keys of each provider id: the credential field names of the meta that
 * are also factory options. A test checks each list against the meta. The meta types
 * widen the names to `string`, so the types cannot derive these lists.
 */
export interface RegistryCredentialKeys {
  readonly resend: readonly ["apiKey"];
  readonly tosend: readonly ["apiKey"];
  readonly "cloudflare-rest": readonly ["accountId", "apiToken"];
  readonly "cloudflare-binding": readonly [];
  readonly mailgun: readonly ["apiKey", "domain", "region"];
  readonly postmark: readonly ["serverToken", "messageStream"];
  readonly brevo: readonly ["apiKey"];
  readonly mailersend: readonly ["apiKey"];
  readonly mailjet: readonly ["apiKey", "secretKey"];
  readonly smtp2go: readonly ["apiKey"];
  readonly zeptomail: readonly ["token", "region", "fromAddress"];
  readonly sendgrid: readonly ["apiKey"];
  readonly ses: readonly ["region", "accessKeyId", "secretAccessKey", "sessionToken"];
  readonly smtp: readonly [
    "preset",
    "host",
    "port",
    "security",
    "insecure",
    "username",
    "password",
  ];
  readonly mailchannels: readonly ["apiKey"];
  readonly ahasend: readonly ["apiKey", "accountId"];
  readonly mailtrap: readonly ["apiKey"];
  readonly autosend: readonly ["apiKey", "projectId"];
  readonly scaleway: readonly ["secretKey", "projectId"];
  readonly http: readonly [];
}

const CREDENTIAL_KEYS: RegistryCredentialKeys = {
  resend: ["apiKey"],
  tosend: ["apiKey"],
  "cloudflare-rest": ["accountId", "apiToken"],
  "cloudflare-binding": [],
  mailgun: ["apiKey", "domain", "region"],
  postmark: ["serverToken", "messageStream"],
  brevo: ["apiKey"],
  mailersend: ["apiKey"],
  mailjet: ["apiKey", "secretKey"],
  smtp2go: ["apiKey"],
  zeptomail: ["token", "region", "fromAddress"],
  sendgrid: ["apiKey"],
  ses: ["region", "accessKeyId", "secretAccessKey", "sessionToken"],
  smtp: ["preset", "host", "port", "security", "insecure", "username", "password"],
  mailchannels: ["apiKey"],
  ahasend: ["apiKey", "accountId"],
  mailtrap: ["apiKey"],
  autosend: ["apiKey", "projectId"],
  scaleway: ["secretKey", "projectId"],
  http: [],
};

function freezeKeys(keys: RegistryCredentialKeys): RegistryCredentialKeys {
  for (const list of Object.values(keys)) Object.freeze(list);
  return Object.freeze(keys);
}

/**
 * The credential keys of each provider id. The options of `createAdapter` leave out
 * these keys, because the credentials go to `createMailer`.
 */
export const REGISTRY_CREDENTIAL_KEYS: RegistryCredentialKeys = freezeKeys(CREDENTIAL_KEYS);

/** The options of `createAdapter` for one provider id. */
export type RegistryOptions<Id extends ProviderId> = Id extends "cloudflare-binding" | "http"
  ? RegistryFactoryOptions[Id]
  : Omit<RegistryFactoryOptions[Id], RegistryCredentialKeys[Id][number]>;

/** The options argument of `createAdapter`. It is required for `cloudflare-binding` and `http`. */
export type RegistryOptionsArg<Id extends ProviderId> = Id extends "cloudflare-binding" | "http"
  ? [options: RegistryOptions<Id>]
  : [options?: RegistryOptions<Id>];

/** The adapter that `createAdapter` gives for one provider id and its options. */
export type RegistryAdapter<
  Id extends ProviderId,
  Options = RegistryOptions<Id>,
> = Id extends "smtp"
  ? Options extends { webhooks: ProviderWebhooks }
    ? SmtpWebhookAdapter
    : ProviderAdapter
  : RegistryAdapters[Id];

type Loader = (options: unknown) => Promise<ProviderAdapter>;

// Each loader casts its options to the factory type. `createAdapter` types the options
// per id, and each factory checks its options at run time.
const LOADERS: { readonly [Id in ProviderId]: Loader } = {
  resend: async (options) => (await import("../providers/resend/index")).resend(options as never),
  tosend: async (options) => (await import("../providers/tosend/index")).tosend(options as never),
  "cloudflare-rest": async (options) =>
    (await import("../providers/cloudflare/index")).cloudflareRest(options as never),
  "cloudflare-binding": async (options) =>
    (await import("../providers/cloudflare/index")).cloudflareBinding(
      requireOptions<RegistryBindingOptions>("cloudflare-binding", options).binding,
    ),
  mailgun: async (options) =>
    (await import("../providers/mailgun/index")).mailgun(options as never),
  postmark: async (options) =>
    (await import("../providers/postmark/index")).postmark(options as never),
  brevo: async (options) => (await import("../providers/brevo/index")).brevo(options as never),
  mailersend: async (options) =>
    (await import("../providers/mailersend/index")).mailersend(options as never),
  mailjet: async (options) =>
    (await import("../providers/mailjet/index")).mailjet(options as never),
  smtp2go: async (options) =>
    (await import("../providers/smtp2go/index")).smtp2go(options as never),
  zeptomail: async (options) =>
    (await import("../providers/zeptomail/index")).zeptomail(options as never),
  sendgrid: async (options) =>
    (await import("../providers/sendgrid/index")).sendgrid(options as never),
  ses: async (options) => (await import("../providers/ses/index")).ses(options as never),
  smtp: async (options) => (await import("../providers/smtp/index")).smtp(options as never),
  mailchannels: async (options) =>
    (await import("../providers/mailchannels/index")).mailchannels(options as never),
  ahasend: async (options) =>
    (await import("../providers/ahasend/index")).ahasend(options as never),
  mailtrap: async (options) =>
    (await import("../providers/mailtrap/index")).mailtrap(options as never),
  autosend: async (options) =>
    (await import("../providers/autosend/index")).autosend(options as never),
  scaleway: async (options) =>
    (await import("../providers/scaleway/index")).scaleway(options as never),
  http: async (options) => {
    const { config, allowHosts } = requireOptions<RegistryHttpOptions>("http", options);
    return (await import("../providers/http/index")).httpProviderFromConfig(config, {
      allowHosts,
    });
  },
};

function requireOptions<T>(id: ProviderId, options: unknown): T {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`createAdapter: "${id}" needs an options object.`);
  }
  return options as T;
}

/** Refuses a credential key in the options. The error names the key, never the value. */
function refuseCredentials(id: ProviderId, options: unknown): void {
  if (typeof options !== "object" || options === null) return;
  for (const key of REGISTRY_CREDENTIAL_KEYS[id]) {
    if (Object.hasOwn(options, key)) {
      throw new TypeError(
        `createAdapter: "${key}" is a credential of "${id}". Pass it to createMailer in credentials.`,
      );
    }
  }
}

async function load(id: ProviderId, options: unknown): Promise<ProviderAdapter> {
  refuseCredentials(id, options);
  return LOADERS[id](options);
}

/**
 * Builds the adapter of a provider id. Check a saved id with `isProviderId` from
 * `mailswitch/catalog` first. The options leave out the credentials, which go to
 * `createMailer`.
 *
 * @throws TypeError at once for an id that is not a `ProviderId`. The message holds the
 * id and never the options. A factory error or an import error rejects the promise.
 */
export function createAdapter(
  id: "smtp",
  options: RegistryOptions<"smtp"> & { webhooks: ProviderWebhooks },
): Promise<SmtpWebhookAdapter>;
export function createAdapter<Id extends ProviderId>(
  id: Id,
  ...options: RegistryOptionsArg<Id>
): Promise<RegistryAdapter<Id>>;
export function createAdapter(id: string, options?: unknown): Promise<ProviderAdapter> {
  if (typeof id !== "string") {
    throw new TypeError("createAdapter: the provider id must be a string.");
  }
  if (!Object.hasOwn(LOADERS, id)) {
    throw new TypeError(
      `createAdapter: ${JSON.stringify(id)} is not a ProviderId. Check it with isProviderId.`,
    );
  }
  return load(id as ProviderId, options);
}
