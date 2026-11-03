# Job Duck — Gmail automation (Apps Script)

Script v5.5. Rejections are queued inside the script and served to `jobduck sync` by the script itself, deployed as a
web app; `jobduck sync` records them in your local Job Duck database. Nothing is pushed anywhere.

A Google Apps Script that runs in the user's own Google account. Every 10 minutes it reads each job thread in the
Inbox. It handles exactly two kinds of mail: plain application confirmations (labeled `Job Duck/Applications` and
archived) and rejections (labeled `Job Duck/Rejections`, archived and queued). **Everything else is kept: no label,
no archive, the thread is left in the Inbox untouched.** Archiving works by allowlist: a thread leaves the Inbox only
when every message in it is provably safe to archive. Only message bodies are read for this; the subject never
decides it. Missing an invite is the defect to avoid, so keeping an extra email in the Inbox is the accepted cost:
when unsure, the script keeps.

A **plain application confirmation** is a job email whose body confirms the application ("thank you for applying",
"we have received your application"), is not a rejection, is written by nobody in the first person, and in which
every sentence is a known acknowledgement. Only the greeting line ("Hi Alex,"), the sign-off with the signature
lines directly under it ("Best, Acme Recruiting"; only a name directly under the sign-off, then job title, team,
company and contact lines), an unsigned signature that is the one unbroken block ending the
body, and sentences that are a standard footer in their entirety are set aside. A footer sentence is one of: do not
reply or an unattended mailbox; sent by, sent via or powered by a named ATS (Greenhouse, Lever, Workday, Ashby,
iCIMS, SmartRecruiters and others); unsubscribe or manage email preferences; privacy policy; the equal opportunity
statement; a mailing address; copyright; the standard confidentiality notice. A mailing address counts only as a
sentence of its own made of capitalised address words, with a suite or a city, state and ZIP code ("500 Market St,
Suite 300, San Francisco, CA 94105"), so a meeting time and place ("10 am Friday at 500 Market St") is not a footer. A
sentence that merely contains footer words ("This message was sent by the CTO, who loved your profile", "Note that
the case study we sent is confidential") is an ordinary sentence. Every other sentence must be one of: thanks for
applying or for your interest (in a role at a company); we have received your application; we or our team will
review your application, qualifications or background; we will be in touch, contact you or get back to you (if your
experience matches, in the coming weeks); you can view or track your application status in the candidate portal;
we appreciate your interest; we wish you luck; we will keep your resume on file; join our talent community; and the
standard process wording described below. Besides these, a sentence may belong to one enumerated boilerplate
category: equal opportunity and diversity statements, privacy and data notices, recruiting-scam warnings,
accommodation offers, pay-transparency links, do-not-reply, unsubscribe, footer and address lines, sign-offs,
greetings and team signatures, hiring-process FAQ pointers, and generic company or careers marketing ("learn more
about our culture on our careers page", "follow us on LinkedIn"). Role and company names in them are at most 80
characters with no digit and no action, time, deadline or scheduling word. Any other sentence ("Please complete your
HireVue by Friday", "Your Karat session link is below", "Reply with your free times", a question to you, a bare link,
or any prose the script does not know) keeps the thread in the Inbox. On top of the allowlist, a deny-list of action
wording vetoes archiving: a request or imperative, a task, a tool or verification code, an unfinished application, a
date or time, a link, a question, an offer, a personal note, a conversation, being moved forward, something waiting
on you, or a meeting place.

Scheduling words are judged one sentence at a time: interview, call, chat, Zoom, Teams, Calendly, schedule,
availability, onsite, screen, next step, assessment, meet, talk, phone, round, slot, book, invite, offer, an
assessment or video-interview vendor (HackerRank, CodeSignal, Codility, TestGorilla, HireVue, Pymetrics, Karat, Spark
Hire, Modern Hire, Harver, Wonderlic, SHL, CCAT), a questionnaire, and similar. A sentence with one of them keeps the
thread unless the whole sentence is proven boilerplate that promises you nothing yet: an employer-side condition
before a contact promise ("if your experience matches, we'll be in touch to schedule an interview", "if there is a
fit, we will contact you about next steps"), an applicant-pool promise ("candidates who move forward in the interview
process will be contacted", "if you are selected for an interview, a member of our team will contact you"), a
description of the process ("our interview process typically includes a recruiter screen, a technical interview and
an onsite"), a "what's next?" heading, "our team will screen your application", or a talent-community invite. A
scheduling word in the greeting or signature keeps the thread too. A direct ask or offer ("could you share times for
a 30-minute call", "we would like to invite you to interview", a named interviewer with a date, a Calendly, GoodTime
or booking link, an assessment to complete, "we would like to move forward with you") is never boilerplate, whatever
condition precedes it.

1. **Records rejections.** A rejection gets `Job Duck/Rejections`, is archived and is queued for `jobduck sync` only
   when it is the latest job email in the thread and every other message is a plain application confirmation (a
   Greenhouse confirmation followed by the rejection, say). A rejection that mentions an interview ("thank you for
   taking the time to interview with us") or offers to keep in touch about future roles is still a rejection. Only an
   explicit rejection statement counts, and a rejection that asks you to reply ("please let us know if you are
   willing to relocate") stays in the Inbox untouched. Any
   other message in the thread (an invite, scheduling mail, a personal note from a recruiter, a message after the
   rejection) or a rejection that offers a call ("but we'd like to schedule a call about another role") keeps the
   thread: no label, left in the Inbox, nothing queued. A thread already labeled `Job Duck/Rejections` that comes
   back to the Inbox with a new message is re-read: if the rejection no longer stands it loses `Job Duck/Rejections`,
   stays in the Inbox with no label and its outcome, if `jobduck sync` has not fetched it yet, is dropped. If the
   rejection still stands, the thread is re-archived and not queued again.
2. **Sorts application mail.** A thread whose every message is a plain application confirmation gets the nested
   label `Job Duck/Applications` and skips the Inbox (archived). Confirmations never leave Gmail. Verification and
   security-code emails ask you to act, so they are never plain confirmations and stay in the Inbox untouched; the
   script property `KEEP_ACTION_MAIL_IN_INBOX` is still read but no longer changes anything.
3. **Keeps everything else untouched.** Every other job thread (an interview invite or kickoff, a request for your
   availability, a screen, an onsite, an assessment, an offer, a recruiter's note, a confirmation with a sentence the
   allowlist does not know) is kept: the script adds no label, does not archive it, and leaves it in the Inbox. If an
   earlier run had labeled it `Job Duck/Applications`, that label comes off. Password resets and verification codes
   with no application wording, job alerts, "new jobs for you" / recommended-jobs digests, referral invites,
   self-identification invites and unfinished-application reminders are not treated as job mail and are left alone.

Only rejections that stand leave the script; nothing else is queued for `jobduck sync`.

The script only ever searches the Inbox (`in:inbox`), plus the `Job Duck/Applications` label when you run
`previewReaudit` / `reauditApplications`. Other archived mail is never read.

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
   `Job Duck - Gmail Rejection Sync v5.5`. In **Project Settings**, tick **Show "appsscript.json" manifest file in
   editor**. Back in the **Editor**, replace the contents of `appsscript.json` with
   [`appsscript.json`](https://github.com/ZaxShen/JobDuck/blob/main/integrations/gmail-apps-script/appsscript.json)
   and of `Code.gs` with
   [`Code.gs`](https://github.com/ZaxShen/JobDuck/blob/main/integrations/gmail-apps-script/Code.gs) (open each and
   click **Raw** to copy), then **Save** (Cmd/Ctrl+S). Optional script properties (**Project Settings → Script Properties → Add script property**, then
   **Save script properties**): `PROTECTED_LABELS` and `EXCLUDED_DOMAINS` (comma-separated),
   `KEEP_ACTION_MAIL_IN_INBOX=true` (a no-op since v5.4: verification-code mail always stays in the Inbox).
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
6. Run `preview` to log, with the same thread rules as the trigger, which Inbox threads would be treated as
   rejections and the outcome each would queue, and which would be kept untouched in the Inbox (`KEEP` lines with
   the reason and body phrase). Nothing is changed or queued. Up to four minutes on a large Inbox.
7. Run `install` to start the 10-minute trigger. It also renames the labels of earlier versions (`Job Applications`,
   `Deny Letters`) into the nested ones, deletes the old `JobDuck Sync` / `JobDuck Synced` / `JobDuck Review` labels
   and the interview label v5.2 created, and clears the push-mode queue left by v3/v4; threads keep their mail.
   `uninstall` removes the trigger.

On a large Inbox: the trigger only reads Inbox mail from the last 3 days (`CONFIG.RUN_QUERY`), so run `backfill`
once for older mail. Only rejections received in the last 30 days (`CONFIG.SYNC_SINCE`) are queued for
`jobduck sync`; older ones are labeled and archived but not queued.

The URL alone exposes nothing: a `GET` returns the one line `Job Duck Gmail script v5.5 — POST only`, and every request
for data is a `POST` whose JSON body carries the token (`{ token, action, messageIds? }`, actions `pending`, `ack`,
`status`). The token never goes into a URL. After editing the script, **Deploy → Manage deployments → Edit → Version:
New version** so the `/exec` URL serves the new code; a deployment keeps running the version it was created with.

Optional:

- `backfill` sorts the whole inbox in time-boxed batches (run it again until it says complete). Rejections it
  labels are queued like any other.
- `previewReaudit` re-checks every `Job Duck/Applications` thread, newest first, with the same thread rules as the
  trigger and logs what would change: rejections that would move to `Job Duck/Rejections`, threads that are not
  plain application confirmations (interview mail, recruiter notes, unknown sentences) that would be kept (`would
  keep` lines), and non-application mail (password resets, job alerts, referral and self-identification invites,
  unfinished-application reminders) that would lose the Applications label. Nothing is changed.
- `reauditApplications` applies those decisions: a rejection gets `Job Duck/Rejections`, loses
  `Job Duck/Applications` and is queued; a kept thread loses `Job Duck/Applications` (and the v5.2 interview label,
  if the thread still has it; that label is never created) and is moved back to the Inbox with no label;
  non-application mail loses the Applications label only. Both stop after
  4.5 minutes and remember where they were, so run them again until the log says `complete`. `resetReaudit` starts
  both over from the newest thread.

Personal rules (protected labels, excluded domains) are script properties `PROTECTED_LABELS` and `EXCLUDED_DOMAINS`,
so a fresh copy never needs a code edit; the sync start date lives in `CONFIG`.

## Labels

| Label | Meaning |
|---|---|
| `Job Duck/Applications` | Job-application mail (archived) |
| `Job Duck/Rejections` | Rejections (archived) |

These are the only two labels the script uses. Every other thread (interview, assessment, scheduling and offer mail,
recruiter notes, anything the script is unsure about) gets no label and is left in the Inbox untouched.

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

- **v5.5**: A rejection is denied only when every sentence, once the greeting, sign-off and standard footer are set
  aside, is an allowlisted shape: the decision itself, thanks or appreciation for the application, a wish of luck, a
  pointer to the careers page or future openings that names no person, call or specific role, a status disclaimer for
  other applications, the applicant-pool courtesy, a privacy or recruiting-fraud notice, or a frame line (greeting,
  team signature, link row, requisition number). Each shape is an enumerated, anchored pattern; its name slots hold at
  most 80 characters with no scheduling word and nothing from the veto list. Any other sentence ("Our recruiter Jane
  will email you to set up time", "The weather in Denver is lovely this week") keeps the thread in the Inbox. The v5.4
  contact vetoes still apply on top.
- **v5.4**: The script archives or denies only when it is certain the mail is an application confirmation or a
  rejection; anything else stays in the Inbox untouched. New confirmation rule: a message is archived only when every
  sentence is an acknowledgement or belongs to an enumerated boilerplate category (equal opportunity and diversity,
  privacy and data notices, recruiting-scam warnings, accommodation, pay transparency, do-not-reply, unsubscribe,
  footer and address lines, sign-offs, greetings and team signatures, hiring-process FAQ pointers, generic company or
  careers marketing), and an action deny-list (a request, task, tool, verification code, unfinished application, date
  or time, link, question, offer, personal note, conversation, moving you forward, something waiting on you, a meeting
  place) vetoes it on top. A sentence in no category keeps the thread; recall grows only by adding categories, never by
  admitting unknown prose. Verification-code mail is therefore never archived, so `KEEP_ACTION_MAIL_IN_INBOX` no longer
  changes anything. Rejection fixes (#51): curly quotes are normalised before sentences are read; new explicit
  rejection statements ("we've filled the position", "won't be able to invite you to the next round", "don't see the
  right fit", "made the decision to pursue other candidates", "not moving you forward to an interview"); "not" or
  "never" before "move you forward" no longer reads as advancing you; a negated offer is no offer; a rejection that
  asks you to reply ("please let us know if you are willing to relocate") stays in the Inbox; and a rejection is
  denied only when no sentence might invite further contact. Outside the footer, any question other than an offer of
  help with questions ("Can we talk?"), a call, chat, talk, meeting or conversation not thanked for as past ("Could we
  set up a call about our Staff role?"), another role, team or opening not pointed to on the careers site, interest
  in you for a role, a resume passed along, an unconditional promise that someone will reach out, a date or time, a
  meeting tool, a request or imperative, or a booking or meeting link anywhere ("Unfortunately we don't see a direct
  fit. Are you free Tuesday to chat about a different position?") keeps it in the Inbox. Only a job-board pointer or
  a status disclaimer ("if you have applied for other roles", "should your qualifications fit") excuses another role;
  thanks for past time does not excuse a call still to come ("Thank you for your time; our VP would like to call
  you"); and a handoff (reply if interested, a recruiter reaching out if a role interests you, a profile shared with a
  team, being put in touch, an email to schedule next steps) keeps the rejection in the Inbox. A row of
  bare links is never a footer, so a confirmation carrying links stays in the Inbox. Fixtures F4 to F9 cover
  these. `bun test` adds interview, assessment, verification, security-code, application-limit, unfinished-application,
  phone-screen and recruiter-chat mail that stays untouched, Ashby, Greenhouse, Lever and Workday-style confirmations
  with boilerplate footers that archive, and an otherwise plain confirmation with one unknown sentence that stays.
- **v5.3**: The script handles only applications and rejections. The interview label v5.2 added is gone: a kept
  thread gets no label, is not archived and stays in the Inbox untouched, and a stale `Job Duck/Applications` label
  on it comes off. A returning `Job Duck/Rejections` thread whose rejection no longer stands loses the label and stays
  in the Inbox unlabeled. `install` deletes the v5.2 interview label; `reauditApplications` takes Applications (and
  that label, if a thread still has it, never creating it) off kept threads and moves them to the Inbox. `preview`
  logs kept threads on `KEEP` lines, `previewReaudit` on `would keep` lines, and the reaudit no-op is now counted as
  `unchanged`. Scheduling words are judged per sentence instead of anywhere in the body: proven boilerplate (an
  employer-side condition before a contact promise, an applicant-pool promise, a process description naming the
  interview stages, a "what's next?" heading, "we will screen your application", a talent-community invite) no
  longer keeps a plain confirmation in the Inbox, while a direct ask, invite, named interviewer with a time,
  scheduling link, assessment or offer always does. The acknowledgement allowlist is wider (resume on file, talent
  community, next-steps contact promises, review in progress, inline table cells, greeting lines with a trailing
  dash or a bare name). A role or company name, a greeting or a signature carrying a scheduling word keeps the thread.
  Fixtures that expected `interview` now expect `keep`, except four confirmations whose only scheduling wording is
  employer-side boilerplate, which now expect `job`: Initech conditional interview promise, Massive Dynamic, Oscorp
  and Vandelay. `bun test` adds anonymized boilerplate shapes that archive, interview shapes that are kept, and mocked
  Gmail checks that a kept thread gets no label and no archive and that no code path creates an interview or review
  label.
- **v5.2**: Interview mail is never archived. Earlier versions archived interview invites under
  `Job Duck/Applications` unless `KEEP_ACTION_MAIL_IN_INBOX` was set, and checked only the subject. Archiving is now
  an allowlist read from message bodies only, and both archiving filters favour precision: if unsure, keep in the
  Inbox. A thread is archived under `Job Duck/Applications` only when every message is a plain application
  confirmation with no scheduling word anywhere, boilerplate included ("if your experience matches, we will reach
  out to schedule an interview" now stays in the Inbox), and no personal note. A rejection is archived and queued only
  when it is the latest job email and every other message in the thread is a plain confirmation; an invite,
  scheduling mail, a recruiter's note or any later message keeps the thread in the Inbox, and so does a rejection
  that offers a call about another role. A retrospective "thank you for taking the time to interview with us" or an
  offer to keep in touch stays a rejection. Every thread that is kept gets the new v5.2 interview label, loses
  `Job Duck/Applications`, and is never archived by a later run. A `Job Duck/Rejections` thread that comes back to the
  Inbox is re-read: if its rejection no longer stands it moves to the interview label, stays in the Inbox and its
  pending outcome is dropped. Scheduling news no longer counts as a rejection: "you have not selected a time yet",
  "the time you selected is no longer available", "we regret to inform you that we need to reschedule your interview"
  and "you cannot move forward to the onsite until you complete the assessment". `KEEP_ACTION_MAIL_IN_INBOX` now
  affects only verification-code mail. `preview`, `previewReaudit` and `reauditApplications` apply the same thread
  rules; `preview` logs kept threads on their own `INTERVIEW` line, and `reauditApplications` moves kept threads from
  Applications to Interviews and back to the Inbox. **Existing users: after updating, run `reauditApplications` once
  (again until it says `complete`) to restore interview invites that earlier versions archived.** New fixtures cover
  invites with neutral subjects, direct offers after any condition, availability questions, being moved forward to
  the interview stage, a confirmed or upcoming interview and a promise to schedule your own interview (all
  `interview`), an interview subject over a plain confirmation (`job`) and a rejection after an interview. Nine
  earlier `job` fixtures now expect `interview` because they are not plain confirmations: Cisco, Green Dot, Courtesy
  only, Globex courtesy-only, Initech conditional interview promise, Massive Dynamic, Oscorp, Vandelay and Dunder.
  A plain confirmation is now a sentence allowlist, not a word list: every sentence outside the greeting, sign-off,
  signature and footer must be a known acknowledgement, so a confirmation that also asks you to take a HireVue,
  CCAT, Pymetrics, Karat or Spark Hire step, join a Teams link at a set time, or reply with your free times stays in
  the Inbox. Footer sentences are set aside only when the whole sentence is a standard footer, so an action wrapped
  in footer wording ("This automated email is a reminder that your work sample is still outstanding") stays in the
  Inbox too. Signature lines are an allowlist as well: a line under the sign-off ("Technical Project Instructions",
  "Let's Connect Soon") is set aside only when it is a name, job title, team, company or contact line, and an
  unsigned signature only as the unbroken block that ends the body. A mailing address is a footer only on its own,
  and a phone line needs ten digits (eight after a +), so a meeting place or a date or time line under the signature
  stays in the Inbox. The allowlist moves no existing fixture: all 7
  remaining `job` fixtures stay `job` and none flips to `interview`. `bun test` runs `test/interview.test.ts`
  against fake threads, including 55 action sentences, 45 actions in footer wording and 12 action lines under a
  signature that must stay in the Inbox, and Greenhouse, Lever, Workday, Ashby, iCIMS, SmartRecruiters and
  equal-opportunity footers and realistic signatures on acknowledgements that are still archived.

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
