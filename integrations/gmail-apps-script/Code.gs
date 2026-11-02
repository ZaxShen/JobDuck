/**
 * Job Duck — Gmail Rejection Sync v5.2
 * Script v5.2 — serve-only: rejections are queued in the script and served to `jobduck sync` by the script deployed
 * as a web app. Nothing is pushed anywhere.
 *
 * Archives by allowlist, reading message bodies only. A thread whose every message is a plain application
 * confirmation (only acknowledgement sentences, no scheduling word, no personal note) gets "Job Duck/Applications"
 * and is archived. A rejection gets "Job Duck/Rejections" and is archived only when it is the latest job message and
 * every other message is a plain confirmation. Everything else gets "Job Duck/Interviews" and stays in the Inbox; a
 * thread with that label is never archived. Each rejection that stands becomes an outcome (header fields and a job
 * link/ID only; the email body never leaves Gmail) queued for the web app.
 *
 * Scope: the script only ever searches the Inbox (in:inbox), plus the "Job Duck/Applications" label when you run
 * previewReaudit/reauditApplications. A "Job Duck/Rejections" thread that is back in the Inbox because a new message
 * arrived is re-read: if the rejection still stands it is re-archived, otherwise it moves to "Job Duck/Interviews",
 * stays in the Inbox and its still-pending outcome is dropped.
 *
 * Setup:
 *   1. Run generateSyncToken and copy the logged token.
 *   2. Deploy → New deployment → Web app, Execute as Me, Who has access Anyone; copy the /exec URL.
 *   3. Put both into permissions.toml in your Job Duck home ([track] sync_url, sync_token).
 *   4. Run checkConnection, then preview, then install. Optional: backfill, previewReaudit, reauditApplications.
 * Optional properties: PROTECTED_LABELS and EXCLUDED_DOMAINS (comma-separated), KEEP_ACTION_MAIL_IN_INBOX=true.
 */

var SCRIPT_VERSION = '5.2';

var LABEL_PARENT = 'Job Duck';

var CONFIG = {
  JOB_LABEL: LABEL_PARENT + '/Applications',
  DENY_LABEL: LABEL_PARENT + '/Rejections',
  // Every job thread that is not plain application mail or a standing rejection; threads carrying it are never archived.
  INTERVIEW_LABEL: LABEL_PARENT + '/Interviews',
  // Labels from earlier versions, renamed by install() so existing threads keep their history.
  LEGACY_JOB_LABELS: ['Job Applications', 'JD - Job Applications'],
  LEGACY_DENY_LABELS: ['Deny Letters', 'JD - Deny Letters'],
  LEGACY_DROP_LABELS: ['JobDuck Sync', 'JobDuck Synced', 'JobDuck Review'],
  // Threads carrying any of these labels are left alone, e.g. ['Offers', 'Immigration'].
  // Also read from the script property PROTECTED_LABELS (comma-separated).
  PROTECTED_LABELS: [],
  // Senders from these domains are never sorted, e.g. ['lawfirm.example.com'].
  // Also read from the script property EXCLUDED_DOMAINS (comma-separated).
  EXCLUDED_DOMAINS: [],
  // Verification and security-code emails are labeled but stay in the Inbox when true. Interview mail always stays.
  // Also read from the script property KEEP_ACTION_MAIL_IN_INBOX ('true').
  KEEP_ACTION_MAIL_IN_INBOX: false,
  // Only rejections on/after this date are queued for jobduck sync.
  SYNC_SINCE: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  RUN_QUERY: 'in:inbox newer_than:3d',
  MAX_THREADS_PER_RUN: 100,
  TIME_BUDGET_MS: 4.5 * 60 * 1000
};

var LEGACY_PENDING_KEY = 'jobduckPendingThreads';
var LEGACY_DAILY_COUNT_PREFIX = 'jobduckSyncCount_';
var MAX_FIELD_LENGTH = 500;
var MAX_TITLE_LENGTH = 120;
var OUTCOME_PREFIX = 'outcome:';
var MAX_OUTCOMES = 1000;
var MAX_OUTCOME_TEXT = 200;
var APPLICATIONS_QUERY = 'label:"' + CONFIG.JOB_LABEL + '"';
var REAUDIT_PAGE = 50;

function install() {
  uninstall();
  migrateLabels_();
  clearPushQueue_();
  labels_();
  ScriptApp.newTrigger('run').timeBased().everyMinutes(10).create();
  Logger.log('Installed: run() every 10 minutes.');
}

function uninstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Uninstalled: the run() trigger is removed.');
}

function run() {
  var stats = { job: 0, deny: 0, interview: 0, kept: 0, skipped: 0 };
  var threads = GmailApp.search(CONFIG.RUN_QUERY, 0, CONFIG.MAX_THREADS_PER_RUN);
  threads.forEach(function (t) { tally_(stats, processThread_(t)); });
  if (stats.job || stats.deny || stats.interview) Logger.log(JSON.stringify(stats));
}

function checkConnection() {
  var props = PropertiesService.getScriptProperties();
  var hasSyncToken = !!props.getProperty('SYNC_TOKEN');
  Logger.log('Mode: serve (script v' + SCRIPT_VERSION + '). Pending outcomes: ' + pendingCount_() + '. SYNC_TOKEN is ' +
    (hasSyncToken ? 'set.' : 'not set — run generateSyncToken.'));
  if (props.getProperty('JOBDUCK_TOKEN')) {
    Logger.log('Push mode was removed in v5: the JOBDUCK_TOKEN script property is ignored and can be deleted.');
  }
}

function backfill() {
  var props = PropertiesService.getUserProperties();
  var start = Number(props.getProperty('backfillOffset') || 0);
  var began = Date.now();
  var stats = { job: 0, deny: 0, interview: 0, kept: 0, skipped: 0 };
  while (Date.now() - began < CONFIG.TIME_BUDGET_MS) {
    var threads = GmailApp.search('in:inbox', start, 100);
    if (!threads.length) {
      props.deleteProperty('backfillOffset');
      Logger.log('Backfill complete. ' + JSON.stringify(stats) + ' Run jobduck sync to fetch the queued rejections.');
      return;
    }
    threads.forEach(function (t) {
      var r = processThread_(t);
      tally_(stats, r);
      if (r !== 'job' && r !== 'deny') start++;
    });
    props.setProperty('backfillOffset', String(start));
  }
  Logger.log('Time budget used — run backfill() again to continue. So far: ' + JSON.stringify(stats));
}

function resetBackfill() { PropertiesService.getUserProperties().deleteProperty('backfillOffset'); }

function processThread_(thread) {
  var L = labels_();
  var rules = rules_();
  var userLabels = thread.getLabels().map(function (l) { return l.getName(); });
  if (userLabels.some(function (n) { return rules.protectedLabels.indexOf(n) >= 0; })) return 'skipped';
  var hasJob = userLabels.indexOf(CONFIG.JOB_LABEL) >= 0;
  var hasDeny = userLabels.indexOf(CONFIG.DENY_LABEL) >= 0;
  var hasInterview = userLabels.indexOf(CONFIG.INTERVIEW_LABEL) >= 0;
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var messages = thread.getMessages();
  var d = classifyThread_(messages, rules, me);
  if (d.action === 'skipped') return 'skipped';

  if (hasDeny && d.action !== 'interview') {
    if (!hasInterview) thread.moveToArchive();
    return 'skipped';
  }
  if (d.action === 'deny') {
    thread.addLabel(L.deny);
    if (hasJob) thread.removeLabel(L.job);
    if (d.message.getDate() >= CONFIG.SYNC_SINCE) recordRejection_(d.message);
    if (!hasInterview) thread.moveToArchive();
    return 'deny';
  }
  if (d.action === 'interview' || hasInterview) {
    if (!hasInterview) thread.addLabel(L.interview);
    if (hasJob) thread.removeLabel(L.job);
    if (hasDeny) {
      thread.removeLabel(L.deny);
      unqueueOutcomes_(messages);
      thread.moveToInbox();
    }
    return 'interview';
  }

  if (!hasJob) thread.addLabel(L.job);
  if (rules.keepActionMail && VERIFICATION_SUBJECT.test(messages[messages.length - 1].getSubject())) return 'kept';
  thread.moveToArchive();
  return 'job';
}

/** The allowlist decision for a thread, read from every message:
 *  { action: 'skipped' | 'deny' | 'interview' | 'job', reasons[], evidence, message }.
 *  'deny' only when the rejection is the latest job message, stands on its own and every other message is a plain
 *  application confirmation; 'job' only when every message is one; anything else is 'interview' (kept in the Inbox). */
function classifyThread_(messages, rules, me) {
  var notes = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var from = m.getFrom();
    var addr = ((from.match(/<([^>]+)>/) || [null, from])[1] || '').trim().toLowerCase();
    if (addr === me) return { action: 'skipped', reasons: ['your own message'] };
    var domain = addr.split('@')[1] || '';
    if (rules.excludedDomains.some(function (x) { return domain === x || domain.endsWith('.' + x); })) {
      return { action: 'skipped', reasons: ['excluded domain'] };
    }
    var subject = m.getSubject(), body = m.getPlainBody();
    var job = isJobEmail(from, subject, body);
    var deny = job && isRejection(subject, body);
    notes.push({ message: m, subject: subject, body: body, job: job, deny: deny, plain: job && !deny && plainConfirmation_(subject, body) });
  }
  var jobNotes = notes.filter(function (n) { return n.job; });
  if (!jobNotes.length) return { action: 'skipped', reasons: ['not job mail'] };
  var latest = jobNotes[jobNotes.length - 1];
  var others = notes.filter(function (n) { return n !== latest; });

  if (latest.deny) {
    var ds = denyScore(latest.subject, latest.body);
    var extra = others.filter(function (n) { return !n.plain; })[0];
    if (rejectionStands_(latest.body) && !extra) {
      return { action: 'deny', reasons: ds.reasons, evidence: ds.evidence, score: ds.score, message: latest.message };
    }
    if (extra) return keptFor_(extra, 'message besides the rejection');
    return { action: 'interview', reasons: ['rejection offers a conversation'], evidence: ds.evidence, message: latest.message };
  }
  var notPlain = notes.filter(function (n) { return !n.plain; })[0];
  if (notPlain) return keptFor_(notPlain, notPlain.deny ? 'rejection followed by another message' : null);
  return { action: 'job', reasons: ['plain application confirmation'], message: latest.message };
}

function keptFor_(note, why) {
  var iv = interviewScore(note.body);
  var word = String(note.body || '').match(SCHEDULING_WORDS);
  var reasons = why ? [why] : [];
  if (iv.interview) reasons = reasons.concat(iv.reasons);
  else if (word) reasons.push('scheduling word: ' + word[0]);
  else if (!why) reasons.push('not a plain application confirmation');
  var odd = iv.evidence || word ? null : unacknowledged_(note.body, VERIFICATION_SUBJECT.test(note.subject));
  return { action: 'interview', reasons: reasons, evidence: iv.evidence || odd || note.subject, message: note.message };
}

function rules_() {
  var props = PropertiesService.getScriptProperties();
  function list(key, base) {
    var extra = String(props.getProperty(key) || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return base.concat(extra);
  }
  return {
    protectedLabels: list('PROTECTED_LABELS', CONFIG.PROTECTED_LABELS),
    excludedDomains: list('EXCLUDED_DOMAINS', CONFIG.EXCLUDED_DOMAINS).map(function (d) { return d.toLowerCase(); }),
    keepActionMail: CONFIG.KEEP_ACTION_MAIL_IN_INBOX || /^(true|1|yes)$/i.test(String(props.getProperty('KEEP_ACTION_MAIL_IN_INBOX') || ''))
  };
}

function labels_() {
  return { job: label_(CONFIG.JOB_LABEL), deny: label_(CONFIG.DENY_LABEL), interview: label_(CONFIG.INTERVIEW_LABEL) };
}

/** Gmail creates the "Job Duck" parent on its own when a nested name is created or a label is renamed into it;
 *  creating the parent explicitly fails with "Label name exists or conflicts", so only the leaf is created. */
function label_(name) {
  var existing = GmailApp.getUserLabelByName(name);
  if (existing) return existing;
  try { return GmailApp.createLabel(name); }
  catch (e) {
    var again = GmailApp.getUserLabelByName(name);
    if (again) return again;
    throw e;
  }
}

/** One-time: rename the labels of earlier versions into the nested ones and drop the old bookkeeping labels.
 *  Threads keep every label they had. */
function migrateLabels_() {
  var byName = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) { byName[l.name] = l; });
  function rename(oldNames, newName) {
    oldNames.forEach(function (oldName) {
      var old = byName[oldName];
      if (!old) return;
      if (byName[newName]) {
        var target = GmailApp.getUserLabelByName(newName);
        var source = GmailApp.getUserLabelByName(oldName);
        var page;
        while ((page = source.getThreads(0, 100)).length) {
          target.addToThreads(page);
          source.removeFromThreads(page);
        }
        Gmail.Users.Labels.remove('me', old.id);
        Logger.log('Merged label "' + oldName + '" into "' + newName + '".');
      } else {
        Gmail.Users.Labels.patch({ name: newName }, 'me', old.id);
        byName[newName] = old;
        Logger.log('Renamed label "' + oldName + '" to "' + newName + '".');
      }
      delete byName[oldName];
    });
  }
  rename(CONFIG.LEGACY_JOB_LABELS, CONFIG.JOB_LABEL);
  rename(CONFIG.LEGACY_DENY_LABELS, CONFIG.DENY_LABEL);

  CONFIG.LEGACY_DROP_LABELS.forEach(function (name) {
    var label = GmailApp.getUserLabelByName(name);
    if (label) { label.deleteLabel(); Logger.log('Removed label "' + name + '".'); }
  });
}

/** One-time: delete the v3/v4 push-mode thread queue and daily counters from the user properties. */
function clearPushQueue_() {
  var props = PropertiesService.getUserProperties();
  props.getKeys().forEach(function (k) {
    if (k === LEGACY_PENDING_KEY || k.indexOf(LEGACY_DAILY_COUNT_PREFIX) === 0) props.deleteProperty(k);
  });
}

function tally_(stats, r) { stats[r] = (stats[r] || 0) + 1; }

function preview() {
  var jobs = 0, denies = 0, interviews = 0, start = 0, began = Date.now();
  var rules = rules_();
  var me = Session.getActiveUser().getEmail().toLowerCase();
  while (Date.now() - began < 4 * 60 * 1000) {
    var threads = GmailApp.search('in:inbox', start, 100);
    if (!threads.length) break;
    start += threads.length;
    threads.forEach(function (t) {
      var d = classifyThread_(t.getMessages(), rules, me);
      if (d.action === 'skipped') return;
      var line = d.message.getDate().toISOString().slice(0, 10) + ' | ' + d.message.getSubject() + '  <=  ' +
        d.reasons.join(' ') + ' | "' + String(d.evidence || '').slice(0, 90) + '"';
      if (d.action === 'deny') {
        denies++;
        Logger.log('DENY [' + d.score + '] ' + line);
        Logger.log('  would queue: ' + JSON.stringify(buildOutcome_(d.message)));
      } else if (d.action === 'interview') {
        interviews++;
        Logger.log('INTERVIEW ' + line);
      } else {
        jobs++;
      }
    });
  }
  Logger.log('Scanned ' + start + ' inbox threads: ' + denies + ' rejections, ' + interviews + ' interview emails, ' + jobs + ' other job emails.');
}

function previewReaudit() { reaudit_(false); }

function reauditApplications() { reaudit_(true); }

function resetReaudit() {
  var props = PropertiesService.getUserProperties();
  props.deleteProperty(reauditCursorKey_(true));
  props.deleteProperty(reauditCursorKey_(false));
}

function reauditCursorKey_(apply) { return apply ? 'reauditOffset' : 'previewReauditOffset'; }

/** Re-classifies every "Job Duck/Applications" thread, newest first, within the time budget, with the same thread
 *  rules as run(). apply=false only logs; apply=true relabels rejections (and queues them), moves every thread that
 *  is not plain application mail to "Job Duck/Interviews" and back to the Inbox, and drops non-application mail. */
function reaudit_(apply) {
  var name = apply ? 'reauditApplications' : 'previewReaudit';
  var props = PropertiesService.getUserProperties();
  var cursorKey = reauditCursorKey_(apply);
  var start = Number(props.getProperty(cursorKey) || 0);
  var began = Date.now();
  var L = apply ? labels_() : null;
  var rules = rules_();
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var stats = { rejection: 0, interview: 0, notJob: 0, kept: 0 };
  while (Date.now() - began < CONFIG.TIME_BUDGET_MS) {
    var threads = GmailApp.search(APPLICATIONS_QUERY, start, REAUDIT_PAGE);
    if (!threads.length) {
      props.deleteProperty(cursorKey);
      Logger.log(name + ' complete. ' + JSON.stringify(stats));
      return;
    }
    threads.forEach(function (t) {
      var d = reauditDecision_(t, rules, me);
      tally_(stats, d.action);
      if (d.action !== 'kept') {
        Logger.log((apply ? '' : 'would ') + d.action + ' | ' + d.date + ' | ' + d.subject + '  <=  ' + d.reasons.join(' '));
      }
      if (!apply || d.action === 'kept') { start++; return; }
      if (d.action === 'rejection') {
        t.addLabel(L.deny);
        t.removeLabel(L.job);
        recordRejection_(d.message);
      } else if (d.action === 'interview') {
        t.addLabel(L.interview);
        t.removeLabel(L.job);
        t.moveToInbox();
      } else {
        t.removeLabel(L.job);
      }
    });
    props.setProperty(cursorKey, String(start));
  }
  Logger.log('Time budget used — run ' + name + '() again to continue. So far: ' + JSON.stringify(stats));
}

function reauditDecision_(thread, rules, me) {
  var kept = { action: 'kept', reasons: [] };
  var names = thread.getLabels().map(function (l) { return l.getName(); });
  if (names.some(function (n) { return rules.protectedLabels.indexOf(n) >= 0; })) return kept;
  var messages = thread.getMessages(), last = messages[messages.length - 1];
  var from = last.getFrom();
  var sender = parseSender_(from);
  if (sender.email === me) return kept;
  var domain = sender.email.split('@')[1] || '';
  if (rules.excludedDomains.some(function (d) { return domain === d || domain.endsWith('.' + d); })) return kept;
  var subject = last.getSubject(), body = last.getPlainBody();
  var info = { message: last, subject: subject, date: last.getDate().toISOString().slice(0, 10) };
  var j = jobScore(from, subject, body);
  if (j.score < JOB_THRESHOLD && j.negative) {
    info.action = 'notJob';
    info.reasons = j.reasons;
    return info;
  }
  var d = classifyThread_(messages, rules, me);
  if (d.action !== 'deny' && d.action !== 'interview') return kept;
  info.action = d.action === 'deny' ? 'rejection' : 'interview';
  info.reasons = d.reasons;
  if (d.action === 'deny') info.message = d.message;
  return info;
}

function recordRejection_(message) {
  queueOutcome_(buildOutcome_(message));
}

/** Drops the still-pending outcomes of a thread whose rejection no longer stands. */
function unqueueOutcomes_(messages) {
  var store = outcomeStore_();
  messages.forEach(function (m) { store.deleteProperty(OUTCOME_PREFIX + outcomeId_(m)); });
}

function outcomeId_(message) {
  var messageId = message.getHeader('Message-ID');
  return messageId && messageId.length <= MAX_FIELD_LENGTH ? messageId : message.getId();
}

function buildOutcome_(message) {
  var p = buildPayload_(message);
  return {
    messageId: p.messageId,
    receivedAt: p.receivedAt,
    senderDomain: p.senderEmail ? (p.senderEmail.split('@')[1] || null) : null,
    subject: p.subject ? p.subject.slice(0, MAX_OUTCOME_TEXT) : null,
    company: p.company,
    title: p.title ? p.title.slice(0, MAX_OUTCOME_TEXT) : null,
    jobUrl: p.jobUrl,
    jobRef: p.jobRef,
    applicationId: p.application_id || null,
    jobId: p.job_id || null
  };
}

function outcomeStore_() { return PropertiesService.getScriptProperties(); }

function outcomeKeys_(all) {
  return Object.keys(all).filter(function (k) { return k.indexOf(OUTCOME_PREFIX) === 0; });
}

function pendingCount_() { return outcomeKeys_(outcomeStore_().getProperties()).length; }

/** Idempotent per messageId. Returns 'queued', 'exists' or 'full'. */
function queueOutcome_(outcome) {
  var store = outcomeStore_();
  var key = OUTCOME_PREFIX + outcome.messageId;
  if (store.getProperty(key) != null) return 'exists';
  var pending = pendingCount_();
  if (pending >= MAX_OUTCOMES) {
    Logger.log('Warning: ' + pending + ' outcomes are pending (limit ' + MAX_OUTCOMES + '); not queueing "' + outcome.subject +
      '". Run jobduck sync to drain the queue.');
    return 'full';
  }
  var value = {};
  ['messageId', 'receivedAt', 'senderDomain', 'subject', 'company', 'title', 'jobUrl', 'jobRef', 'applicationId', 'jobId']
    .forEach(function (f) { value[f] = outcome[f] === undefined ? null : outcome[f]; });
  if (value.subject) value.subject = String(value.subject).slice(0, MAX_OUTCOME_TEXT);
  if (value.title) value.title = String(value.title).slice(0, MAX_OUTCOME_TEXT);
  value.queuedAt = new Date().toISOString();
  store.setProperty(key, JSON.stringify(value));
  return 'queued';
}

function listOutcomes_() {
  var all = outcomeStore_().getProperties();
  var list = [];
  outcomeKeys_(all).forEach(function (k) {
    try { list.push(JSON.parse(all[k])); } catch (e) { Logger.log('Dropping unreadable outcome ' + k); }
  });
  return list.sort(function (a, b) { return String(a.receivedAt).localeCompare(String(b.receivedAt)); });
}

function ackOutcomes_(messageIds) {
  var store = outcomeStore_(), acked = 0;
  messageIds.forEach(function (id) {
    var key = OUTCOME_PREFIX + id;
    if (store.getProperty(key) == null) return;
    store.deleteProperty(key);
    acked++;
  });
  return acked;
}

function generateSyncToken() {
  var value = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('SYNC_TOKEN', value);
  Logger.log('SYNC_TOKEN (copy it into permissions.toml in your Job Duck home, [track] sync_token; any earlier token stops working): ' + value);
}

function doGet() {
  return ContentService.createTextOutput('Job Duck Gmail script v' + SCRIPT_VERSION + ' — POST only').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var request = {};
  try { request = JSON.parse((e && e.postData && e.postData.contents) || '{}') || {}; } catch (err) { request = {}; }
  if (!authorized_(request.token)) return json_({ ok: false, error: 'unauthorized' });
  if (request.action === 'pending') return json_({ ok: true, scriptVersion: SCRIPT_VERSION, outcomes: listOutcomes_() });
  if (request.action === 'ack' && Array.isArray(request.messageIds)) {
    var ids = request.messageIds.filter(function (id) { return typeof id === 'string' && id.length > 0; });
    return json_({ ok: true, acked: ackOutcomes_(ids) });
  }
  if (request.action === 'status') return json_({ ok: true, scriptVersion: SCRIPT_VERSION, mode: 'serve', pending: pendingCount_() });
  return json_({ ok: false, error: 'bad_request' });
}

function authorized_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!expected || typeof given !== 'string' || !given) return false;
  return constantTimeEqual_(String(expected), given);
}

function constantTimeEqual_(a, b) {
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function buildPayload_(message) {
  var subject = message.getSubject() || '';
  var head = String(message.getPlainBody() || '').slice(0, 3000);
  var sender = parseSender_(message.getFrom());
  var jobUrl = findJobUrl_(head);
  var payload = {
    messageId: outcomeId_(message),
    receivedAt: message.getDate().toISOString(),
    senderEmail: clip_(sender.email),
    senderName: clip_(sender.name),
    subject: clip_(subject),
    jobUrl: jobUrl,
    jobRef: jobRefFrom_(jobUrl, subject),
    company: guessCompany_(sender, subject, head),
    title: guessTitle_(subject, head)
  };
  var ids = threadIds_(message);
  if (ids.application_id) payload.application_id = ids.application_id;
  if (ids.job_id) payload.job_id = ids.job_id;
  return payload;
}

var THREAD_ID_MARKERS = { application_id: /JobDuck-Application-Id:\s*(\d+)/i, job_id: /JobDuck-Job-Id:\s*(\d+)/i };

function threadIds_(message) {
  var ids = {};
  var messages = message.getThread().getMessages();
  for (var i = 0; i < messages.length; i++) {
    var text = String(messages[i].getPlainBody() || '').slice(0, 3000);
    for (var key in THREAD_ID_MARKERS) {
      if (ids[key]) continue;
      var m = text.match(THREAD_ID_MARKERS[key]);
      if (m) ids[key] = m[1];
    }
  }
  return ids;
}

function clip_(value) {
  var s = String(value || '').trim();
  return s ? s.slice(0, MAX_FIELD_LENGTH) : null;
}

function parseSender_(from) {
  var raw = String(from || '');
  var angle = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (angle) return { name: angle[1].trim(), email: angle[2].trim().toLowerCase() };
  return { name: '', email: raw.trim().toLowerCase() };
}

var JOB_URL_HOST = /(^|\.)(greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com)$/i;
var CAREERS_HOST = /(^|\.)(careers?|jobs)\.|careers/i;
var CAREERS_JOB_PATH = /\/(jobs?|positions?|openings?|careers?)\/[^\/?#]+/i;

function findJobUrl_(text) {
  var urls = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  for (var i = 0; i < urls.length; i++) {
    var url = urls[i].replace(/[.,;:!?]+$/, '');
    var parts = url.match(/^https?:\/\/([^\/?#:]+)([^?#]*)/i);
    if (!parts || url.length > MAX_FIELD_LENGTH) continue;
    var host = parts[1], path = parts[2];
    if (JOB_URL_HOST.test(host)) return url;
    if (CAREERS_HOST.test(host) && CAREERS_JOB_PATH.test(path)) return url;
  }
  return null;
}

var SUBJECT_REF = /(?:JR|R|Req(?:uisition)?\s*#?)\s*([A-Z0-9-]{3,})/gi;

function jobRefFrom_(url, subject) {
  if (url) {
    var m = null;
    if (/greenhouse\.io/i.test(url)) m = url.match(/(?:\/jobs\/|gh_jid=)(\d+)/i);
    else if (/ashbyhq\.com/i.test(url)) m = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    else if (/myworkdayjobs\.com/i.test(url)) m = url.match(/[_\/-]((?:JR|R)\d+)(?=[-_\/?#]|$)/i);
    if (m) return m[1];
  }
  SUBJECT_REF.lastIndex = 0;
  var match;
  while ((match = SUBJECT_REF.exec(String(subject || ''))) !== null) {
    if (/\d/.test(match[1])) return match[1];
  }
  return null;
}

var TEAM_WORDS = /\b(recruiting|recruitment|talent(\s+acquisition)?|careers?|team|hiring)\b/i;
var GENERIC_SENDER = /^(no-?reply|notifications?|jobs?|hr|workday|greenhouse|lever|ashby|do not reply)$/i;
var NOT_A_COMPANY = /^(the|this|that|our|your|a|an|all|least|present|times?|large|scale|heart|home|work)\b/i;
var AT_COMPANY = /\bat\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/;
var COMPANY_RECRUITING = /\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:Recruiting|Talent|Careers)\b/;

function guessCompany_(sender, subject, head) {
  var name = String(sender.name || '').replace(/\s+via\s+.*$/i, '').trim();
  var at = name.match(AT_COMPANY);
  if (at) return cleanCompany_(at[1]);
  if (TEAM_WORDS.test(name)) {
    var stripped = cleanCompany_(name.replace(new RegExp(TEAM_WORDS.source, 'gi'), ''));
    if (stripped) return stripped;
  }
  var sources = [subject, head];
  for (var i = 0; i < sources.length; i++) {
    var m = String(sources[i] || '').match(AT_COMPANY) || String(sources[i] || '').match(COMPANY_RECRUITING);
    var company = m && cleanCompany_(m[1]);
    if (company) return company;
  }
  return null;
}

function cleanCompany_(value) {
  var s = String(value || '').replace(/[\s|:,.!-]+$/, '').replace(/^[\s|:,-]+/, '').trim();
  if (!s || s.length > 80 || GENERIC_SENDER.test(s) || NOT_A_COMPANY.test(s)) return null;
  return s;
}

var TITLE_PATTERNS = [
  /\bfor the ([^\n.!?]{3,120}?) (?:role|position)\b/i,
  /\byour application to (?:the )?([^\n.!?]{3,120}?) (?:role |position )?at\b/i,
  /\bapplication for (?:the )?([^\n.!?]{3,120}?)(?: (?:role|position))?(?=\s+at\b|\s*[-–|(,.!]|\s*$)/im
];

function guessTitle_(subject, head) {
  var sources = [subject, head];
  for (var s = 0; s < sources.length; s++) {
    for (var p = 0; p < TITLE_PATTERNS.length; p++) {
      var m = String(sources[s] || '').match(TITLE_PATTERNS[p]);
      if (m && !/\b(your|our|this|a position|the position)\b/i.test(m[1])) return m[1].trim().slice(0, MAX_TITLE_LENGTH);
    }
  }
  return null;
}

var JOB_THRESHOLD = 3;
var DENY_THRESHOLD = 2;
var MIN_PREFIX_LENGTH = 12;

var ATS_SENDER = /@([\w.-]*\.)?(greenhouse-mail\.io|greenhouse\.io|lever\.co|ashbyhq\.com|myworkday\.com|workday\.(?!com\b)[\w.]+|smartrecruiters\.com|icims\.com|jobvite\.com|gem\.com|eightfold\.ai|avature\.net|paylocity\.com|paycomonline\.com|taleo\.net|successfactors\.(com|eu)|oraclecloud\.com|breezy\.hr|recruitee\.com|workable(mail)?\.com|bamboohr\.com|applytojob\.com|rippling(mail)?\.com|dayforcehcm\.com|ultipro\.com|ukg\.com|teamtailor(-mail)?\.com|pinpointhq\.com|wellfound\.com)\b/i;
var JOB_SENDER_LOCAL = /^(no-?reply[-_.]?(recruiting|careers)?|careers?|jobs?|recruiting|recruitment|talent|hiring\w*|hr\.notifications|noreply-careers|do-?not-?reply|systemmessage)@/i;
var JOB_SUBJECT = /(thank(s| you)( so much)? for (applying|your (application|interest|submission))|thanks for applying|your application|application (update|status|received|confirmation|submitted|to )|we('ve| have) received your application|candidacy|following up on your .*application|update (on|regarding|about) (your|the) .*(application|role|position)|^update from \w|application confirmation|interest in (career|joining|working))/i;
var JOB_BODY = /(thank(s| you)[^.]{0,60}for (applying|your application|submitting your application|your interest in)|(received|reviewed|reviewing) your application|your application (for|to|as)\b|apply(ing)? (for|to) the [^.]{3,120} (role|position)|for the [^.]{3,120} (role|position)\b)/i;

// Kept in the inbox (still labeled) when KEEP_ACTION_MAIL_IN_INBOX is set, because a code expires.
var VERIFICATION_SUBJECT = /(security code|verification code|verify your (email|account)|one[- ]time (code|pass)|confirm your email)/i;

// Interview, assessment, scheduling and offer mail, read from the body only (the subject is never a signal).
// [reason, pattern] — any match in a sentence that is not boilerplate makes the email interview mail.
var INTERVIEW_SIGNALS = [
  ['interview invite', /\binvit(e|ed|es|ing|ation)\b[^.]{0,60}\binterview/i],
  ['interview invite', /\binterview (invitation|invite|request|kick-?off|confirmation|details|slot|loop)\b/i],
  ['interview kickoff', /\bkick(s|ing|ed)?[ -]?off (the|your|our) (interview|hiring|recruiting) process\b/i],
  ['schedule interview', /\b(schedul\w*|book\w*|set(ting)? up|arrang\w*|coordinat\w*|confirm\w*)\b[^.]{0,40}\b(interview|phone screen|screening call|technical screen|on-?site)\b/i],
  ['book a time', /\b(schedule|book|find|pick|choose|select|grab|set up) (a |an |some )?([\w-]+ ){0,2}?(time|slot|call|chat|meeting|conversation)\b(?![ -]?zones?\b)/i],
  ['availability', /\b(share|send|provide|let (me|us) know|reply with|what is|what's) (me |us )?(your |some )?(availability|available times|times that work)\b|\byour availability\b/i],
  ['screen', /\b(phone|technical|recruiter|initial|intro(ductory)?|video|virtual|hiring manager)[ -](screen|screening|interview|call)s?\b/i],
  ['next round', /\bnext (round|stage)\b|\b(final|second|third)[ -]round\b/i],
  ['onsite', /\b(virtual )?on-?site (interview|visit|round|loop|day)s?\b|\bvirtual on-?site\b|\bsuper ?day\b/i],
  ['offer', /\boffer letter\b|\b(pleased|happy|excited|delighted|thrilled) to (extend (you )?(an? |the )?(formal |verbal |written )?offer|offer you)\b|\b(verbal|formal|written) offer\b/i],
  ['questionnaire', /\bpre-?interview (questionnaire|survey|form)\b|\b(fill out|fill in|complete|answer|submit)\b[^.]{0,30}\bquestionnaire\b/i],
  ['background check', /\b(complete|authorize|consent to|start|initiate)\b[^.]{0,30}\bbackground (check|screening)\b/i],
  ['interview stage', /\b(mov(e|ed|ing)|advanc\w*|progress\w*|proceed\w*|invit\w*|selected|chosen|shortlisted)\b[^.]{0,40}\b(interview|interviewing) (stage|round|step|process|phase)\b/i],
  ['interview confirmed', /\b(your|the|our) (interview|phone screen|screening call|call|chat|meeting|on-?site)s? (is|are|has been|have been) (now )?(confirmed|scheduled|booked|set( up)?)\b/i]
];
var ASSESSMENT_WORD = /\b(assessment|coding (challenge|exercise|test|assignment)|take[- ]home|hackerrank|codesignal|codility|coderpad|online test|skills test|work sample)\b/i;
var ASSESSMENT_ACTION = /\b(complete|completing|take|finish|start|begin|submit|attempt|access|link|within \d+|due|deadline|invit\w*)\b/i;
var INTERVIEW_LINK = /https?:\/\/[^\s<>"')\]]*\b(calendly\.com|goodtime\.io|hackerrank\.com|codesignal\.com|codility\.com|coderpad\.io|testgorilla\.com)\b/i;
// Interview detection names why a thread stays in the Inbox; it never decides archiving, which is the plain-confirmation
// allowlist below. A sentence about a call, chat or interview is interview mail unless it is boilerplate.
// A direct offer to the candidate is an invite whatever condition precedes it ("If you have time this week, we would
// like to schedule a phone interview", "The hiring manager would like to speak with you").
var DIRECT_OFFERS = [
  /\b(we|i)((['’]d| would) (like|love)( for you)?|(['’]re|['’]m| are| am)( very| so)? (happy|pleased|excited|delighted|thrilled|keen|eager|glad)| (want|wish|hope)) to( \w+)?? ((schedule|set up|arrange|book|invite you|have you|move you|advance you|bring you)\b[^.?!]{0,40}?\b(interview|call|chat|meeting|conversation|screen(ing)?|on-?site|time|slot|discussion|assessment|round|next (step|round|stage))s?\b|(meet|chat|speak|talk|connect) (with )?you\b)/i,
  /\b((['’]d| would) (like|love)|wants?|hopes?|(is|are) (keen|eager|excited|happy)) to (meet|chat|speak|talk|connect|catch up) (with )?you\b|\blook(ing)? forward to (meeting|chatting|speaking|talking|connecting|catching up) (with )?you\b/i,
  /\b(like|love|happy|pleased|excited|delighted|thrilled|glad|want|wish|hope|decided|chosen|elected|going) to move (forward|ahead) with (you|your (candidacy|application|profile))\b|\b(will be|are|['’]re) (moving|going to move) (forward|ahead) with (you|your (candidacy|application|profile))\b/i,
  /\b(would|will|are|were) you (be )?(available|free|open)( for (a |an |the )?([\w-]+ ){0,3}?(interview|call|chat|meeting|conversation|screen(ing)?|on-?site|discussion|zoom|video)s?\b| to (talk|chat|speak|meet|connect|interview|jump on|hop on)\b| (this|next|on|tomorrow|today|at|between|sometime|any ?time|later)\b)/i,
  /\bwhen (are|would|will) you (be )?(available|free)\b|\bwhen you(['’]re| are| would be| will be) (available|free)\b|\bdo you have (some |any )?(time|availability) (this|next|on|for|to|in)\b/i,
  /\b(times?|slots?|days?|dates?|windows?)( that| which)? (work|works|suit|suits|fit|fits)( best)? (for|with) you\b|\bwhat (times?|days?|dates?) (work|works|would work|suit)\b/i,
  /\bplease (\w+ )?(share|send|provide|reply with|let (me|us) know|tell (me|us))\b[^.?!]{0,30}?\b(availability|(a|some|few|preferred|convenient|good|suitable|available) (times?|slots?|dates?|days?))\b/i,
  /\bplease (\w+ )?(book|schedule|select|pick|choose|grab)\b[^.?!]{0,30}?\b(interview|call|chat|meeting|screen|time|slot)s?\b(?![ -]?zones?\b)/i,
  /\binvit(e|ing) you (to|for)\b[^.?!]{0,40}?\b(interview|call|chat|meeting|conversation|screen(ing)?|on-?site|discussion|assessment|next (step|round|stage))s?\b/i
];
// A plain statement that the candidate has advanced, unless a condition comes before it.
var ADVANCED = /\b(you(['’]ve| have) been (selected|chosen|shortlisted|invited|advanced|moved)|we(['’]re| are|['’]ve| have)( \w+)? (moving|advancing|moved|advanced|inviting|selected|shortlisted) you)\b[^.?!]{0,40}?\b(interview|next (step|round|stage)|round|on-?site|screen)/i;
// Any other sentence about an interview, a call or a chat ("Here are the details for your upcoming interview",
// "The next step is a 30-minute call with our hiring manager") is interview mail unless it is boilerplate.
var INTERVIEW_TOPIC = /\b(interview\w*|calls?|chat|chatting|speak|speaking|talk|talking|meet|meeting|screen|screening|on-?site|rounds?|next steps?|availability|zoom)\b/i;

// Boilerplate that vetoes every signal except a direct offer: the applicant pool ("Applicants who move forward to the
// interview stage will be contacted"),
var APPLICANT_POOL = /\b(candidates|applicants|those)( who| that| whose| moving| advancing| progressing| selected| shortlisted| chosen)\b|\b(selected|qualified|shortlisted|successful|top) (candidates|applicants)\b/i;
// a step the employer only takes once it picks the candidate ("If your experience matches, we will reach out to
// schedule an interview", "If selected, you will be invited to an onsite interview"),
var EMPLOYER_CONDITION = /\b(if|when|once|should|in case|in the event( that)?|provided( that)?|assuming)\s+((we|our (\w+ )?team|the (\w+ )?team|the hiring manager) (decide|decides|choose|chooses|determine|determines|feel|feels|think|thinks|believe|believes|find|finds|see|sees|are interested|is interested|would like|wish|wishes|want|wants)\b|there(['’]s| is| are)\b|(you(['’]re| are| were| have been| get| are being) )?(selected|chosen|shortlisted|qualified|successful)\b|you (meet|match|fit|move forward|advance|progress|pass)\b|you(['’]re| are) (a )?(good |strong )?(match|fit)\b|(it['’]?s |this is )?a (good |strong )?(match|fit)\b)|\b(if|when|once|should)\b[^.?!]{0,60}?\byour (\w+ )?(experience|background|qualifications?|skills?|profile|application|resume|candidacy)( \w+){0,2}? (match|matches|align|aligns|fit|fits|meet|meets|is a (good |strong )?(fit|match)|are a (good |strong )?(fit|match))\b/i;
var EMPLOYER_STEP = /\b(will|['’]ll|would|may|might|can|could)\b[^.?!]{0,60}?\b(schedul\w*|invit\w*|arrang\w*|set up|book|ask(ed)?|move|advance|call|reach out|contact|be in touch|get in touch|follow up|let you know|notify|receive)\b/i;
// a possibility ("You may be asked to complete an assessment"),
var POSSIBILITY = /\b(may|might|could) (also )?(be )?(asked|invited|required|contacted|requested)\b/i;
// and a description of the process ("Our interview process consists of a phone screen and an onsite").
var PROCESS_DESCRIPTION = /\b(about|on) (our|the) (interview|hiring|recruiting|selection) process\b|\b(our|the|this|a typical) (interview|hiring|recruiting|selection) process\b[^.?!]{0,30}?\b(consists?|includes?|involves?|comprises?|is made up|typically|usually|generally|will (include|consist|involve))\b|\b(typically|usually|generally) (consists?|includes?|involves?)\b/i;
// Boilerplate that only vetoes the broad topic match, never an explicit invite or scheduling signal ("We are currently
// reviewing your application and would like to schedule a phone screen" is kept): review wording ("We will review
// your application") and a vague promise of future contact ("You will hear from us about the interview stage soon")
// that does not commit to scheduling the candidate's own interview ("Our recruiter will contact you to schedule your
// interview" is kept).
var REVIEW_ONLY = /\b(will|we'?ll) (review|be reviewing|carefully review)\b|\bcurrently reviewing\b|\bunder review\b/i;
var FUTURE_CONTACT = /\b(will|['’]ll|would|shall|may|might|can)( \w+){0,2}? (reach out|be reaching out|contact you|be contacted|be in touch|get in touch|hear from us|hear back|be notified|notify you|let you know|follow up|get back to you|receive (an? |further |more |another )?(e-?mail|message|call|invitation|invite|notification|update|follow-up))\b|\bhear from us\b|\bbe in touch\b/i;
var SCHEDULES_YOURS = /\b(schedul\w*|book\w*|set(ting)? up|arrang\w*|coordinat\w*|confirm\w*) (your|the|an?)( [\w-]+){0,2}? (interview|call|chat|screen(ing)?|on-?site|round|meeting|conversation)s?\b/i;

// "...we will be in touch if we would like to schedule an interview": the offer is itself the employer's condition.
var OFFER_AS_CONDITION = /\b(if|when|once|should|unless|whether|in case)(\s+[^\s,;:]+){0,3}\s*$/i;

function directOffer_(sentence) {
  var direct = DIRECT_OFFERS.some(function (re) {
    var m = re.exec(sentence);
    return m && !OFFER_AS_CONDITION.test(sentence.slice(0, m.index));
  });
  if (direct) return 'direct offer';
  var m = ADVANCED.exec(sentence);
  if (m && !CONDITIONAL.test(sentence.slice(0, m.index))) return 'moved forward';
  return null;
}

function boilerplate_(sentence) {
  return APPLICANT_POOL.test(sentence) || POSSIBILITY.test(sentence) || PROCESS_DESCRIPTION.test(sentence) ||
    (EMPLOYER_CONDITION.test(sentence) && EMPLOYER_STEP.test(sentence));
}

function vagueContact_(sentence) {
  return REVIEW_ONLY.test(sentence) || (FUTURE_CONTACT.test(sentence) && !SCHEDULES_YOURS.test(sentence));
}

/** Interview score over the body only: { interview, reasons[], evidence } */
function interviewScore(body) {
  var why = [], evidence = null;
  function add(reason, sentence) {
    if (why.indexOf(reason) >= 0) return;
    why.push(reason);
    if (!evidence) evidence = sentence;
  }
  splitSentences(body).forEach(function (sentence) {
    var offer = directOffer_(sentence);
    if (offer) add(offer, sentence);
    else if (boilerplate_(sentence)) return;
    var before = why.length;
    INTERVIEW_SIGNALS.forEach(function (sig) { if (sig[1].test(sentence)) add(sig[0], sentence); });
    if (ASSESSMENT_WORD.test(sentence) && ASSESSMENT_ACTION.test(sentence)) add('assessment', sentence);
    if (!offer && why.length === before && INTERVIEW_TOPIC.test(sentence) && !vagueContact_(sentence)) {
      add('about an interview', sentence);
    }
  });
  var link = String(body || '').match(INTERVIEW_LINK);
  if (link) why.push('link: ' + link[1]);
  return { interview: why.length > 0, reasons: why, evidence: evidence };
}

// The archive allowlist. A message is plain application mail only when its body confirms an application (or its
// subject is a verification code), it is not a rejection, it is not interview mail, it carries no scheduling word at
// all (boilerplate included), nobody writes in the first person, and every sentence left once the greeting, the
// sign-off with its signature and the standard footer are set aside is a known acknowledgement. Any other sentence
// ("Please complete your HireVue by Friday", "Reply with your free times") keeps its thread in the Inbox.
var CONFIRMATION = /\bthank(s| you)\b[^.!?]{0,60}\bfor (applying|submitting|your (application|interest|submission))\b|\b(received|receipt of) your application\b|\byour application\b[^.!?]{0,80}\b(has been|was|is|been) (successfully )?(received|submitted)\b|\bapplication (received|submitted|confirmation)\b/i;
var SCHEDULING_WORDS = /\b(interview\w*|calls?|called|calling|chat\w*|zoom|calendly|goodtime|calendar\w*|(re)?schedul\w*|availab(le|ility)|on-?site|screen\w*|next steps?|assessments?|meet|meeting|meetings|talk|talks|talking|speak\w*|conversations?|phone|video|rounds?|slots?|book|booked|booking|invit\w*|hackerrank|codesignal|codility|coderpad|testgorilla|hirevue|pymetrics|karat|spark ?hire|modern ?hire|harver|wonderlic|shl|ccat|criteria (corp|cognitive)|microsoft teams|teams (link|meeting|call|invite)|webex|bluejeans|gotomeeting|google meet|skype|whereby|take-?home|coding (challenge|exercise|test|assignment)|questionnaire|offers?|congratulat\w*|super ?day|hiring manager|background check|reference check|times? that works?|works? for you)\b|\b(can|could|would|will|are|do) you\b[^.!?]*\?/i;
var FIRST_PERSON = /\bI\b|\bI['’](m|ve|ll|d)\b|\b(me|my)\b|(^|[.!?]\s+)My\b/;

function plainConfirmation_(subject, body) {
  var text = String(body || '');
  var verification = VERIFICATION_SUBJECT.test(subject);
  if (!CONFIRMATION.test(text) && !verification) return false;
  if (SCHEDULING_WORDS.test(text) || FIRST_PERSON.test(text) || isInterview(text)) return false;
  return unacknowledged_(text, verification) === null;
}

// Words that never belong to a role or company name, a greeting name or a signature line: an action, a time or a
// deadline, a pronoun, a conjunction or a task. A name holding one ("Acme and please complete your HireVue") is no
// name, so the sentence matches no acknowledgement.
var ACK_VETO = "please|kindly|complete\\w*|finish\\w*|start\\w*|begin\\w*|join\\w*|click\\w*|tap|repl\\w*|respond\\w*|submit\\w*|confirm\\w*|select\\w*|choose|pick|book\\w*|upload\\w*|sign\\w*|record\\w*|take|taking|attend\\w*|send|share|provide|fill|follow|log|login|verify|accept|decline|rsvp|review\\w*|continue|access|open|go|get|use|visit|check|view|track|download|install|prepare|practice|need\\w*|requir\\w*|action|must|should|can|could|would|will|may|might|shall|is|are|was|were|be|been|has|have|had|do|does|did|links?|below|above|attached|here|there|now|deadline|due|by|before|within|until|after|asap|urgent|today|tomorrow|tonight|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|jan|january|feb|february|mar|march|apr|april|june?|july?|aug|august|sept?|september|oct|october|nov|november|dec|december|am|pm|noon|midnight|morning|afternoon|evening|weeks?|weekend|days?|hours?|minutes?|times?|dates?|you|your|yours|we|us|our|i|me|my|tests?|games?|sessions?|tasks?|exercises?|challenges?|quiz|survey|form|questionnaire|portal|answers?|questions?|free|and|or|but|so|then|also|to|if|when|once|while|not|no|yes|thanks?|congrats|reminder|important|ready|pending|waiting|steps?|stages?|requested|expir\\w*|last|final|chance|immediately";
// A role or company name ("the Backend Engineer role at Acme"): up to ten words with no digit and no veto word,
// captured so its length (at most 60) is checked.
var ACK_NAME = "((?:(?!(?:" + ACK_VETO + ")\\b)[a-z&'()/+#.-]+(?![a-z&'()/+#.-])(?: (?=[a-z&'()/+#.-]))?){1,10})";
var ACK_ROLE = '(?:the |our |a |an |this )?' + ACK_NAME;
var ACK_FOR_ROLE = '(?: (?:to|for|with|at|on|in) ' + ACK_ROLE + ')?';
var ACK_TEAM = '(?:(?:the|our) )?(?:(?:recruiting|recruitment|hiring|talent(?: acquisition)?|people|hr|human resources|selection|search) )?team';
var ACK_WHO = '(?:we|' + ACK_TEAM + '(?: members?)?|(?:our|the|a) (?:recruiters?|talent acquisition specialists?)|(?:a |one of the |one of our )?members? of ' + ACK_TEAM + '|someone (?:from|on) ' + ACK_TEAM + ')';
var ACK_DOCS = '(?:application|qualifications|background|experience|profile|resume|cv|submission|materials|candidacy|skills)';
var ACK_WHEN = '(?:soon|shortly|directly|again|either way|accordingly|carefully|thoroughly|closely|promptly|now|right away|with care|in detail|as soon as possible|in the (?:coming|next few|near) (?:days|weeks|future)|over the (?:coming|next few) (?:days|weeks)|within (?:the next )?(?:a few|two|three|several) (?:days|weeks)|as soon as (?:we can|we have an update|a decision (?:has been|is) made)|once (?:we(?:\'ve| have) (?:reviewed|completed|finished)(?: (?:our|the|your) (?:review|application)(?: process)?)?|our review is complete|a decision (?:has been|is) made)|after (?:we review|reviewing|our review of) (?:your application|it))';
var ACK_TAIL = '(?:,? ' + ACK_WHEN + '){0,2}';
var ACK_IF = '(?:if|should|when|in case|once)(?: (?:there is|there\'s|we (?:find|see|identify|have)) (?:a |an )?(?:(?:good|strong|potential|mutual|suitable) )?(?:match|fit|opening)' +
  '| your ' + ACK_DOCS + '(?:,? (?:and|or) (?:your )?' + ACK_DOCS + ')? (?:match(?:es)?|aligns?(?: with)?|fits?|meets?|(?:is|are|seems?|looks?)(?: like)? (?:a )?(?:(?:good|strong|great) )?(?:match|fit))(?: (?:for|with|to))?(?: (?:our|the|this) (?:needs|requirements|role|position|opening|team|qualifications)(?: (?:for|of) (?:the|this|our) (?:role|position|opening|team))?)?' +
  '| you(?:\'re| are)(?: not)? (?:selected|chosen|shortlisted|a (?:good |strong )?(?:fit|match))' +
  '| we (?:decide|choose|wish|want) (?:not )?to (?:move forward|proceed)(?: with your (?:application|candidacy))?' +
  '| (?:it\'s|it is) a (?:good |strong )?(?:fit|match)| a decision (?:has been|is) made| we have (?:an update|any updates|news))';
var ACK_PORTAL = '(?:your|our|the) (?:candidate |applicant |careers? |job seeker )?(?:portal|account|profile|dashboard|home|site)';
var ACK_STATUS = '(?:the status of your application|your application(?:\'s)?(?: status)?|the progress of your application)';
var ACK_CLAUSES = [
  // Thank you for applying to the Backend Engineer role at Acme / for your interest in a career with Acme
  '(?:thank you|thanks|many thanks)(?: so much| very much)?(?: again)?,? for (?:(?:applying|your (?:recent |online |job )?(?:application|submission)|submitting (?:your|an|the) application|taking the time to apply|the time to apply)' + ACK_FOR_ROLE +
    '|your interest(?: in (?:joining |working (?:at|with|for) |(?:a career|a position|a role|employment|opportunities|career opportunities) (?:at|with) )?(?:us|our team|' + ACK_ROLE + '))?)',
  // We have received your application for the Backend Engineer role / This email confirms receipt of your application
  '(?:(?:this (?:e-?mail|message|note) (?:is to )?)?confirms? (?:that )?|(?:this is to )?confirm(?:ing)? (?:that )?|we(?:\'d| would)? (?:(?:just )?(?:want|wanted|like|are writing)(?: to)? )?(?:let you know|confirm|acknowledge)(?: that)? )?(?:we(?:\'ve| have)?(?: successfully| now| already| just)? received|we are in receipt of|(?:the )?receipt of) (?:your|the) (?:job |online |recent )?(?:application|submission|resume|cv|materials)' + ACK_FOR_ROLE,
  // Your application for the Backend Engineer role has been received
  'your (?:job |online |recent )?(?:application|submission|resume|cv)' + ACK_FOR_ROLE + ' (?:has been|was|is|have been)(?: successfully)? (?:received|submitted)(?: successfully)?(?: (?:to|by) ' + ACK_ROLE + ')?',
  '(?:your )?application (?:received|submitted|confirmation|confirmed)',
  // Our team will review your application carefully / the team is reviewing it now
  '(?:' + ACK_WHO + ' )?(?:(?:will|\'ll|shall|are going to|is going to)(?: now)?(?: carefully| thoroughly| closely| personally)? (?:review|be reviewing|consider|assess|evaluate|look (?:over|at|through)|read)|(?:is|are)(?: now| currently)?(?: carefully)? (?:reviewing|considering|evaluating|looking (?:over|at|through)|reading)) (?:it|them|your ' + ACK_DOCS + '(?:(?:,|,? and) (?:your )?' + ACK_DOCS + '){0,3})(?: (?:for|against) ' + ACK_ROLE + ')?' + ACK_TAIL,
  // Your application will be reviewed by our recruiting team
  'your (?:application|resume|profile|submission|candidacy)' + ACK_FOR_ROLE + ' (?:will be|is being|is (?:now |currently )?being|is (?:now |currently )?under|has been (?:forwarded|passed|sent) to ' + ACK_TEAM + ' for)(?: carefully)? (?:reviewed|considered|review|consideration|evaluated)(?: by ' + ACK_TEAM + ')?' + ACK_TAIL,
  // (If your experience matches,) we will be in touch / contact you / get back to you (if there is a match)
  '(?:' + ACK_IF + ',? )?(?:(?:' + ACK_WHO + ' )?(?:will|\'ll|shall)(?: be sure to| certainly| definitely)? )?(?:be in touch|get in touch|be in contact|contact you|reach out(?: to you)?|be reaching out(?: to you)?|get back to you|follow up(?: with you)?|let you know|notify you|update you|be contacting you|be back in touch)(?: with you)?(?: (?:with|about|regarding|on) (?:an update|any updates|updates|the outcome|our decision|a decision|the status of your application|your application(?: status)?))?' + ACK_TAIL + '(?:,? ' + ACK_IF + ')?',
  // You will hear from us (if there is a match)
  '(?:' + ACK_IF + ',? )?you(?:\'ll| will)(?: be sure to)? (?:hear (?:back )?from us|hear back|be contacted|be notified|receive (?:an update|a response|a decision|further information))(?: (?:by|from) (?:a member of )?' + ACK_TEAM + ')?' + ACK_TAIL + '(?:,? ' + ACK_IF + ')?',
  // You can track the status of your application in your candidate portal
  'you (?:can|may)(?: also)? (?:view|track|check|monitor|see|follow) ' + ACK_STATUS + '(?: at any time| anytime)?(?:,? (?:by (?:logging|signing) in(?:to| to)?|in|on|through|via|from|at) ' + ACK_PORTAL + ')?(?: at any time| anytime)?(?:(?::| here:?| at:?) URL)?',
  'to (?:view|track|check|monitor|see) ' + ACK_STATUS + ',? (?:please )?(?:log|sign) in(?:to| to)? ' + ACK_PORTAL + '(?:(?::| here:?| at:?) URL)?',
  // We appreciate your interest / are excited that you applied / wish you luck
  '(?:we )?(?:truly |really |sincerely |greatly |do )?appreciate (?:your interest(?: in (?:joining |working (?:at|with|for) |(?:a career|employment|opportunities) (?:at|with) )?(?:us|our team|' + ACK_ROLE + '))?|(?:you |your )?taking the time to apply' + ACK_FOR_ROLE + '|the time you (?:took|have taken|spent) (?:to apply|applying|on your application))',
  'we(?:\'re| are) (?:so |very |really )?(?:excited|thrilled|delighted|glad|happy|pleased)(?: that)? (?:you(?:\'re| are) interested in|you(?: would)? (?:consider(?:ed)?|are considering)|you (?:applied|chose to apply)(?: (?:to|for))?|to (?:learn of|hear about|see|receive|have received) your (?:interest|application)(?: in| for| to)?)(?: (?:joining|working (?:at|with|for)))?(?: (?:us|our team|' + ACK_ROLE + '))?',
  '(?:we )?(?:wish(?:ing)? you|good luck|best of luck)(?: (?:the (?:very )?best(?: of luck)?|all the best|good luck|luck|success|the best of success|every success))?(?: (?:in|with|on) your (?:job |career )?(?:search|career|future endeavou?rs))?',
  '(?:thank you|thanks)(?: again)?(?: for your (?:time|patience|interest))?',
  // We can't respond to every applicant individually, so please know that we read each one
  '(?:(?:unfortunately|please note(?: that)?|due to (?:the )?(?:high|large) (?:volume|number) of (?:applications|applicants|candidates)(?: we receive)?),? )?(?:we )?(?:can\'t|cannot|can not|are unable to|aren\'t able to|are not able to|may not be able to|won\'t be able to|do not|don\'t) (?:respond|reply) (?:individually |personally )?to (?:every|each|all)(?: (?:applicant|application|candidate|submission)s?)?(?: (?:individually|personally))?',
  '(?:please know|rest assured) (?:that )?we (?:read|review|consider|look at) (?:each|every|all)(?: (?:one|application|applicant|submission)s?)?(?: (?:carefully|personally|we receive))?',
  '(?:only )?(?:shortlisted|selected|successful) (?:candidates|applicants) will be (?:contacted|notified)',
  'if you have (?:any )?(?:questions|concerns)(?: (?:about|regarding) (?:your application|the process|this (?:e-?mail|message)))?(?: in the meantime)?,? (?:please )?(?:feel free to )?(?:contact|e-?mail|reach out to|write to) (?:us|' + ACK_TEAM + ')(?: at EMAIL)?'
];
// Verification-code mail (subject "Your verification code") may also say what the code is for.
var ACK_VERIFY_CLAUSES = [
  '(?:your|the|here is your|here\'s your|use this|use the following) (?:verification|security|one[- ]time|confirmation|access) (?:code|passcode|pin)(?: is)?:? [a-z0-9-]{4,12}',
  '[a-z0-9-]{4,12} is your (?:verification|security|one[- ]time) (?:code|passcode)',
  'enter (?:it|this code|the code(?: above)?)(?: (?:on|in) the (?:verification|sign[- ]in|login) (?:page|screen))? to (?:continue|verify(?: your (?:e-?mail|account|identity))?|confirm your e-?mail|finish signing in|sign in|log in|proceed)(?: (?:with )?your application' + ACK_FOR_ROLE + ')?',
  '(?:this|the) code (?:will )?expires? in [a-z0-9]{1,3} (?:minutes|hours)',
  'if you did(?:n\'t| not) request (?:this|a)(?: (?:code|e-?mail))?,? (?:please )?(?:ignore|disregard) this (?:e-?mail|message)'
];
function ackSentence_(clauses) {
  var clause = '(?:' + clauses.join('|') + ')';
  var lead = '(?:(?:again|once again|also|additionally|in addition|in the meantime|meanwhile|unfortunately|please note(?: that)?),? )?';
  return new RegExp('^' + lead + clause + '(?:(?:,? and|,? but|,? so|;|,) ' + lead + clause + '){0,3}$', 'i');
}
var ACKNOWLEDGEMENT = ackSentence_(ACK_CLAUSES);
var VERIFICATION_ACKNOWLEDGEMENT = ackSentence_(ACK_CLAUSES.concat(ACK_VERIFY_CLAUSES));

var GREETING_NAME = "(?: (?:[A-Z][A-Za-z'.-]*|there|all|team|candidate|applicant)){0,4}";
var GREETING_LINE = new RegExp('^(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Gg]reetings|HI|HELLO|DEAR)' + GREETING_NAME + ' ?[,!:.]?$');
var GREETING_PREFIX = new RegExp('^(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Gg]reetings)' + GREETING_NAME + ', ');
var SIGN_OFF = /^(?:best|best regards|kind regards|warm regards|warmest regards|regards|warmly|sincerely|sincerely yours|yours sincerely|yours truly|respectfully|cheers|all the best|best wishes|many thanks|thanks|thank you|thanks again|thank you again|with appreciation|with gratitude)(?:\s*[,.!]\s*|\s*$)/i;
var SIGNATURE_LINE = /^(?:[Tt]he )?[A-Z][A-Za-z'&.()-]*(?:(?: | ?[|,\/–—-] ?)(?:[A-Z][A-Za-z'&.()-]*|of|the|at|for|&)){0,7}\.?$/;
var ACK_VETO_WORD = new RegExp('\\b(?:' + ACK_VETO + ')\\b', 'i');
// Standard footer clauses. A sentence is set aside as footer only when the whole of it is one of these clauses, or a
// few of them joined by a comma, semicolon or "and"/"as"/"so": anything else in it ("This message was sent by the
// CTO, who loved your profile") makes it an ordinary sentence that must be a known acknowledgement. Names in them
// are capitalised words with no digit and no action, time or deadline word.
var FOOTER_ATS = '(?:greenhouse|lever|workday|ashby|icims|smart ?recruiters|jobvite|taleo|bamboo ?hr|workable|jazz ?hr|breezy(?: ?hr)?|recruitee|teamtailor|rippling|gem|paylocity|ukg|(?:sap )?successfactors|oracle(?: recruiting cloud| taleo)?)(?:\\.(?:io|com|co))?';
var FOOTER_NAME = "([a-z&'().-]+(?: [a-z&'().-]+){0,5})";
var FOOTER_NAME_SHAPE = /^(?:the )?[A-Z][A-Za-z&'().-]*(?: (?:[A-Z][A-Za-z&'().-]*|of|&)){0,5}$/;
var FOOTER_MAIL = '(?:e-?mail|message|notification)';
var FOOTER_LINK = '(?:(?::| here:?| at:?)? URL)?';
var FOOTER_ITEM = '(?:unsubscribe(?: here)?|privacy (?:policy|notice|statement)|terms(?: of (?:use|service))?|(?:manage|update|change) (?:your )?(?:e-?mail |notification |communication )?(?:preferences|settings|subscriptions)|e-?mail preferences)' + FOOTER_LINK;
var FOOTER_STOP = '(?:these|this|all|future|our) (?:e-?mails|messages|notifications|communications|mailing list|list)';
var FOOTER_EEO_ITEM = '(?:race|colou?r|religion|creed|sex|gender|gender identity(?: (?:or|and|and/or) expression)?|gender expression|sexual orientation|national origin|ancestry|age|(?:physical or mental )?disability(?: status)?|(?:protected )?veteran status|military(?: or veteran)? status|marital status|genetic information|pregnancy|citizenship(?: status)?|(?:or )?any other (?:characteristic|status|basis) protected by (?:applicable |federal, state,? (?:or|and) local )?law|(?:any )?other (?:legally )?protected (?:characteristics?|status))';
var FOOTER_EEO_LIST = FOOTER_EEO_ITEM + '(?:(?:,|,? or|,? and|,? and/or|/) ' + FOOTER_EEO_ITEM + '){0,25}';
var FOOTER_STREET = '(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|plaza|parkway|pkwy|court|ct|place|pl|square|sq|highway|hwy|circle|cir)';
var FOOTER_CITY = "(?:[a-z.'-]+ ){0,3}[a-z.'-]+, [a-z]{2}(?: \\d{5}(?:-\\d{4})?)?(?:,? (?:usa|united states))?";
var FOOTER_CLAUSES = [
  // Do not reply / unattended mailbox / automated message
  '(?:please )?(?:do not|don\'t|kindly do not) (?:reply|respond)(?: directly)?(?: to (?:this|the|it|this ' + FOOTER_MAIL + ')(?: address)?)?',
  '(?:this|the) ' + FOOTER_MAIL + ' (?:is|was|has been) (?:sent|generated|delivered) (?:from|by) an? (?:unattended|unmonitored|automated|send-only|no-?reply|system)(?: (?:mailbox|e-?mail address|address|account|inbox|system))?',
  '(?:this|the) ' + FOOTER_MAIL + ' (?:is|was|has been) (?:automatically|system|auto)[ -]generated',
  '(?:this|the|our) (?:e-?mail address|mailbox|inbox|address|account) (?:is not|isn\'t) (?:monitored|checked)|(?:this|the|our) (?:e-?mail address|mailbox|inbox|address|account) is (?:unmonitored|unattended)',
  'replies (?:to this (?:e-?mail|message|address) )?(?:will not|won\'t|are not|cannot|can not|will never) (?:be )?(?:read|monitored|received|answered|seen|reviewed)',
  'this is an? (?:automated|automatic|system-generated|auto-generated|automatically generated) ' + FOOTER_MAIL + '(?: from ' + FOOTER_ATS + ')?',
  // Sent by / powered by an ATS
  '(?:(?:this|the) ' + FOOTER_MAIL + ' (?:was|is|has been) )?(?:sent|powered|delivered|generated) (?:by|via|with|through|from|using) (?:the )?' + FOOTER_ATS + '(?: (?:platform|system))?(?: on behalf of ' + FOOTER_NAME + ')?',
  // Unsubscribe, manage preferences, privacy policy
  FOOTER_ITEM + '(?: ?[|·•,] ?' + FOOTER_ITEM + '){0,5}',
  '(?:to|if you(?:\'d| would)? (?:no longer )?(?:wish|want|like) to) (?:unsubscribe|stop receiving (?:these|such|future) (?:e-?mails|messages|notifications))(?: from ' + FOOTER_STOP + ')?,? (?:please )?(?:click (?:here|the link below|URL)|visit URL|go to URL|URL)',
  'click (?:here|URL) to (?:unsubscribe|manage (?:your )?(?:e-?mail )?(?:preferences|subscriptions))(?: from ' + FOOTER_STOP + ')?',
  'you (?:can|may) unsubscribe(?: from ' + FOOTER_STOP + ')?(?: at any time)?(?: (?:here|URL))?',
  '(?:(?:to learn more|for (?:more )?information|for details) (?:about|on) how (?:we|' + FOOTER_NAME + ') (?:collects?|uses?|processes|handles?|protects?)(?:(?:,| and|,? and) (?:collects?|uses?|processes|handles?|protects?)){0,3} your (?:personal )?(?:data|information),? )?(?:please )?(?:see|read|review|visit|refer to|view) (?:our|the) (?:candidate |applicant )?privacy (?:policy|notice|statement)' + FOOTER_LINK,
  // Equal opportunity
  '(?:we|' + FOOTER_NAME + ') (?:is|are) (?:proud to be )?an? (?:proud )?equal (?:employment )?opportunity(?: and affirmative action)? employer(?:,? (?:m/f/d/v|minorities/females/veterans/disabled|minorities/women/veterans/disabled))?',
  '(?:an? )?equal (?:employment )?opportunity(?: and affirmative action)? employer|eoe|eeo',
  'all qualified applicants will receive consideration for employment without regard to ' + FOOTER_EEO_LIST,
  '(?:(?:we|' + FOOTER_NAME + ') )?(?:does not|do not|will not) discriminate (?:against any (?:applicant|employee) )?(?:on the basis of|based on|because of) ' + FOOTER_EEO_LIST,
  // Mailing address
  '(?:' + FOOTER_NAME + '(?:,| ·| \\|) )?\\d{1,6} (?:[a-z0-9.\'-]+ ){1,5}' + FOOTER_STREET + '\\.?(?:,? (?:suite|ste|floor|fl|unit|room|rm)\\.? ?#?[a-z0-9-]{1,6}|,? #[a-z0-9-]{1,6})?(?:(?:,| ·| \\|) ' + FOOTER_CITY + ')?',
  '(?:suite|ste|floor|fl|unit) #?[a-z0-9-]{1,6}(?:(?:,| ·| \\|) ' + FOOTER_CITY + ')?',
  "(?:[a-z.'-]+ ){0,3}[a-z.'-]+, [a-z]{2} \\d{5}(?:-\\d{4})?(?:,? (?:usa|united states))?",
  // Copyright
  '(?:copyright(?: ©| \\(c\\))?|©|\\(c\\)) ?(?:\\d{4}(?: ?[-–] ?\\d{4})?,? ?)?(?:' + FOOTER_NAME + '(?:,? (?:inc|llc|ltd|corp|co|gmbh|plc)\\.?)?)?(?:,? all rights reserved)?',
  'all rights reserved',
  // Confidentiality notice
  '(?:this|the information in this) (?:e-?mail|message|communication|transmission)(?:,? (?:and|including|together with) any (?:attachments|files transmitted with it)(?: (?:to|with) it)?,?)? (?:is|are|may be|may contain information that is|contains information that (?:is|may be)) (?:strictly )?(?:confidential|privileged|proprietary)(?:(?:,| and|,? and/or|,? or) (?:legally )?(?:confidential|privileged|proprietary)){0,2},? and (?:(?:is|are) )?intended (?:solely|only|exclusively) for (?:the use of )?the (?:addressee|recipient|individual|person|entity|intended recipient)(?:\\(s\\)|s)?(?: (?:or|and) (?:entity|entities))?(?: (?:to whom|to which) (?:it is|they are) addressed| named above)?',
  'if you are not the intended recipient(?:,? (?:please )?notify the sender(?: immediately)?(?: and delete (?:it|this ' + FOOTER_MAIL + ')(?: from your system)?)?)?',
  'if you (?:have )?received this ' + FOOTER_MAIL + ' (?:in error|by mistake),? (?:please )?notify the sender(?: immediately)?(?: and delete (?:it|this ' + FOOTER_MAIL + ')(?: from your system)?)?'
];
var FOOTER_CLAUSE = new RegExp('^(?:(?:please note|note|important)[:,]? )?(?:' + FOOTER_CLAUSES.join('|') + ')$', 'i');
var FOOTER_JOIN = /[,;:]? (?:and|as|because|since|so) |[,;:] /g;

function footerClause_(clause) {
  var m = FOOTER_CLAUSE.exec(clause);
  return !!m && m.slice(1).every(function (g) {
    return !g || (g.length <= 60 && FOOTER_NAME_SHAPE.test(g) && !ACK_VETO_WORD.test(g));
  });
}

function footerClauses_(text, depth) {
  if (footerClause_(text)) return true;
  if (depth >= 3) return false;
  var join = new RegExp(FOOTER_JOIN.source, 'g'), m;
  while ((m = join.exec(text))) {
    if (footerClause_(text.slice(0, m.index)) && footerClauses_(text.slice(m.index + m[0].length), depth + 1)) return true;
  }
  return false;
}

/** True when the whole sentence is a standard footer. */
function footer_(sentence) {
  var s = String(sentence).replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
  return !!s && s.length <= 400 && footerClauses_(s, 0);
}

function greetingName_(greeting) {
  return !ACK_VETO_WORD.test(greeting.replace(/^\w+|\b(there|all|team|candidate|applicant)\b/gi, ''));
}

function signatureLine_(line) { return SIGNATURE_LINE.test(line) && !ACK_VETO_WORD.test(line) && !/\b(URL|EMAIL)\b/.test(line); }

/** The first body sentence that is not a known acknowledgement once the greeting, the sign-off with its signature
 *  and the footer are set aside, or null when every sentence is one. */
function unacknowledged_(body, verification) {
  var text = String(body || '').replace(/\r/g, '').replace(/&nbsp;| /g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1 URL')
    .replace(/<?(?:https?:\/\/|www\.)[^\s>]*[^\s>.,;:!?)]>?/gi, ' URL ')
    .replace(/<?[\w.+-]+@[\w-]+(?:\.[\w-]+)+>?/g, ' EMAIL ');
  var lines = text.split('\n').map(function (l) { return l.replace(/\s+/g, ' ').replace(/^(?:[*•·>-]+ ?)+/, '').trim(); });
  var footerLine = lines.map(function (l) { return !!l && lineSentences_(l).every(footer_); });
  var drop = footerLine.slice();
  var i, j, signedOff = false, greeted = false;
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || drop[i]) continue;
    if (!greeted) {
      greeted = true;
      if (GREETING_LINE.test(line) && greetingName_(line)) { drop[i] = true; continue; }
    }
    var off = SIGN_OFF.exec(line);
    if (off && (off[0].length === line.length || signatureLine_(line.slice(off[0].length)))) {
      signedOff = true;
      drop[i] = true;
      for (j = i + 1; j < lines.length && !lines[j]; j++);
      for (; j < lines.length && lines[j] && signatureLine_(lines[j]); j++) drop[j] = true;
    }
  }
  // Without a sign-off, only the one unbroken block of signature lines that ends the body is a signature.
  for (i = lines.length - 1; i >= 0 && !lines[i]; i--);
  for (; !signedOff && i >= 0 && lines[i]; i--) {
    if (footerLine[i]) continue;
    if (!signatureLine_(lines[i])) break;
    drop[i] = true;
  }
  var paragraphs = [], current = [];
  lines.forEach(function (l, k) {
    if (!l || drop[k]) { if (current.length) paragraphs.push(current.join(' ')); current = []; return; }
    current.push(l);
  });
  if (current.length) paragraphs.push(current.join(' '));
  var re = verification ? VERIFICATION_ACKNOWLEDGEMENT : ACKNOWLEDGEMENT;
  for (var p = 0; p < paragraphs.length; p++) {
    var sentences = lineSentences_(paragraphs[p]);
    for (var s = 0; s < sentences.length; s++) {
      if (!footer_(sentences[s]) &&!acknowledges_(re, sentences[s])) return sentences[s];
    }
  }
  return null;
}

function lineSentences_(text) {
  var out = [];
  String(text).split(/(?<=[.!?])\s+(?=\S)/).forEach(function (piece) {
    if (out.length && /\b(mr|mrs|ms|dr|sr|jr|st|prof|e\.g|i\.e|vs)\.$/i.test(out[out.length - 1])) out[out.length - 1] += ' ' + piece;
    else out.push(piece);
  });
  return out.map(function (x) { return x.trim(); }).filter(Boolean);
}

function acknowledges_(re, sentence) {
  var greeting = GREETING_PREFIX.exec(sentence);
  var s = (greeting && greetingName_(greeting[0]) ? sentence.slice(greeting[0].length) : sentence)
    .replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
  if (!s) return true;
  if (s.length > 300) return false;
  var m = re.exec(s);
  return !!m && m.slice(1).every(function (g) { return !g || g.length <= 60; });
}

// Text from the first of these onward is hypothetical ("If you are not selected...") and is ignored.
var CONDITIONAL = /\b(if|when|whenever|once|before|until|should (you|things)|in case|whether|unless|in the event)\b/i;

// [weight, pattern] — each signal counts at most once per email.
var DENY_SIGNALS = [
  // strong: explicit decision (+2)
  [2, /\bnot (to )?(be )?(mov(e|ing)|proceed(ing)?|progress(ing)?|advanc(e|ing)|continu(e|ing))\b[^.]{0,50}\b(forward|further|ahead|with your|your (application|candidacy)|in the process|to (an|the next) )/i],
  [2, /\b(decided|decision|chosen|chose|elected|opted|aligned|determined)\b[^.]{0,80}\b(move|moving|proceed|proceeding|go|going|pursue|pursuing|continue|continuing|advance)\b[^.]{0,40}\b(other|another|different|a smaller|alternative|a finalist)\b/i],
  [2, /\b(mov(e|ed|ing)|proceed(ed|ing)?|go(ing)?) (forward |ahead )?with (other|another|a smaller|different|a different)\b/i],
  [2, /\b(regret|sorry|unfortunate) to (inform|say|let you know|share|tell|advise)/i],
  [2, /\b(you |application )?(have|has|were|was|are) not (been )?(selected|chosen|successful|shortlisted)\b(?! (a|an|the|any|your|one)\b)|\bdid not select you\b/i],
  [2, /\b(considering|identified|selected|pursuing|chosen|prioritiz(e|ed|ing)) (other|another|different) candidates?\b/i],
  [2, /\b(candidates?|applicants?|profiles?|backgrounds?|qualifications?|experience)\b[^.]{0,80}\b(more closely|better) (align(s|ed)?|match(es|ed)?|fit(s)?)\b|\b(more closely|better) (align(s|ed)?|match(es|ed)?|fit(s)?)\b[^.]{0,80}\b(candidates?|applicants?|profiles?|backgrounds?|qualifications?|experience)\b/i],
  [2, /\b(isn'?t|is not|aren'?t|are not|wasn'?t|was not) (quite |currently |the right |a strong |a good |an ideal )?(a )?(match|fit)\b/i],
  [2, /\bunable to (find|identify) (a )?(good |strong |suitable )?(match|fit|position|role)\b/i],
  [2, /\b(do not|don'?t) (currently )?have (a|an|any) (position|role|opening)[^.]{0,40}(match|fit|align)/i],
  [2, /\b(won'?t|will not|would not|wouldn'?t) be (moving|proceeding|progressing|advancing|continuing)\b/i],
  [2, /\b(no longer|not) (reviewing|considering|accepting) (applicants|applications|candidates)\b/i],
  [2, /\b(decided|chosen|elected) to (close|cancel|pause|pull) (the|this) (role|position|requisition|req|opening)\b/i],
  [2, /\b(don'?t|do not) (believe|think|feel) [^.]{0,40}(right|good|strong) (fit|match)\b/i],
  [2, /\b(chosen|decided|elected|opted|going) to (move|proceed|go) (forward |ahead )?with (other |another |different |the |a )?candidates?\b/i],
  [2, /\bunable to (move forward|proceed|offer|advance)|\b(will not|won'?t|cannot|can'?t) (be )?(moving|proceeding|progressing|move forward|advance|pursue)/i],
  // definitive closure (+2)
  [2, /\b(position|role|opening|opportunity|requisition|req|job|seat)\b[^.]{0,100}\b(has been|have been|was|is|been|recently|has|is now|now been) (filled|closed|cancel+ed|put on hold)\b|\b(we'?ve|we have|we) (now |recently |already |just )?(filled|closed|hired someone for) (the|this|that) (position|role|opening|req)|\b(position|role|opening|opportunity|requisition|req|job)\b[^.]{0,60}\bno longer (available|open)\b|\bno longer (hiring|accepting|considering|recruiting|being considered)\b|\bdecided not to fill\b/i],
  // medium (+1)
  [1, /\bunfortunately\b/i],
  [1, /\b(not|isn'?t|aren'?t) (a|the right|the best|an?|an ideal) (strong )?(match|fit)\b|\bdon'?t have a match\b|\bdidn'?t align\b/i],
  // soft context (+1)
  [1, /\bwish(ing)? you (the )?(very )?(best|all the best|luck|success|every success|well)\b/i],
  [1, /\b(future|other|new) (opportunities|openings|roles|positions)\b|\bkeep (your|you)\b[^.]{0,40}\b(on file|in mind)\b|\btalent (community|network)\b|\bencourage you to (apply|continue|keep|explore|visit|check)/i],
  [1, /\b(difficult|tough) (decision|choices)|\bnot the news\b|\b(many|large number of|high volume of) (highly )?(qualified|talented|strong|exceptional) (applicants|candidates|applications)/i]
];
var DENY_SUBJECT = /\b(update|status|regarding your application|following up|candidacy)\b/i;
// Confirmation language pulls the score down (−2 each, counted once).
var CONFIRM_SIGNALS = [
  /\b(received your application|your application (has been|was|is) received|application has been submitted|confirm(ing)? (receipt|that we))/i,
  /\b(will|we'?ll) (review|be reviewing|carefully review)\b|\bcurrently reviewing\b|\bbe in touch\b|\breach out( to you)?( soon)? if\b/i
];

function splitSentences(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\r/g, '')
    .split(/\n\s*\n+/)                                            // paragraphs
    .map(function (p) { return p.replace(/\s*\n\s*/g, ' '); })    // re-join hard-wrapped lines
    .join('\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

/** Job-email score: { score, reasons[] } */
var RECRUITER_SUBJECT = /\b(immediate need|w2 only|c2c|corp to corp|hot requirement|urgent requirement|contract position)\b/i;
var RECRUITER_PITCH = /^\s*(hi|hello|dear)\b[^\n]{0,40}\n+[^\n]{0,200}\b(i am|i'm|this is) [^.\n]{0,80}\b(recruiter|staffing|talent acquisition)\b[^.\n]{0,120}\b(my (client|customer)|our client|an? (immediate|urgent|contract)|requirement)\b/i;

function jobScore(from, subject, body) {
  var addr = (String(from).match(/<([^>]+)>/) || [null, String(from)])[1].trim();
  var head = String(body || '').slice(0, 2000), s = 0, why = [], contentScore = 0;
  if (ATS_SENDER.test(addr)) { s += 3; why.push('ATS sender'); }
  if (JOB_SUBJECT.test(subject)) { s += 2; contentScore += 2; why.push('job subject'); }
  if (JOB_BODY.test(head)) { s += 2; contentScore += 2; why.push('job body'); }
  if (JOB_SENDER_LOCAL.test(addr)) { s += 1; why.push('careers sender'); }
  if (/\b(application|applying|applied)\b/i.test(head) && /\b(role|position|candidate|recruit|talent|hiring)\b/i.test(head)) { s += 1; contentScore += 1; why.push('app+role words'); }
  if (!ATS_SENDER.test(addr) && (RECRUITER_SUBJECT.test(subject) || RECRUITER_PITCH.test(head))) { s -= 3; why.push('recruiter pitch'); }
  var negative = notApplicationMail_(subject, body);
  if (negative) {
    s -= 3 + contentScore;
    why = why.filter(function (r) { return CONTENT_REASONS.indexOf(r) < 0; });
    why.push('not application mail: ' + negative);
  }
  return { score: s, reasons: why, negative: negative };
}

// Account and marketing mail from ATS senders, checked on the subject and the first 400 characters (−3, and the
// application wording it contains does not count toward the job score).
var NOT_APPLICATION_MAIL = [
  ['job alert', /\bjob alerts?\b/i],
  ['new jobs for you', /\bnew jobs for you\b/i],
  ['recommended jobs', /\brecommended jobs\b/i],
  ['referral', /\brefer a friend\b|\breferral\b/i],
  ['self-identification', /\bself[- ]?identif/i],
  ['unfinished application', /\bcomplete your application\b|\byou started an application\b|\bunfinished application\b/i]
];
var ACCOUNT_MAIL = /\bpassword reset\b|\breset your password\b|\bverification code\b/i;
var APPLICATION_WORDS = /\b(application|applying|applied|candidacy)\b/i;
var CONTENT_REASONS = ['job subject', 'job body', 'app+role words'];

function notApplicationMail_(subject, body) {
  var text = String(subject || '') + '\n' + String(body || '').slice(0, 400);
  for (var i = 0; i < NOT_APPLICATION_MAIL.length; i++) {
    if (NOT_APPLICATION_MAIL[i][1].test(text)) return NOT_APPLICATION_MAIL[i][0];
  }
  if (ACCOUNT_MAIL.test(text) && !APPLICATION_WORDS.test(text)) return 'password reset / verification code';
  return null;
}

// Scheduling news, not a decision: "we regret to inform you that we need to reschedule your interview", "you cannot
// move forward to the onsite until you complete the assessment".
var NOT_A_DECISION = /\b(reschedul\w*|postpon\w*)\b|\b(cannot|can['’]?t|unable to|will not be able to|won['’]t be able to)\b[^.?!]{0,60}\b(until|unless|without|before)\b/i;

/** Deny score over the unconditional part of each sentence: { score, reasons[], evidence, strong } */
function denyScore(subject, body) {
  var sentences = splitSentences(body).filter(function (x) { return !NOT_A_DECISION.test(x); }).map(function (x) {
    var m = CONDITIONAL.exec(x);
    return m ? x.slice(0, m.index) : x;
  }).filter(function (x) { return x.length >= MIN_PREFIX_LENGTH; });
  var text = sentences.join(' \n ');
  var s = 0, why = [], evidence = null, strong = false;
  DENY_SIGNALS.forEach(function (sig, i) {
    for (var k = 0; k < sentences.length; k++) {
      if (sig[1].test(sentences[k])) {
        s += sig[0]; why.push('+' + sig[0] + ' #' + i);
        if (sig[0] >= 2) strong = true;
        if (!evidence && sig[0] >= 2) evidence = sentences[k];
        break;
      }
    }
  });
  if (DENY_SUBJECT.test(subject)) { s += 1; why.push('+1 subject'); }
  CONFIRM_SIGNALS.forEach(function (re) { if (re.test(text)) { s -= 2; why.push('-2 confirmation'); } });
  return { score: s, reasons: why, evidence: evidence, strong: strong };
}

function isJobEmail(from, subject, body) { return jobScore(from, subject, body).score >= JOB_THRESHOLD; }
function isRejection(subject, body) {
  var d = denyScore(subject, body);
  return d.score >= DENY_THRESHOLD && d.strong;
}
function isInterview(body) { return interviewScore(body).interview; }

// A rejection that also offers a forward-looking conversation ("we're not moving forward for this role, but we'd like
// to schedule a call about another team") is interview mail. Only a direct offer counts, never the broad interview
// wording, so "thank you for taking the time to interview with us" stays a rejection, and so does a courtesy offer
// to keep in touch about the future.
var FUTURE_ONLY = /\b(in the future|future (opportunities|roles|openings|positions)|(keep|stay) (in touch|connected)|talent (community|network|pool)|down the (road|line))\b/i;

function rejectionStands_(body) {
  return !splitSentences(body).some(function (sentence) { return directOffer_(sentence) && !FUTURE_ONLY.test(sentence); });
}
