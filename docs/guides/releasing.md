# Release mailswitch

Last checked: 2026-10-27

This guide is for maintainers. It tells how to set up the release workflow, how to check a release before it goes out, and how to publish it.

The release workflow sets the version from the pending changesets. Do not change the version in `package.json` by hand.

## One-time setup

### The `release` GitHub environment

The workflow `.github/workflows/release.yml` runs in the `release` environment.

1. In the GitHub repository, open **Settings**, then **Environments**.
2. Create an environment with the name `release`.
3. Under **Deployment branches and tags**, allow only the `main` branch.
4. Optional: add required reviewers. Each publish then waits for an approval.

The environment holds no secrets. The workflow does not use an `NPM_TOKEN`.

### The npm trusted publisher

npm trusted publishing uses OIDC. GitHub Actions gets a short-lived token for each run, and npm adds provenance to the package.

1. Sign in to npmjs.com with an account that can publish `mailswitch`.
2. If the package does not exist yet, publish it once by hand from a clean checkout, or create it with the npm web interface. Trusted publishing needs an existing package.
3. Open the package **Settings**, then **Trusted Publisher**.
4. Select **GitHub Actions** and enter these values:

   | Field | Value |
   |---|---|
   | Organization or user | `me-shaon` |
   | Repository | `mailswitch` |
   | Workflow filename | `release.yml` |
   | Environment | `release` |

5. Save the settings.
6. Optional: under **Publishing access**, require two-factor authentication and disallow tokens. Then only the trusted publisher can publish.

The workflow uses Node 24, which has npm 11. Trusted publishing needs npm 11.5 or later.

## Before each release

Do all of these checks on the commit that the release pull request will merge.

### Local checks

Run each command. Each one must pass.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm size
corepack pnpm check:pkg
```

### Live smoke tests

CI makes no live calls. Run the live smoke tests on your computer before a release. A block runs only when its first variable is set. When it is set, every variable of the block must be set.

| Provider | Variables |
|---|---|
| Resend | `MAILSWITCH_LIVE_RESEND_KEY`, `MAILSWITCH_LIVE_RESEND_FROM`, `MAILSWITCH_LIVE_TO` |
| toSend | `MAILSWITCH_LIVE_TOSEND_KEY`, `MAILSWITCH_LIVE_TOSEND_FROM`, `MAILSWITCH_LIVE_TOSEND_TO` |
| SendGrid | `MAILSWITCH_LIVE_SENDGRID_KEY`, `MAILSWITCH_LIVE_SENDGRID_FROM`, `MAILSWITCH_LIVE_TO` |
| Brevo | `MAILSWITCH_LIVE_BREVO_KEY`, `MAILSWITCH_LIVE_BREVO_FROM`, `MAILSWITCH_LIVE_TO` |
| MailerSend | `MAILSWITCH_LIVE_MAILERSEND_KEY`, `MAILSWITCH_LIVE_MAILERSEND_FROM`, `MAILSWITCH_LIVE_TO` |
| Mailjet | `MAILSWITCH_LIVE_MAILJET_KEY`, `MAILSWITCH_LIVE_MAILJET_SECRET`, `MAILSWITCH_LIVE_MAILJET_FROM`, `MAILSWITCH_LIVE_TO` |
| SMTP2GO | `MAILSWITCH_LIVE_SMTP2GO_KEY`, `MAILSWITCH_LIVE_SMTP2GO_FROM`, `MAILSWITCH_LIVE_TO` |
| ZeptoMail | `MAILSWITCH_LIVE_ZEPTOMAIL_TOKEN`, `MAILSWITCH_LIVE_ZEPTOMAIL_FROM`, `MAILSWITCH_LIVE_TO`, and optional `MAILSWITCH_LIVE_ZEPTOMAIL_REGION` |

The SendGrid, Brevo, and Mailjet blocks use the sandbox mode of the provider, so they deliver no email. The MailerSend, SMTP2GO, and ZeptoMail blocks send one real email.

The ZeptoMail block also runs `verify` with a valid token and with a wrong token. Before a release, both answers must match: `ok` for the valid token, and `not_sent/auth` for the wrong token. If they do not match, stop the release and name the gap in the release pull request.

The other providers have no live smoke test yet. Their recorded fixtures run in the conformance suite.

```sh
MAILSWITCH_LIVE_RESEND_KEY=re_... \
MAILSWITCH_LIVE_RESEND_FROM=release@your-domain.example \
MAILSWITCH_LIVE_TO=you@example.com \
corepack pnpm vitest run test/live
```

Each smoke test verifies the key and sends one email, or validates one email in sandbox mode. Check that the email arrives. Do not paste the keys into a shell history that other people can read.

### The CPU check (R36)

A single `send()` with a 1 MB attachment must use less than 5 ms of CPU time on Workers. CI runs a Node benchmark. Before a release, measure it on Workers too.

1. In a local branch, change `invoicePdf` in `examples/worker-basic/src/index.ts` to return 1 MB of fixed bytes. Do not commit this change.
2. Deploy `examples/worker-basic`. See its [README](../../examples/worker-basic/README.md).
3. Deploy a Tail Worker that logs the CPU time of each event:

   ```ts
   export default {
     async tail(events: TraceItem[]): Promise<void> {
       for (const event of events) {
         console.log(JSON.stringify({ script: event.scriptName, cpuTime: event.cpuTime }));
       }
     },
   };
   ```

4. Add the Tail Worker to the `tail_consumers` of `examples/worker-basic` and deploy again.
5. Send one invoice:

   ```sh
   curl -X POST "https://<your worker>/invoices/INV-R36/send?to=you@example.com"
   ```

6. Read `cpuTime` in the logs of the Tail Worker, for example with `npx wrangler tail <tail worker name>`.
7. The value must be less than 5 ms. If it is 5 ms or more, stop the release and find the cause.
8. Write the value in the release pull request.

## Publish

The release uses changesets and the release workflow.

1. Add a changeset to each pull request that changes the package. Run `corepack pnpm changeset` and pick the bump. Do not run `changeset version` or `changeset publish` by hand.
2. Merge the pull request to `main`.
3. The release workflow opens or updates the pull request "chore: release". It holds the new version and the `CHANGELOG.md` entries.
4. Do the checks in [Before each release](#before-each-release) on that pull request.
5. Merge the release pull request.
6. The workflow builds the package and runs `changeset publish`. npm authenticates the run with the trusted publisher and adds provenance. The workflow also creates a GitHub release.
7. Check the result:

   ```sh
   npm view mailswitch version
   npm view mailswitch dist.attestations
   ```

   The version must be the new version, and the attestations must show provenance.

If the publish fails, do not publish by hand from your computer. Fix the cause, and run the workflow again.
