# Job Duck — Gmail automation (Apps Script)

Script v5.2. Rejections are queued inside the script and served to `jobduck sync` by the script itself, deployed as a
web app; `jobduck sync` records them in your local Job Duck database. Nothing is pushed anywhere.

A Google Apps Script that runs in the user's own Google account. Every 10 minutes it does three jobs, in this order
of precedence per thread:

1. **Records rejections.** Rejections get `Job Duck/Rejections` (archived) and each one is queued for
   `jobduck sync`. A rejection that mentions an interview ("thank you for taking the time to interview with us")
   is still a rejection.
2. **Keeps interview mail in the Inbox.** When the body of the latest job email invites you to act (an interview
   invite or kickoff, a request to share your availability or book a time, a phone or technical screen, a next
   round or onsite, moving forward to the interview stage, a confirmed interview time, an assessment, coding
   challenge, take-home, HackerRank or CodeSignal test to complete, an offer letter, a pre-interview questionnaire),
   the thread gets `Job Duck/Interviews`, loses `Job Duck/Applications` and is never archived. Only the body is read
   for this; the subject never decides it, and conditional confirmation wording ("if your experience matches, we
   will reach out to schedule an interview") does not count. A courtesy condition about your own interest or reply
   ("if you are still interested, we would like to schedule a phone screen") still counts as an invite. A thread
   labeled `Job Duck/Interviews` is never archived by a later run, even when a rejection arrives in it.
3. **Sorts application mail.** Other job-application emails get the nested label `Job Duck/Applications` and skip
   the Inbox (archived). Confirmations never leave Gmail. Verification and security-code emails are archived too
   unless the script property `KEEP_ACTION_MAIL_IN_INBOX` is `true`; that property affects only verification-code
   mail. Password resets and verification codes with no application wording, job alerts, "new jobs for you" /
   recommended-jobs digests, referral invites, self-identification invites and unfinished-application reminders
   are not treated as application mail.

Only rejections leave the script; nothing about interviews is queued for `jobduck sync`.

The script only ever searches the Inbox (`in:inbox`), plus the `Job Duck/Applications` label when you run
`previewReaudit` / `reauditApplications`. Other archived mail is never read, and a thread already labeled
`Job Duck/Rejections` that reappears in the Inbox is re-archived without being re-read or re-labeled, unless it also
carries `Job Duck/Interviews`.

## What it serves

Only these fields, per rejection email:

| Field | Source |
|---|---|
| `messageId` | The email's `Message-ID` header (Gmail message ID as a fallback) |
| `receivedAt` | When the email arrived (ISO 8601) |
| `senderDomain` | The domain of the `From` address |
| `subject`, `title` | The subject line and a best guess at the role, each cut to 200 characters |
| `company` | A best guess at the employer |
| `jobUrl` | A job-posting link found in the email, if any |
| `jobRef` | The employer's job ID from that link or the subject, if any |
| `applicationId`, `jobId` | Only when a message in the thread carries a `JobDuck-Application-Id: <n>` or `JobDuck-Job-Id: <n>` line (for example the confirmation an agent recorded); Job Duck then closes exactly that application |
| `queuedAt` | When the script queued the outcome |

The email body is never sent. The script reads the body inside Google only to classify the email and find a
job link; nothing else leaves Gmail.

## Setup

`jobduck sync` polls the script, deployed as a web app, for queued rejections and acknowledges each one it has
recorded; acknowledged outcomes are deleted from the script. The agent never gets mail access.

1. Open [script.google.com](https://script.google.com/home) and click **New project**; rename it
   `Job Duck - Gmail Rejection Sync v5.2`. In **Project Settings**, tick **Show "appsscript.json" manifest file in
   editor**. Back in the **Editor**, replace the contents of `appsscript.json` with
   [`appsscript.json`](https://github.com/ZaxShen/JobDuck/blob/main/integrations/gmail-apps-script/appsscript.json)
   and of `Code.gs` with
   [`Code.gs`](https://github.com/ZaxShen/JobDuck/blob/main/integrations/gmail-apps-script/Code.gs) (open each and
   click **Raw** to copy), then **Save** (Cmd/Ctrl+S). Optional script properties (**Project Settings → Script Properties → Add script property**, then
   **Save script properties**): `PROTECTED_LABELS` and `EXCLUDED_DOMAINS` (comma-separated),
   `KEEP_ACTION_MAIL_IN_INBOX=true` (keeps verification-code mail in the Inbox; interview mail always stays).
2. In the Editor, pick `generateSyncToken` in the function menu and **Run**. The first run opens Google's permission
   screens: **Review permissions → Advanced → Go to … (unsafe)**, then on the permissions page **tick "Select all"**
   before **Continue** (the boxes are empty by default; continuing with them empty authorizes nothing and every later
   run fails with a permission error). It stores a random `SYNC_TOKEN` script property and logs it once; running it
   again replaces the token.
3. **Deploy → New deployment → Select type: Web app**, **Execute as: Me**, **Who has access: Anyone**, **Deploy**.
   Copy the web app URL ending in `/exec`.
4. In `permissions.toml` in your Job Duck home (`<your Job Duck folder>/.jobduck/`; `jobduck doctor` shows where it
   is), under `[track]`, set `sync_url` to the `/exec` URL and `sync_token` to the logged token.
5. Run `checkConnection`: it logs the mode (`serve`), the number of pending outcomes and whether `SYNC_TOKEN` is set.
6. Run `preview` to log which Inbox emails would be treated as rejections and the outcome each would queue, and
   which are interview mail (`INTERVIEW` lines with the matched body phrase). Nothing is changed or queued. Up to four minutes on a large Inbox.
7. Run `install` to start the 10-minute trigger. It also renames the labels of earlier versions (`Job Applications`,
   `Deny Letters`) into the nested ones, deletes the old `JobDuck Sync` / `JobDuck Synced` / `JobDuck Review` labels
   and clears the push-mode queue left by v3/v4; threads keep their mail. `uninstall` removes the trigger.

On a large Inbox: the trigger only reads Inbox mail from the last 3 days (`CONFIG.RUN_QUERY`), so run `backfill`
once for older mail. Only rejections received in the last 30 days (`CONFIG.SYNC_SINCE`) are queued for
`jobduck sync`; older ones are labeled and archived but not queued.

The URL alone exposes nothing: a `GET` returns the one line `Job Duck Gmail script v5.2 — POST only`, and every request
for data is a `POST` whose JSON body carries the token (`{ token, action, messageIds? }`, actions `pending`, `ack`,
`status`). The token never goes into a URL. After editing the script, **Deploy → Manage deployments → Edit → Version:
New version** so the `/exec` URL serves the new code; a deployment keeps running the version it was created with.

Optional:

- `backfill` sorts the whole inbox in time-boxed batches (run it again until it says complete). Rejections it
  labels are queued like any other.
- `previewReaudit` re-checks every `Job Duck/Applications` thread, newest first, with the current classifier and
  logs what would change: rejections that would move to `Job Duck/Rejections`, interview mail that would move to
  `Job Duck/Interviews` and back to the Inbox, and non-application mail (password resets, job alerts, referral and
  self-identification invites, unfinished-application reminders) that would lose the Applications label. Nothing
  is changed.
- `reauditApplications` applies those decisions: a rejection gets `Job Duck/Rejections`, loses
  `Job Duck/Applications` and is queued; interview mail gets `Job Duck/Interviews`, loses `Job Duck/Applications`
  and is moved back to the Inbox; non-application mail loses the Applications label only. Both stop after
  4.5 minutes and remember where they were, so run them again until the log says `complete`. `resetReaudit` starts
  both over from the newest thread.

Personal rules (protected labels, excluded domains) are script properties `PROTECTED_LABELS` and `EXCLUDED_DOMAINS`,
so a fresh copy never needs a code edit; the sync start date lives in `CONFIG`.

## Labels

| Label | Meaning |
|---|---|
| `Job Duck/Applications` | Job-application mail (archived) |
| `Job Duck/Rejections` | Rejections (archived) |
| `Job Duck/Interviews` | Interview, assessment, scheduling and offer mail (stays in the Inbox, never archived) |

Queued outcomes live in the script properties as one `outcome:<messageId>` entry each, not in labels.

## Caps

At most 1 000 outcomes stay queued; beyond that new rejections are labeled but not queued, and the run log warns until
`jobduck sync` drains the queue.

## Publishing

To push your own copy of the script with [clasp](https://github.com/google/clasp):

1. Copy `.clasp.json.example` to `.clasp.json` and fill in your own script id (Project Settings → IDs).
2. `bun x @google/clasp login`
3. From `integrations/gmail-apps-script/`, run `bun x @google/clasp push --force`.

The included `.claspignore` keeps the `test/` harness out of the push, so only `appsscript.json` and `Code.gs` upload.

Every version bump renames the project `vN` (or `vN.M`), so a copy's name says which version it runs.
Copies never auto-update: to update, paste the new `Code.gs` over yours, **Save**, then **Deploy → Manage
deployments → Edit → Version: New version** so the `/exec` URL serves it. Script properties, the token and the
trigger are kept.

## Changelog

- **v5.2**: Interview mail is never archived. Earlier versions archived interview invites under
  `Job Duck/Applications` unless `KEEP_ACTION_MAIL_IN_INBOX` was set, and checked only the subject. Now, after the
  rejection check and before the application check, the body of the latest job email is scanned for interview,
  assessment, scheduling and offer phrases; a match gets the new label `Job Duck/Interviews`, loses
  `Job Duck/Applications` and stays in the Inbox, and a thread with that label is never archived by a later run.
  The subject is never the signal. `KEEP_ACTION_MAIL_IN_INBOX` now affects only verification-code mail. `preview`
  logs interview mail on its own `INTERVIEW` line, and `previewReaudit` / `reauditApplications` move interview mail
  from Applications to Interviews and back to the Inbox. **Existing users: after updating, run
  `reauditApplications` once (again until it says `complete`) to restore interview invites that earlier versions
  archived.** New fixtures cover invites with neutral subjects, invites after a courtesy condition ("if you are
  still interested", "should you wish to proceed", "once you confirm"), being moved forward to the interview stage,
  a confirmed interview time, a conditional interview promise and an interview subject over a plain confirmation
  (both stay `job`), and a rejection after an interview; `bun test` runs
  `test/interview.test.ts` against fake threads.

- **v5.1**: A rejection whose only signal is one explicit decision sentence ("we have decided not to move forward
  with your application") is now recognized: the rejection threshold drops from 3 to 2, and an explicit decision
  phrase is still required. Four new fixtures cover single-signal rejections and confirmations that stay `job`.
  Setup describes creating the project yourself at script.google.com.

- **v5**: Serve-only. Push mode is removed: the script properties `JOBDUCK_TOKEN` and `JOBDUCK_URL` are ignored
  (`checkConnection` notes a leftover `JOBDUCK_TOKEN`), there is no `syncPending` or 15/run and 90/day cap, and
  `appsscript.json` drops the `script.external_request` scope. Every rejection is queued for `jobduck sync`.
  `install` clears the old push queue (`jobduckPendingThreads`, `jobduckSyncCount_*` user properties) and deletes a
  leftover `JobDuck Sync` label. `doPost` `status` still reports `mode: 'serve'`. Publishing: template renamed
  `Job Duck - Gmail Rejection Sync v5`.
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
