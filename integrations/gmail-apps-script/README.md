# Job Duck — Gmail automation (Apps Script)

Script v4. It runs in one of two modes:

- **Serve mode** (default, for the Job Duck framework): rejections are queued inside the script and served to
  `jobduck sync` by the script itself, deployed as a web app. Nothing is pushed anywhere. See
  [Serve mode](#serve-mode-job-duck-framework).
- **Push mode** (legacy, when the script property `JOBDUCK_TOKEN` is set): compatible with Job Duck Applications v3
  and inbound API v1 (`/api/inbound/ping`, `/api/inbound/rejections`). Every request carries
  `X-JobDuck-Script-Version` and `X-JobDuck-Inbound-API` headers, and `checkConnection` logs the pair, so a future
  server can refuse or warn about stale copies.

A Google Apps Script that runs in the user's own Google account. Every 10 minutes it does two jobs:

1. **Sorts application mail.** Job-application emails get the nested label `Job Duck/Applications` and skip the
   Inbox (archived). Confirmations never leave Gmail. Interview and assessment emails are archived too unless the
   script property `KEEP_ACTION_MAIL_IN_INBOX` is `true`. Password resets and verification codes with no
   application wording, job alerts, "new jobs for you" / recommended-jobs digests, referral invites,
   self-identification invites and unfinished-application reminders are not treated as application mail.
2. **Records rejections.** Rejections get `Job Duck/Rejections` (archived). In serve mode each one is queued for
   `jobduck sync`; in push mode it is reported to Job Duck (`POST /api/inbound/rejections`) so the matching
   application closes as Denied by Employer, or lands in the review queue when it can't be matched.

Only rejections leave the script.

The script only ever searches the Inbox (`in:inbox`), plus the `Job Duck/Applications` label when you run
`previewReaudit` / `reauditApplications`. Other archived mail is never read, and a thread already labeled
`Job Duck/Rejections` that reappears in the Inbox is re-archived without being re-read or re-labeled.

## What it sends

In serve mode each queued outcome holds `messageId`, `receivedAt`, `senderDomain`, `subject` and `title` (each cut to
200 characters), `company`, `jobUrl`, `jobRef`, `applicationId`, `jobId` and `queuedAt`, with the same sources as the
push fields below.

In push mode, only these fields, per rejection email:

| Field | Source |
|---|---|
| `messageId` | The email's `Message-ID` header (Gmail message ID as a fallback) |
| `receivedAt` | When the email arrived (ISO 8601) |
| `senderEmail`, `senderName` | The `From` header |
| `subject` | The subject line |
| `jobUrl` | A job-posting link found in the email, if any |
| `jobRef` | The employer's job ID from that link or the subject, if any |
| `company`, `title` | Best guesses at the employer and role |
| `application_id`, `job_id` | Only when a message in the thread carries a `JobDuck-Application-Id: <n>` or `JobDuck-Job-Id: <n>` line (for example the confirmation an agent recorded); Job Duck then closes exactly that application |

The email body is never sent. The script reads the body inside Google only to classify the email and find a
job link; nothing else leaves Gmail.

## Serve mode (Job Duck framework)

`jobduck sync` polls the script, deployed as a web app, for queued rejections and acknowledges each one it has
recorded; acknowledged outcomes are deleted from the script. The agent never gets mail access.

1. Make a copy of the template (see step 2 of the push-mode setup) and leave `JOBDUCK_TOKEN` unset.
2. In the Editor, run `generateSyncToken` (the first run opens the permission screens described in push-mode step 4).
   It stores a random `SYNC_TOKEN` script property and logs it once; running it again replaces the token.
3. **Deploy → New deployment → Select type: Web app**, **Execute as: Me**, **Who has access: Anyone**, **Deploy**.
   Copy the web app URL ending in `/exec`.
4. In `~/.jobduck/permissions.toml`, under `[track]`, set `sync_url` to the `/exec` URL and `sync_token` to the
   logged token.
5. Run `checkConnection`: it logs the mode (`serve`), the number of pending outcomes and whether `SYNC_TOKEN` is set.
   Then run `preview` and `install` as in push-mode steps 5–6.

The URL alone exposes nothing: a `GET` returns the one line `Job Duck Gmail script v4 — POST only`, and every request
for data is a `POST` whose JSON body carries the token (`{ token, action, messageIds? }`, actions `pending`, `ack`,
`status`). The token never goes into a URL. After editing the script, **Deploy → Manage deployments → Edit → Version:
New version** so the `/exec` URL serves the new code; a deployment keeps running the version it was created with.

`syncPending` only logs the pending count in serve mode. At most 1 000 outcomes stay queued; beyond that new rejections
are labeled but not queued, and the run log warns until `jobduck sync` drains the queue.

## Push mode setup (existing users)

1. In Job Duck, open **Settings → API tokens** and click **Set up Gmail automation**. This creates a token named
   "Gmail Automation" (shown as a link to your Apps Script projects) with the `inbound:rejections` scope (expires in 1 year), copies it to the clipboard, and opens
   this template. Keep the token dialog open until step 3 is saved (its **Copy** button restores the clipboard).
2. In the template's Overview page, click the **Make a copy** icon (top right, next to the star). The copy opens in a
   new tab.
3. In your copy: **Project Settings → Script Properties → Add script property** `JOBDUCK_TOKEN`, paste the token,
   **Save script properties**. Leaving the page before saving discards the row. Optional properties:
   `PROTECTED_LABELS` and `EXCLUDED_DOMAINS` (comma-separated), `KEEP_ACTION_MAIL_IN_INBOX=true`.
4. In the Editor, pick `checkConnection` in the function menu and **Run**. The first run opens Google's permission
   screens: **Review permissions → Advanced → Go to … (unsafe)**, then on the permissions page **tick "Select all"**
   before **Continue** (the four boxes are empty by default; continuing with them empty authorizes nothing and every
   later run fails with a permission error). The log should read `Connected as <your email> (script v4, …)`.
5. Run `preview` to log which Inbox emails would be treated as rejections and the exact payload each would send
   (in serve mode: the outcome each would queue). Nothing is changed or sent. Up to four minutes on a large Inbox.
6. Run `install` to start the 10-minute trigger. It also renames the labels of earlier versions (`Job Applications`,
   `Deny Letters`) into the nested ones, moves the old `JobDuck Sync` queue into the script and deletes the old
   `JobDuck Synced` / `JobDuck Review` labels; threads keep their mail. `uninstall` removes the trigger.

Optional:

- `backfill` sorts the whole inbox in time-boxed batches (run it again until it says complete). It only labels;
  it doesn't send anything.
- `syncPending` sends the rejections still queued in the script, up to the caps below (push mode).
- `previewReaudit` re-checks every `Job Duck/Applications` thread, newest first, with the current classifier and
  logs what would change: rejections that would move to `Job Duck/Rejections`, and non-application mail (password
  resets, job alerts, referral and self-identification invites, unfinished-application reminders) that would lose
  the Applications label. Nothing is changed.
- `reauditApplications` applies those decisions: a rejection gets `Job Duck/Rejections`, loses
  `Job Duck/Applications` and is queued (push mode: sent like any other rejection); non-application mail loses the
  Applications label only. Both stop after 4.5 minutes and remember where they were, so run them again until the log
  says `complete`. `resetReaudit` starts both over from the newest thread.

Optional script property `JOBDUCK_URL` points the script at another Job Duck instance (default
`https://jobduck.work`). Personal rules (protected labels, excluded domains) are script properties `PROTECTED_LABELS` and
`EXCLUDED_DOMAINS`, so a fresh copy never needs a code edit; the sync start date lives in `CONFIG`.

## Labels

| Label | Meaning |
|---|---|
| `Job Duck/Applications` | Job-application mail (archived) |
| `Job Duck/Rejections` | Rejections (archived) |

Queued outcomes (serve mode) live in the script properties as one `outcome:<messageId>` entry each; rejections
waiting to be sent and the daily counters (push mode) live in the script's user properties, not in labels. In push
mode, whether Job Duck closed an application or needs a match shows on the Applications page (status note and review
banner).

## Caps

- Serve mode: at most 1 000 outcomes pending.
- Push mode: at most 15 rejections sent per run and 90 per day. The rest stay queued for the next run or day.
- On 401/403 (token revoked or expired), 429 (daily limit) or a server error, syncing stops for that run and
  retries later.

## Publishing

To push your own copy of the script with [clasp](https://github.com/google/clasp):

1. Copy `.clasp.json.example` to `.clasp.json` and fill in your own script id (Project Settings → IDs).
2. `bun x @google/clasp login`
3. From `integrations/gmail-apps-script/`, run `bun x @google/clasp push --force`.

Every version bump renames the project `vN` (or `vN.M`), so a copy's name says which version it runs.
Copies never auto-update: to update, make a new copy and re-add your script properties.

## Changelog

- **v4**: Serve mode for the Job Duck framework: rejections are queued as one script property per message
  (`outcome:<messageId>`, no body, subject/title cut to 200 characters, 1 000 pending at most) and served by the
  script deployed as a web app (`doPost` with the `SYNC_TOKEN` in the JSON body: `pending`, `ack`, `status`; `doGet`
  returns a one-line page); `generateSyncToken`; `appsscript.json` gains the `webapp` block. Push mode to
  `/api/inbound/rejections` is unchanged while `JOBDUCK_TOKEN` is set. `previewReaudit` / `reauditApplications`
  re-check the `Job Duck/Applications` label in time-boxed, resumable runs. Job-gate negatives for password resets
  and verification codes without application wording, job alerts, "new jobs for you" / recommended jobs, referral
  invites, self-identification invites and unfinished-application reminders. New fixtures (Runpod, Ashby receipts with
  "we can't respond to every applicant", Paylocity receipt vs rejection, the five non-application kinds) and
  `node test/webapp.js`. Publishing: template renamed `Job Duck - Gmail Rejection Sync v4`.
- **v3.1**: Classifier fixes. A sentence with a conditional ("in the event …") now scores its text before the
  conditional instead of being dropped, so "decided to move forward with other candidates … in the event any roles
  open up" counts; added audited rejection phrasings (other candidates, more closely aligned, "isn't quite a match",
  role closed, no longer reviewing, and more); a rejection needs at least one explicit decision signal, so
  courtesy-only mail no longer qualifies; recruiter spam ("Immediate Need", "W2 Only", C2C) from non-ATS senders is
  kept out of both labels. Adds the regression harness: `node test/run.js` runs the real `Code.gs` against
  `test/fixtures.json`.
- **v3**: Nested labels `Job Duck/Applications` and `Job Duck/Rejections`; every matched email skips the Inbox
  (`KEEP_ACTION_MAIL_IN_INBOX` restores the old behaviour); the sync queue moved from the `JobDuck Sync` label into
  script properties and the `JobDuck Synced` / `JobDuck Review` labels are gone; `install` migrates the old labels
  (Gmail advanced service); personal rules via script properties.

- **v2**: Passes `application_id` / `job_id` through when a thread message carries a `JobDuck-Application-Id` or
  `JobDuck-Job-Id` line, so Job Duck can close that application exactly.
- **v1**: Initial template. Sorts job and rejection emails, syncs rejections to Job Duck, `checkConnection`
  via `GET /api/inbound/ping`, `preview`, `backfill`, `syncPending`, 15/run and 90/day caps.
