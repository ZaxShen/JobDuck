/**
 * Job Duck — Gmail Rejection Sync v4
 * Script v4 — serves rejections to `jobduck sync` as a web app (serve mode); with JOBDUCK_TOKEN set it still pushes
 * them to Job Duck Applications v3 (push mode, inbound API v1: /api/inbound/ping, /api/inbound/rejections).
 *
 * Moves job-application mail out of the Inbox into the nested label "Job Duck/Applications" and rejections
 * into "Job Duck/Rejections". Each rejection becomes an outcome (header fields and a job link/ID only; the email
 * body never leaves Gmail) that is either queued for the web app (serve) or posted to Job Duck (push).
 *
 * Scope: the script only ever searches the Inbox (in:inbox), plus the "Job Duck/Applications" label when you run
 * previewReaudit/reauditApplications. Threads already labeled "Job Duck/Rejections" are never re-read or re-labeled;
 * a thread that is back in the Inbox because a new message arrived is re-archived only.
 *
 * Setup (serve mode):
 *   1. Run generateSyncToken and copy the logged token.
 *   2. Deploy → New deployment → Web app, Execute as Me, Who has access Anyone; copy the /exec URL.
 *   3. Put both into permissions.toml in your Job Duck home ([track] sync_url, sync_token).
 *   4. Run checkConnection, then preview, then install. Optional: backfill, previewReaudit, reauditApplications.
 * Push mode (legacy): add the script property JOBDUCK_TOKEN (Job Duck → Settings → API tokens) instead.
 * Optional properties: PROTECTED_LABELS and EXCLUDED_DOMAINS (comma-separated), KEEP_ACTION_MAIL_IN_INBOX=true.
 */

var SCRIPT_VERSION = '4';
var COMPATIBLE_WITH = 'Job Duck Applications v3';
var INBOUND_API_VERSION = '1';

var LABEL_PARENT = 'Job Duck';

var CONFIG = {
  JOB_LABEL: LABEL_PARENT + '/Applications',
  DENY_LABEL: LABEL_PARENT + '/Rejections',
  // Labels from earlier versions, renamed by install() so existing threads keep their history.
  LEGACY_JOB_LABELS: ['Job Applications', 'JD - Job Applications'],
  LEGACY_DENY_LABELS: ['Deny Letters', 'JD - Deny Letters'],
  LEGACY_SYNC_LABEL: 'JobDuck Sync',
  LEGACY_DROP_LABELS: ['JobDuck Synced', 'JobDuck Review'],
  // Threads carrying any of these labels are left alone, e.g. ['Offers', 'Immigration'].
  // Also read from the script property PROTECTED_LABELS (comma-separated).
  PROTECTED_LABELS: [],
  // Senders from these domains are never sorted, e.g. ['lawfirm.example.com'].
  // Also read from the script property EXCLUDED_DOMAINS (comma-separated).
  EXCLUDED_DOMAINS: [],
  // Interview, assessment and verification-code emails are labeled but stay in the Inbox when true.
  // Also read from the script property KEEP_ACTION_MAIL_IN_INBOX ('true').
  KEEP_ACTION_MAIL_IN_INBOX: false,
  // Only rejections on/after this date are sent to Job Duck.
  SYNC_SINCE: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  RUN_QUERY: 'in:inbox newer_than:3d',
  MAX_THREADS_PER_RUN: 100,
  MAX_SYNC_PER_RUN: 15,
  MAX_SYNC_PER_DAY: 90,
  MAX_PENDING: 400,
  TIME_BUDGET_MS: 4.5 * 60 * 1000
};

var DEFAULT_JOBDUCK_URL = 'https://jobduck.work';
var MISSING_TOKEN_MESSAGE = 'Add JOBDUCK_TOKEN in Project Settings → Script properties';
var DAILY_COUNT_PREFIX = 'jobduckSyncCount_';
var PENDING_KEY = 'jobduckPendingThreads';
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
  var session = syncMode_() === 'push' ? syncSession_() : null;
  var stats = { job: 0, deny: 0, kept: 0, skipped: 0 };
  var threads = GmailApp.search(CONFIG.RUN_QUERY, 0, CONFIG.MAX_THREADS_PER_RUN);
  threads.forEach(function (t) { tally_(stats, processThread_(t, session)); });
  if (session) drainPending_(session);
  if (stats.job || stats.deny) Logger.log(JSON.stringify(stats));
  if (session && session.calls) Logger.log('Job Duck sync: ' + JSON.stringify(session.stats));
}

function syncPending() {
  if (syncMode_() === 'serve') {
    Logger.log('Serve mode: ' + pendingCount_() + ' outcomes pending for jobduck sync.');
    return;
  }
  var session = syncSession_();
  if (!session) return;
  drainPending_(session);
  var left = pendingThreads_().length;
  Logger.log('Job Duck sync: ' + JSON.stringify(session.stats) + (left ? ' — ' + left + ' still pending; run syncPending() again later.' : ' — nothing pending.'));
}

function syncMode_() { return token_() ? 'push' : 'serve'; }

function checkConnection() {
  if (syncMode_() === 'serve') {
    var hasSyncToken = !!PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
    Logger.log('Mode: serve (script v' + SCRIPT_VERSION + '). Pending outcomes: ' + pendingCount_() + '. SYNC_TOKEN is ' +
      (hasSyncToken ? 'set.' : 'not set — run generateSyncToken.'));
    return;
  }
  var token = token_();
  if (!token) { Logger.log(MISSING_TOKEN_MESSAGE); return; }
  var url = baseUrl_() + '/api/inbound/ping';
  try {
    var res = UrlFetchApp.fetch(url, { headers: headers_(token), muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code === 200) Logger.log('Connected as ' + JSON.parse(res.getContentText()).email + ' (script v' + SCRIPT_VERSION + ', ' + COMPATIBLE_WITH + ')');
    else if (code === 401 || code === 403) Logger.log('Token rejected (HTTP ' + code + '). It was revoked or expired: create a new one in Job Duck → Settings → API tokens and replace JOBDUCK_TOKEN.');
    else Logger.log('Connection failed (HTTP ' + code + '): ' + res.getContentText().slice(0, 200));
  } catch (e) {
    Logger.log('Could not reach ' + url + ': ' + e.message);
  }
}

function backfill() {
  var props = PropertiesService.getUserProperties();
  var start = Number(props.getProperty('backfillOffset') || 0);
  var began = Date.now();
  var stats = { job: 0, deny: 0, kept: 0, skipped: 0 };
  while (Date.now() - began < CONFIG.TIME_BUDGET_MS) {
    var threads = GmailApp.search('in:inbox', start, 100);
    if (!threads.length) {
      props.deleteProperty('backfillOffset');
      Logger.log('Backfill complete. ' + JSON.stringify(stats) + ' Run syncPending() to send rejections to Job Duck.');
      return;
    }
    threads.forEach(function (t) {
      var r = processThread_(t, null);
      tally_(stats, r);
      if (r !== 'job' && r !== 'deny') start++;
    });
    props.setProperty('backfillOffset', String(start));
  }
  Logger.log('Time budget used — run backfill() again to continue. So far: ' + JSON.stringify(stats));
}

function resetBackfill() { PropertiesService.getUserProperties().deleteProperty('backfillOffset'); }

function processThread_(thread, session) {
  var L = labels_();
  var rules = rules_();
  var userLabels = thread.getLabels().map(function (l) { return l.getName(); });
  if (userLabels.some(function (n) { return rules.protectedLabels.indexOf(n) >= 0; })) return 'skipped';
  var hasJob = userLabels.indexOf(CONFIG.JOB_LABEL) >= 0;
  if (userLabels.indexOf(CONFIG.DENY_LABEL) >= 0) {
    thread.moveToArchive();
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
  if (denyMsgs.length) {
    thread.addLabel(L.deny);
    if (hasJob) thread.removeLabel(L.job);
    var latestDeny = denyMsgs[denyMsgs.length - 1];
    if (latestDeny.getDate() >= CONFIG.SYNC_SINCE) recordRejection_(thread, latestDeny, session);
    thread.moveToArchive();
    return 'deny';
  }

  if (!hasJob) thread.addLabel(L.job);
  if (rules.keepActionMail && ACTION_SUBJECT.test(last.getSubject())) return 'kept';
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
  return { job: label_(CONFIG.JOB_LABEL), deny: label_(CONFIG.DENY_LABEL) };
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

/** One-time: rename the labels of earlier versions into the nested ones, move the old sync queue into the
 *  property queue, and drop the old bookkeeping labels. Threads keep every label they had. */
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

  var sync = GmailApp.getUserLabelByName(CONFIG.LEGACY_SYNC_LABEL);
  if (sync) {
    var pending;
    while ((pending = sync.getThreads(0, 100)).length) {
      pending.forEach(function (t) { enqueue_(t.getId()); });
      sync.removeFromThreads(pending);
    }
    sync.deleteLabel();
    Logger.log('Moved the "' + CONFIG.LEGACY_SYNC_LABEL + '" queue into the script and removed the label.');
  }
  CONFIG.LEGACY_DROP_LABELS.forEach(function (name) {
    var label = GmailApp.getUserLabelByName(name);
    if (label) { label.deleteLabel(); Logger.log('Removed label "' + name + '".'); }
  });
}

function tally_(stats, r) { stats[r] = (stats[r] || 0) + 1; }

function preview() {
  var jobs = 0, denies = 0, start = 0, began = Date.now();
  var serve = syncMode_() === 'serve';
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
      if (d.score >= DENY_THRESHOLD && d.strong) {
        denies++;
        Logger.log('DENY [' + d.score + '] ' + last.getDate().toISOString().slice(0, 10) + ' | ' + subj + '  <=  ' + d.reasons.join(' ') + ' | "' + String(d.evidence || '').slice(0, 90) + '"');
        if (serve) Logger.log('  would queue: ' + JSON.stringify(buildOutcome_(last)));
        else Logger.log('  would send: ' + JSON.stringify(buildPayload_(last)));
      }
      else jobs++;
    });
  }
  Logger.log('Scanned ' + start + ' inbox threads: ' + denies + ' rejections, ' + jobs + ' other job emails.');
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
 *  apply=false only logs; apply=true relabels rejections (and queues them) and drops non-application mail. */
function reaudit_(apply) {
  var name = apply ? 'reauditApplications' : 'previewReaudit';
  var props = PropertiesService.getUserProperties();
  var cursorKey = reauditCursorKey_(apply);
  var start = Number(props.getProperty(cursorKey) || 0);
  var began = Date.now();
  var L = apply ? labels_() : null;
  var rules = rules_();
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var stats = { rejection: 0, notJob: 0, kept: 0 };
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
        recordRejection_(t, d.message, null);
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
  if (d.score >= DENY_THRESHOLD && d.strong) {
    info.action = 'rejection';
    info.reasons = d.reasons;
    return info;
  }
  return kept;
}

/** Push mode keeps the v3 thread queue and posts to Job Duck; serve mode queues an outcome for jobduck sync. */
function recordRejection_(thread, message, session) {
  if (syncMode_() === 'push') {
    enqueue_(thread.getId());
    if (session) syncThread_(thread, message, session);
    return;
  }
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
  if (request.action === 'status') return json_({ ok: true, scriptVersion: SCRIPT_VERSION, mode: syncMode_(), pending: pendingCount_() });
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

function token_() { return PropertiesService.getScriptProperties().getProperty('JOBDUCK_TOKEN'); }

function headers_(token) {
  return {
    Authorization: 'Bearer ' + token,
    'X-JobDuck-Script-Version': SCRIPT_VERSION,
    'X-JobDuck-Inbound-API': INBOUND_API_VERSION
  };
}

function baseUrl_() {
  var url = PropertiesService.getScriptProperties().getProperty('JOBDUCK_URL') || DEFAULT_JOBDUCK_URL;
  return url.replace(/\/+$/, '');
}

function syncSession_() {
  var token = token_();
  if (!token) { Logger.log(MISSING_TOKEN_MESSAGE); return null; }
  return { token: token, base: baseUrl_(), calls: 0, stopped: false, stats: {} };
}

function pendingThreads_() {
  try { return JSON.parse(PropertiesService.getUserProperties().getProperty(PENDING_KEY) || '[]'); }
  catch (e) { return []; }
}

function savePending_(ids) {
  PropertiesService.getUserProperties().setProperty(PENDING_KEY, JSON.stringify(ids.slice(-CONFIG.MAX_PENDING)));
}

function enqueue_(threadId) {
  var ids = pendingThreads_();
  if (ids.indexOf(threadId) < 0) { ids.push(threadId); savePending_(ids); }
}

function dequeue_(threadId) {
  savePending_(pendingThreads_().filter(function (id) { return id !== threadId; }));
}

function drainPending_(session) {
  var ids = pendingThreads_();
  for (var i = 0; i < ids.length && canSync_(session); i++) {
    var thread = GmailApp.getThreadById(ids[i]);
    if (!thread) { dequeue_(ids[i]); continue; }
    var message = latestRejection_(thread);
    if (message) syncThread_(thread, message, session);
    else dequeue_(ids[i]);
  }
}

function latestRejection_(thread) {
  var messages = thread.getMessages();
  for (var i = messages.length - 1; i >= 0; i--) {
    var m = messages[i], subject = m.getSubject(), body = m.getPlainBody();
    if (isJobEmail(m.getFrom(), subject, body) && isRejection(subject, body)) return m;
  }
  return messages[messages.length - 1] || null;
}

function canSync_(session) {
  if (session.stopped || session.calls >= CONFIG.MAX_SYNC_PER_RUN) return false;
  if (dailyCount_() >= CONFIG.MAX_SYNC_PER_DAY) {
    session.stopped = true;
    Logger.log('Daily limit of ' + CONFIG.MAX_SYNC_PER_DAY + ' syncs reached; the rest stay queued for tomorrow.');
    return false;
  }
  return true;
}

function dailyKey_() { return DAILY_COUNT_PREFIX + new Date().toISOString().slice(0, 10); }

function dailyCount_() { return Number(PropertiesService.getUserProperties().getProperty(dailyKey_()) || 0); }

function bumpDailyCount_() {
  var props = PropertiesService.getUserProperties(), key = dailyKey_();
  props.getKeys().forEach(function (k) { if (k.indexOf(DAILY_COUNT_PREFIX) === 0 && k !== key) props.deleteProperty(k); });
  props.setProperty(key, String(dailyCount_() + 1));
}

function syncThread_(thread, message, session) {
  if (!canSync_(session)) return;
  var outcome = syncRejection_(message, session);
  tally_(session.stats, outcome);
  if (outcome !== 'retry' && outcome !== 'unauthorized') dequeue_(thread.getId());
}

function syncRejection_(message, session) {
  var payload = buildPayload_(message);
  session.calls++;
  bumpDailyCount_();
  var res;
  try {
    res = UrlFetchApp.fetch(session.base + '/api/inbound/rejections', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: headers_(session.token),
      muteHttpExceptions: true
    });
  } catch (e) {
    session.stopped = true;
    Logger.log('Could not reach Job Duck (' + e.message + '); will retry next run.');
    return 'retry';
  }
  var code = res.getResponseCode();
  if (code === 200) return JSON.parse(res.getContentText()).outcome;
  if (code === 401 || code === 403) {
    session.stopped = true;
    Logger.log('Job Duck rejected the token (HTTP ' + code + '). It was revoked or expired: create a new one in Settings → API tokens and replace JOBDUCK_TOKEN. Syncing stopped for this run.');
    return 'unauthorized';
  }
  if (code === 429 || code >= 500) {
    session.stopped = true;
    Logger.log('Job Duck is unavailable or at its daily limit (HTTP ' + code + '); will retry next run.');
    return 'retry';
  }
  Logger.log('Job Duck refused "' + payload.subject + '" (HTTP ' + code + '): ' + res.getContentText().slice(0, 200));
  return 'refused';
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
var DENY_THRESHOLD = 3;
var MIN_PREFIX_LENGTH = 12;

var ATS_SENDER = /@([\w.-]*\.)?(greenhouse-mail\.io|greenhouse\.io|lever\.co|ashbyhq\.com|myworkday\.com|workday\.(?!com\b)[\w.]+|smartrecruiters\.com|icims\.com|jobvite\.com|gem\.com|eightfold\.ai|avature\.net|paylocity\.com|paycomonline\.com|taleo\.net|successfactors\.(com|eu)|oraclecloud\.com|breezy\.hr|recruitee\.com|workable(mail)?\.com|bamboohr\.com|applytojob\.com|rippling(mail)?\.com|dayforcehcm\.com|ultipro\.com|ukg\.com|teamtailor(-mail)?\.com|pinpointhq\.com|wellfound\.com)\b/i;
var JOB_SENDER_LOCAL = /^(no-?reply[-_.]?(recruiting|careers)?|careers?|jobs?|recruiting|recruitment|talent|hiring\w*|hr\.notifications|noreply-careers|do-?not-?reply|systemmessage)@/i;
var JOB_SUBJECT = /(thank(s| you)( so much)? for (applying|your (application|interest|submission))|thanks for applying|your application|application (update|status|received|confirmation|submitted|to )|we('ve| have) received your application|candidacy|following up on your .*application|update (on|regarding|about) (your|the) .*(application|role|position)|^update from \w|application confirmation|interest in (career|joining|working))/i;
var JOB_BODY = /(thank(s| you)[^.]{0,60}for (applying|your application|submitting your application|your interest in)|(received|reviewed|reviewing) your application|your application (for|to|as)\b|apply(ing)? (for|to) the [^.]{3,120} (role|position)|for the [^.]{3,120} (role|position)\b)/i;

// Kept in the inbox (still labeled) because they need action now.
var ACTION_SUBJECT = /(security code|verification code|verify your (email|account)|one[- ]time (code|pass)|confirm your email|interview|schedul|availability|assessment|coding (challenge|exercise)|hackerrank|codesignal|take[- ]home|next steps|offer letter|background check)/i;

// Text from the first of these onward is hypothetical ("If you are not selected...") and is ignored.
var CONDITIONAL = /\b(if|when|whenever|once|before|until|should (you|things)|in case|whether|unless|in the event)\b/i;

// [weight, pattern] — each signal counts at most once per email.
var DENY_SIGNALS = [
  // strong: explicit decision (+2)
  [2, /\bnot (to )?(be )?(mov(e|ing)|proceed(ing)?|progress(ing)?|advanc(e|ing)|continu(e|ing))\b[^.]{0,50}\b(forward|further|ahead|with your|your (application|candidacy)|in the process|to (an|the next) )/i],
  [2, /\b(decided|decision|chosen|chose|elected|opted|aligned|determined)\b[^.]{0,80}\b(move|moving|proceed|proceeding|go|going|pursue|pursuing|continue|continuing|advance)\b[^.]{0,40}\b(other|another|different|a smaller|alternative|a finalist)\b/i],
  [2, /\b(mov(e|ed|ing)|proceed(ed|ing)?|go(ing)?) (forward |ahead )?with (other|another|a smaller|different|a different)\b/i],
  [2, /\b(regret|sorry|unfortunate) to (inform|say|let you know|share|tell|advise)/i],
  [2, /\b(you |application )?(have|has|were|was|are) not (been )?(selected|chosen|successful|shortlisted)\b|\bdid not select you\b/i],
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
  [2, /\b(position|role|opening|opportunity|requisition|req|job|seat)\b[^.]{0,100}\b(has been|have been|was|is|been|recently|has|is now|now been) (filled|closed|cancel+ed|put on hold)\b|\b(we'?ve|we have|we) (now |recently |already |just )?(filled|closed|hired someone for) (the|this|that) (position|role|opening|req)|\bno longer (available|hiring|accepting|considering|open|recruiting|being considered)\b|\bdecided not to fill\b/i],
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

/** Deny score over the unconditional part of each sentence: { score, reasons[], evidence, strong } */
function denyScore(subject, body) {
  var sentences = splitSentences(body).map(function (x) {
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
