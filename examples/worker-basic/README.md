# worker-basic

A small Worker that uses mailswitch. It does two things:

- `POST /invoices/:id/send?to=<address>` sends one invoice email with a PDF attachment. Resend is the primary provider. toSend is the fallback.
- `POST /webhooks/resend` receives Resend events and finds hard bounces.

The Worker uses D1 for the idempotency store, the daily cap store, and the webhook dedupe store.

## How it works in this repository

The `tsconfig.json` of this example maps `mailswitch` to the source files of this repository. The root `pnpm typecheck` script checks this example, so the example always matches the current API.

In your own project, install the package. Use the normal Workers `tsconfig.json` of your project instead of the one here:

```sh
npm install mailswitch
```

## Run it

1. Create the D1 database:

   ```sh
   npx wrangler d1 create mailswitch-worker-basic
   ```

2. Put the `database_id` from the output into `wrangler.jsonc`.
3. Set `MAIL_FROM` in `wrangler.jsonc` to an address on a domain that Resend and toSend have verified.
4. Set the secrets:

   ```sh
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put TOSEND_API_KEY
   npx wrangler secret put RESEND_WEBHOOK_SECRET
   ```

5. Deploy the Worker:

   ```sh
   npx wrangler deploy
   ```

6. Send an invoice:

   ```sh
   curl -X POST "https://<your worker>/invoices/INV-0042/send?to=you@example.com"
   ```

7. Send the same request again. The second response shows `sent` again, and no second email goes out. The idempotency store returns the stored result.

## Schema

The Worker applies `D1_SCHEMA` once per isolate with `applyD1Schema`. This keeps the example short. In a production app, copy `D1_SCHEMA` into a D1 migration and remove the call.

## Webhooks

1. In the Resend dashboard, open **Webhooks** and add the endpoint `https://<your worker>/webhooks/resend`.
2. Select the events `email.delivered`, `email.bounced`, and `email.complained`.
3. Copy the signing secret. It starts with `whsec_`.
4. Set it as `RESEND_WEBHOOK_SECRET`.

See [the Resend guide](../../docs/providers/resend.md) for the details.
