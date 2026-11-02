/**
 * Job Duck — Gmail Rejection Sync v5.2
 * Script v5.2 — serve-only: rejections are queued in the script and served to `jobduck sync` by the script deployed
 * as a web app. Nothing is pushed anywhere.
 *
 * Moves job-application mail out of the Inbox into the nested label "Job Duck/Applications" and rejections
 * into "Job Duck/Rejections". Interview, assessment, scheduling and offer mail, detected from the message body, gets
 * "Job Duck/Interviews" and is never archived. Each rejection becomes an outcome (header fields and a job link/ID
 * only; the email body never leaves Gmail) queued for the web app.
 *
 * Scope: the script only ever searches the Inbox (in:inbox), plus the "Job Duck/Applications" label when you run
 * previewReaudit/reauditApplications. Threads already labeled "Job Duck/Rejections" are never re-read or re-labeled;
 * a thread that is back in the Inbox because a new message arrived is re-archived only, unless it also carries
 * "Job Duck/Interviews".
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
  // Interview, assessment, scheduling and offer mail; threads carrying it are never archived.
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
  var hasInterview = userLabels.indexOf(CONFIG.INTERVIEW_LABEL) >= 0;
  if (userLabels.indexOf(CONFIG.DENY_LABEL) >= 0) {
    if (!hasInterview) thread.moveToArchive();
    return 'skipped';
  }

  var me = Session.getActiveUser().getEmail().toLowerCase();
  var messages = thread.getMessages();
  var jobMsgs = [], denyMsgs = [];

  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var from = m.getFrom();
    var addr = ((from.match(/<([^>]+)>/) || [null, from])[1] || '').trim().toLowerCase();
    if (addr === me) return 'skipped';
    var domain = addr.split('@')[1] || '';
    if (rules.excludedDomains.some(function (d) { return domain === d || domain.endsWith('.' + d); })) return 'skipped';

    var subject = m.getSubject(), body = m.getPlainBody();
    if (!isJobEmail(from, subject, body)) continue;
    jobMsgs.push(m);
    if (isRejection(subject, body)) denyMsgs.push(m);
  }
  if (!jobMsgs.length) return 'skipped';

  var last = messages[messages.length - 1];
  var overruled = false;
  if (denyMsgs.length) {
    var latestDeny = denyMsgs[denyMsgs.length - 1];
    overruled = !rejectionStands_(latestDeny.getPlainBody()) ||
      jobMsgs.slice(jobMsgs.indexOf(latestDeny) + 1).some(function (m) { return isInterview(m.getPlainBody()); });
    if (!overruled) {
      thread.addLabel(L.deny);
      if (hasJob) thread.removeLabel(L.job);
      if (latestDeny.getDate() >= CONFIG.SYNC_SINCE) recordRejection_(latestDeny);
      if (!hasInterview) thread.moveToArchive();
      return 'deny';
    }
  }

  if (overruled || hasInterview || isInterview(jobMsgs[jobMsgs.length - 1].getPlainBody())) {
    if (!hasInterview) thread.addLabel(L.interview);
    if (hasJob) thread.removeLabel(L.job);
    return 'interview';
  }

  if (!hasJob) thread.addLabel(L.job);
  if (rules.keepActionMail && VERIFICATION_SUBJECT.test(last.getSubject())) return 'kept';
  thread.moveToArchive();
  return 'job';
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
  while (Date.now() - began < 4 * 60 * 1000) {
    var threads = GmailApp.search('in:inbox', start, 100);
    if (!threads.length) break;
    start += threads.length;
    threads.forEach(function (t) {
      var msgs = t.getMessages(), last = msgs[msgs.length - 1];
      var subj = last.getSubject(), body = last.getPlainBody();
      var j = jobScore(last.getFrom(), subj, body);
      if (j.score < JOB_THRESHOLD) return;
      var d = denyScore(subj, body);
      if (d.score >= DENY_THRESHOLD && d.strong && rejectionStands_(body)) {
        denies++;
        Logger.log('DENY [' + d.score + '] ' + last.getDate().toISOString().slice(0, 10) + ' | ' + subj + '  <=  ' + d.reasons.join(' ') + ' | "' + String(d.evidence || '').slice(0, 90) + '"');
        Logger.log('  would queue: ' + JSON.stringify(buildOutcome_(last)));
        return;
      }
      var iv = interviewScore(body);
      if (iv.interview) {
        interviews++;
        Logger.log('INTERVIEW ' + last.getDate().toISOString().slice(0, 10) + ' | ' + subj + '  <=  ' + iv.reasons.join(' ') + ' | "' + String(iv.evidence || '').slice(0, 90) + '"');
        return;
      }
      jobs++;
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

/** Re-classifies the latest message of every "Job Duck/Applications" thread, newest first, within the time budget.
 *  apply=false only logs; apply=true relabels rejections (and queues them), moves interview mail to
 *  "Job Duck/Interviews" and back to the Inbox, and drops non-application mail. */
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
  if (j.score < JOB_THRESHOLD) {
    if (!j.negative) return kept;
    info.action = 'notJob';
    info.reasons = j.reasons;
    return info;
  }
  var d = denyScore(subject, body);
  if (d.score >= DENY_THRESHOLD && d.strong && rejectionStands_(body)) {
    info.action = 'rejection';
    info.reasons = d.reasons;
    return info;
  }
  var iv = interviewScore(body);
  if (iv.interview) {
    info.action = 'interview';
    info.reasons = iv.reasons;
    return info;
  }
  return kept;
}

function recordRejection_(message) {
  queueOutcome_(buildOutcome_(message));
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
  var messageId = message.getHeader('Message-ID');
  var jobUrl = findJobUrl_(head);
  var payload = {
    messageId: messageId && messageId.length <= MAX_FIELD_LENGTH ? messageId : message.getId(),
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
// Fail-safe: a real invite must never be archived, so a sentence about a call, chat or interview aimed at the candidate
// is interview mail, and only applicant-pool, employer-conditional, review or process boilerplate is set aside.
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
// Any other sentence about the candidate's interview, a call or a chat ("Here are the details for your upcoming
// interview", "Can you do a call on Tuesday?") is interview mail unless it is boilerplate.
var INTERVIEW_TOPIC = /\b(interview\w*|calls?|chat|chatting|speak|speaking|talk|talking|meet|meeting|screen|screening|on-?site|rounds?|next steps?|availability)\b/i;
var AIMED_AT_YOU = /\b(you|your|yours)\b/i;

// Boilerplate, the only thing the archive may swallow: the applicant pool ("Applicants who move forward to the
// interview stage will be contacted"),
var APPLICANT_POOL = /\b(candidates|applicants|those)( who| that| whose| moving| advancing| progressing| selected| shortlisted| chosen)\b|\b(selected|qualified|shortlisted|successful|top) (candidates|applicants)\b/i;
// a step the employer only takes once it picks the candidate ("If your experience matches, we will reach out to
// schedule an interview", "If selected, you will be invited to an onsite interview"),
var EMPLOYER_CONDITION = /\b(if|when|once|should|in case|in the event( that)?|provided( that)?|assuming)\s+((we|our (\w+ )?team|the (\w+ )?team|the hiring manager) (decide|decides|choose|chooses|determine|determines|feel|feels|think|thinks|believe|believes|find|finds|see|sees|are interested|is interested|would like|wish|wishes|want|wants)\b|there(['’]s| is| are)\b|(you(['’]re| are| were| have been| get| are being) )?(selected|chosen|shortlisted|qualified|successful)\b|you (meet|match|fit|move forward|advance|progress|pass)\b|you(['’]re| are) (a )?(good |strong )?(match|fit)\b|(it['’]?s |this is )?a (good |strong )?(match|fit)\b)|\b(if|when|once|should)\b[^.?!]{0,60}?\byour (\w+ )?(experience|background|qualifications?|skills?|profile|application|resume|candidacy)( \w+){0,2}? (match|matches|align|aligns|fit|fits|meet|meets|is a (good |strong )?(fit|match)|are a (good |strong )?(fit|match))\b/i;
var EMPLOYER_STEP = /\b(will|['’]ll|would|may|might|can|could)\b[^.?!]{0,60}?\b(schedul\w*|invit\w*|arrang\w*|set up|book|ask(ed)?|move|advance|call|reach out|contact|be in touch|get in touch|follow up|let you know|notify|receive)\b/i;
// review or possibility boilerplate ("We will review your application", "You may be asked to complete an assessment"),
var REVIEW_ONLY = /\b(may|might|could) (also )?(be )?(asked|invited|required|contacted|requested)\b|\b(will|we'?ll) (review|be reviewing|carefully review)\b|\bcurrently reviewing\b|\bunder review\b/i;
// a description of the process ("Our interview process consists of a phone screen and an onsite"),
var PROCESS_DESCRIPTION = /\b(about|on) (our|the) (interview|hiring|recruiting|selection) process\b|\b(our|the|this|a typical) (interview|hiring|recruiting|selection) process\b[^.?!]{0,30}?\b(consists?|includes?|involves?|comprises?|is made up|typically|usually|generally|will (include|consist|involve))\b|\b(typically|usually|generally) (consists?|includes?|involves?)\b/i;
// and a vague promise of future contact ("You will hear from us about the interview stage soon") that does not commit
// to scheduling the candidate's own interview ("Our recruiter will contact you to schedule your interview" is kept).
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
  return APPLICANT_POOL.test(sentence) || REVIEW_ONLY.test(sentence) || PROCESS_DESCRIPTION.test(sentence) ||
    (EMPLOYER_CONDITION.test(sentence) && EMPLOYER_STEP.test(sentence)) ||
    (FUTURE_CONTACT.test(sentence) && !SCHEDULES_YOURS.test(sentence));
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
    if (!offer && why.length === before && INTERVIEW_TOPIC.test(sentence) && AIMED_AT_YOU.test(sentence)) {
      add('about your interview', sentence);
    }
  });
  var link = String(body || '').match(INTERVIEW_LINK);
  if (link) why.push('link: ' + link[1]);
  return { interview: why.length > 0, reasons: why, evidence: evidence };
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
