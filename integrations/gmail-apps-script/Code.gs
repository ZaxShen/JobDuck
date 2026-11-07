/**
 * Job Duck — Gmail Rejection Sync v5.6
 * Script v5.4 — serve-only: rejections are queued in the script and served to `jobduck sync` by the script deployed
 * as a web app. Nothing is pushed anywhere.
 *
 * Handles two kinds of mail only, by allowlist, reading message bodies only. A thread whose every message is a plain
 * application confirmation (only acknowledgement sentences or proven boilerplate, no personal note) gets
 * "Job Duck/Applications" and is archived. A rejection gets "Job Duck/Rejections" and is archived only when it is the
 * latest job message and every other message is a plain confirmation. Everything else (interview mail, a recruiter's
 * note, any sentence the script does not know) is kept: no label, no archive, left in the Inbox. Each rejection that
 * stands becomes an outcome (header fields and a job link/ID only; the email body never leaves Gmail) queued for the
 * web app.
 *
 * Scope: the script only ever searches the Inbox (in:inbox), plus the "Job Duck/Applications" label when you run
 * previewReaudit/reauditApplications and the "Job Duck/Rejections" label when you run
 * previewReauditRejections/reauditRejections. A "Job Duck/Rejections" thread that is back in the Inbox because a new message
 * arrived is re-read: if the rejection still stands it is re-archived, otherwise it loses the label, stays in the
 * Inbox and its still-pending outcome is dropped.
 *
 * Setup:
 *   1. Run generateSyncToken and copy the logged token.
 *   2. Deploy → New deployment → Web app, Execute as Me, Who has access Anyone; copy the /exec URL.
 *   3. Put both into permissions.toml in your Job Duck home ([track] sync_url, sync_token).
 *   4. Run checkConnection, then preview, then install. Optional: backfill, previewReaudit, reauditApplications,
 *      previewReauditRejections (run it first), reauditRejections.
 * Optional properties: PROTECTED_LABELS and EXCLUDED_DOMAINS (comma-separated), KEEP_ACTION_MAIL_IN_INBOX=true.
 */

var SCRIPT_VERSION = '5.6';

var LABEL_PARENT = 'Job Duck';

var CONFIG = {
  JOB_LABEL: LABEL_PARENT + '/Applications',
  DENY_LABEL: LABEL_PARENT + '/Rejections',
  // Labels from earlier versions, renamed by install() so existing threads keep their history.
  LEGACY_JOB_LABELS: ['Job Applications', 'JD - Job Applications'],
  LEGACY_DENY_LABELS: ['Deny Letters', 'JD - Deny Letters'],
  // The v5.2 interview label: never created any more, deleted by install() and taken off by reauditApplications.
  LEGACY_INTERVIEWS: LABEL_PARENT + '/Interviews',
  LEGACY_DROP_LABELS: ['JobDuck Sync', 'JobDuck Synced', 'JobDuck Review', LABEL_PARENT + '/Interviews'],
  // Threads carrying any of these labels are left alone, e.g. ['Offers', 'Immigration'].
  // Also read from the script property PROTECTED_LABELS (comma-separated).
  PROTECTED_LABELS: [],
  // Senders from these domains are never sorted, e.g. ['lawfirm.example.com'].
  // Also read from the script property EXCLUDED_DOMAINS (comma-separated).
  EXCLUDED_DOMAINS: [],
  // A safety net since v5.4: verification and security-code mail asks for an action, so it is never archived anyway.
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
var REJECTIONS_QUERY = 'label:"' + CONFIG.DENY_LABEL + '"';
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
  var stats = { job: 0, deny: 0, keep: 0, kept: 0, skipped: 0 };
  var threads = GmailApp.search(CONFIG.RUN_QUERY, 0, CONFIG.MAX_THREADS_PER_RUN);
  threads.forEach(function (t) { tally_(stats, processThread_(t)); });
  if (stats.job || stats.deny || stats.keep) Logger.log(JSON.stringify(stats));
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
  var stats = { job: 0, deny: 0, keep: 0, kept: 0, skipped: 0 };
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
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var messages = thread.getMessages();
  var d = classifyThread_(messages, rules, me);
  if (d.action === 'skipped') return 'skipped';

  if (hasDeny && d.action !== 'keep') {
    thread.moveToArchive();
    return 'skipped';
  }
  if (d.action === 'deny') {
    thread.addLabel(L.deny);
    if (hasJob) thread.removeLabel(L.job);
    if (d.message.getDate() >= CONFIG.SYNC_SINCE) recordRejection_(d.message);
    thread.moveToArchive();
    return 'deny';
  }
  // Kept: no label is added and nothing is archived. A label this script set earlier no longer holds, so it comes off.
  if (d.action === 'keep') {
    if (hasJob) thread.removeLabel(L.job);
    if (hasDeny) {
      thread.removeLabel(L.deny);
      unqueueOutcomes_(messages);
      thread.moveToInbox();
    }
    return 'keep';
  }

  if (!hasJob) thread.addLabel(L.job);
  if (rules.keepActionMail && VERIFICATION_SUBJECT.test(messages[messages.length - 1].getSubject())) return 'kept';
  thread.moveToArchive();
  return 'job';
}

/** The allowlist decision for a thread, read from every message:
 *  { action: 'skipped' | 'deny' | 'keep' | 'job', reasons[], evidence, message }.
 *  'deny' only when the rejection is the latest job message, stands on its own and every other message is a plain
 *  application confirmation; 'job' only when every message is one. Any other job thread is 'keep': left untouched in
 *  the Inbox. */
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
    var extra = others.filter(function (n) { return !n.plain && !(n.deny && rejectionStands_(n.body)); })[0];
    if (rejectionStands_(latest.body) && !extra) {
      return { action: 'deny', reasons: ds.reasons, evidence: ds.evidence, score: ds.score, message: latest.message };
    }
    if (extra) return keptFor_(notes, extra, 'message besides the rejection');
    return { action: 'keep', reasons: ['rejection offers a conversation'], evidence: ds.evidence, message: latest.message };
  }
  var notPlain = notes.filter(function (n) { return !n.plain; })[0];
  if (notPlain) return keptFor_(notes, notPlain, notPlain.deny ? 'rejection followed by another message' : null);
  return { action: 'job', reasons: ['plain application confirmation'], message: latest.message };
}

/** A thread that is kept, with why: the interview signal of a message that is not a plain confirmation (or of a
 *  rejection that offers a conversation) when one has it, otherwise the first sentence that kept `note` out of the
 *  archive. */
function keptFor_(notes, note, why) {
  var reasons = why ? [why] : [];
  for (var i = 0; i < notes.length; i++) {
    if (notes[i].plain || (notes[i].deny && rejectionStands_(notes[i].body))) continue;
    var iv = interviewScore(notes[i].body);
    if (iv.positive) {
      return { action: 'keep', reasons: reasons.concat(iv.reasons), evidence: iv.evidence, message: notes[i].message };
    }
  }
  var action = actionIn_(note.subject, note.body);
  var odd = action || unacknowledged_(note.body);
  if (!why) reasons.push(action ? 'asks you to act' : odd ? 'unknown sentence' : 'not a plain application confirmation');
  return { action: 'keep', reasons: reasons, evidence: odd || note.subject, message: note.message };
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
  var jobs = 0, denies = 0, keeps = 0, start = 0, began = Date.now();
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
      } else if (d.action === 'keep') {
        keeps++;
        Logger.log('KEEP ' + line);
      } else {
        jobs++;
      }
    });
  }
  Logger.log('Scanned ' + start + ' inbox threads: ' + denies + ' rejections, ' + keeps + ' job emails kept in the Inbox, ' +
    jobs + ' application confirmations.');
}

function previewReaudit() { reaudit_(false); }

function reauditApplications() { reaudit_(true); }

function previewReauditRejections() { reauditRejections_(false); }

function reauditRejections() { reauditRejections_(true); }

function resetReaudit() {
  var props = PropertiesService.getUserProperties();
  props.deleteProperty(reauditCursorKey_(true));
  props.deleteProperty(reauditCursorKey_(false));
  props.deleteProperty(reauditRejectionsCursorKey_(true));
  props.deleteProperty(reauditRejectionsCursorKey_(false));
}

function reauditCursorKey_(apply) { return apply ? 'reauditOffset' : 'previewReauditOffset'; }

function reauditRejectionsCursorKey_(apply) { return apply ? 'reauditRejectionsOffset' : 'previewReauditRejectionsOffset'; }

/** Re-classifies every "Job Duck/Rejections" thread, newest first, within the time budget, with the same thread rules
 *  as run(). apply=false only logs; apply=true takes the label off every thread that is no longer a rejection that
 *  stands, drops its still-pending outcome and moves it back to the Inbox. */
function reauditRejections_(apply) {
  var name = apply ? 'reauditRejections' : 'previewReauditRejections';
  var props = PropertiesService.getUserProperties();
  var cursorKey = reauditRejectionsCursorKey_(apply);
  var start = Number(props.getProperty(cursorKey) || 0);
  var began = Date.now();
  var L = apply ? labels_() : null;
  var rules = rules_();
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var stats = { back: 0, unchanged: 0 };
  while (Date.now() - began < CONFIG.TIME_BUDGET_MS) {
    var threads = GmailApp.search(REJECTIONS_QUERY, start, REAUDIT_PAGE);
    if (!threads.length) {
      props.deleteProperty(cursorKey);
      Logger.log(name + ' complete. ' + JSON.stringify(stats));
      return;
    }
    threads.forEach(function (t) {
      var d = reauditRejectionDecision_(t, rules, me);
      tally_(stats, d.action);
      if (d.action === 'unchanged') { start++; return; }
      Logger.log((apply ? '' : 'would ') + 'back | ' + d.date + ' | ' + d.subject + '  <=  ' + d.reasons.join(' '));
      if (!apply) { start++; return; }
      t.removeLabel(L.deny);
      unqueueOutcomes_(d.messages);
      t.moveToInbox();
    });
    props.setProperty(cursorKey, String(start));
  }
  Logger.log('Time budget used — run ' + name + '() again to continue. So far: ' + JSON.stringify(stats));
}

function reauditRejectionDecision_(thread, rules, me) {
  var kept = { action: 'unchanged' };
  var names = thread.getLabels().map(function (l) { return l.getName(); });
  if (names.some(function (n) { return rules.protectedLabels.indexOf(n) >= 0; })) return kept;
  var messages = thread.getMessages(), last = messages[messages.length - 1];
  var sender = parseSender_(last.getFrom());
  if (sender.email === me) return kept;
  var domain = sender.email.split('@')[1] || '';
  if (rules.excludedDomains.some(function (d) { return domain === d || domain.endsWith('.' + d); })) return kept;
  var d = classifyThread_(messages, rules, me);
  if (d.action === 'deny') return kept;
  return { action: 'back', messages: messages, reasons: d.reasons || [], subject: last.getSubject(),
    date: last.getDate().toISOString().slice(0, 10) };
}

/** Re-classifies every "Job Duck/Applications" thread, newest first, within the time budget, with the same thread
 *  rules as run(). apply=false only logs; apply=true relabels rejections (and queues them), takes the label off every
 *  thread that is not plain application mail (and the v5.2 interview label, if the thread has it) and moves it back to
 *  the Inbox, and drops non-application mail. */
function reaudit_(apply) {
  var name = apply ? 'reauditApplications' : 'previewReaudit';
  var props = PropertiesService.getUserProperties();
  var cursorKey = reauditCursorKey_(apply);
  var start = Number(props.getProperty(cursorKey) || 0);
  var began = Date.now();
  var L = apply ? labels_() : null;
  var legacyInterviews = apply ? GmailApp.getUserLabelByName(CONFIG.LEGACY_INTERVIEWS) : null;
  var rules = rules_();
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var stats = { rejection: 0, keep: 0, notJob: 0, unchanged: 0 };
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
      if (d.action !== 'unchanged') {
        Logger.log((apply ? '' : 'would ') + d.action + ' | ' + d.date + ' | ' + d.subject + '  <=  ' + d.reasons.join(' '));
      }
      if (!apply || d.action === 'unchanged') { start++; return; }
      if (d.action === 'rejection') {
        t.addLabel(L.deny);
        t.removeLabel(L.job);
        recordRejection_(d.message);
      } else if (d.action === 'keep') {
        t.removeLabel(L.job);
        if (legacyInterviews) t.removeLabel(legacyInterviews);
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
  var kept = { action: 'unchanged', reasons: [] };
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
  if (d.action !== 'deny' && d.action !== 'keep') return kept;
  info.action = d.action === 'deny' ? 'rejection' : 'keep';
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

// With KEEP_ACTION_MAIL_IN_INBOX set, a thread whose latest subject is a code mail is labeled but not archived.
var VERIFICATION_SUBJECT = /(security code|verification code|verify your (email|account)|one[- ]time (code|pass)|confirm your email)/i;

// Interview, assessment, scheduling and offer mail, read from the body only (the subject is never a signal).
// [reason, pattern] — any match in a sentence that is not boilerplate makes the email interview mail.
var SCHEDULES_YOURS = /\b(schedul\w*|book\w*|set(ting)? up|arrang\w*|coordinat\w*|confirm\w*) (your|the|an?)( [\w-]+){0,2}? (interview|call|chat|screen(ing)?|on-?site|round|meeting|conversation)s?\b/i;
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
  ['interview confirmed', /\b(your|the|our) (interview|phone screen|screening call|call|chat|meeting|on-?site)s? (is|are|has been|have been) (now )?(confirmed|scheduled|booked|set( up)?)\b/i],
  ['upcoming interview', /\b(your|the) (upcoming|scheduled|confirmed) (interview|call|chat|meeting|screen(ing)?|on-?site)s?\b|\b(details|agenda|link|invitation|invite|itinerary|prep(aration)?) (for|to) (your|the) ([\w'-]+ ){0,2}?(interview|call|meeting|screen(ing)?|on-?site)s?\b/i],
  ['next step is a call', /\b(the|your|our) next step (is|will be)\b[^.?!]{0,40}?\b(interview|call|chat|screen(ing)?|conversation|meeting|assessment)\b/i],
  ['schedules your call', SCHEDULES_YOURS],
  ['interview time', new RegExp('^(?=.*\\b(interview\\w*|calls?|chats?|meetings?|screen(ing)?|on-?site|conversation|zoom)\\b)(?=.*(' +
    '\\b(mon|tues|wednes|thurs|fri|satur|sun)day\\b|\\btomorrow\\b|\\btoday\\b|' +
    '\\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\\.? \\d{1,2}\\b|' +
    '\\b\\d{1,2}(:\\d{2})? ?([ap]\\.?m\\.?)(?![a-z])|\\b\\d{1,2}:\\d{2}\\b))', 'i')]
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
var ADVANCED = /\b(you(['’]ve| have) been (selected|chosen|shortlisted|invited|advanced|moved)|we(['’]re| are|['’]ve| have)( (?!not\b|never\b)\w+)? (moving|advancing|moved|advanced|inviting|selected|shortlisted) you)\b[^.?!]{0,40}?\b(interview|next (step|round|stage)|round|on-?site|screen)/i;
// Any other sentence about an interview, a call or a chat ("Here are the details for your upcoming interview",
// "The next step is a 30-minute call with our hiring manager") is interview mail unless it is boilerplate.
var INTERVIEW_TOPIC = /\b(interview\w*|calls?|chat|chatting|speak|speaking|talk|talking|meet|meeting|screen|screening|on-?site|rounds?|next steps?|availability|zoom)\b/i;

// Boilerplate that vetoes every signal except a direct offer: the applicant pool ("Applicants who move forward to the
// interview stage will be contacted"),
var APPLICANT_POOL = /\b(candidates|applicants|those)( who| that| whose| moving| advancing| progressing| selected| shortlisted| chosen)\b|\b(selected|qualified|shortlisted|successful|top) (candidates|applicants)\b|\bselect few( candidates| applicants)?\b|\b(only|not) (be )?able to (respond|reply|reach out|get back) to\b/i;
// a step the employer only takes once it picks the candidate ("If your experience matches, we will reach out to
// schedule an interview", "If selected, you will be invited to an onsite interview"),
var EMPLOYER_CONDITION = /\b(if|when|once|should|in case|in the event( that)?|provided( that)?|assuming)\s+((we|our (\w+ )?team|the (\w+ )?team|the hiring manager) (decide|decides|choose|chooses|determine|determines|feel|feels|think|thinks|believe|believes|find|finds|see|sees|are interested|is interested|would like|wish|wishes|want|wants)\b|there(['’]s| is| are)\b|(you(['’]re| are| were| have been| get| are being) )?(selected|chosen|shortlisted|qualified|successful)\b|you (meet|match|fit|move forward|advance|progress|pass)\b|you(['’]re| are) (a )?(good |strong |great |potential |possible )?(match|fit)\b|(it['’]?s |this is )?a (good |strong |great |potential )?(match|fit)\b|(the|this) (role|position|opportunity|job)( \w+){0,2}? (is|seems|looks)( like)? (a )?(good |strong |great |potential )?(match|fit)\b)|\b(if|when|once|should)\b[^.?!]{0,60}?\byour (\w+ )?(experience|background|qualifications?|skills?|skill ?set|profile|application|resume|candidacy)( \w+){0,2}? (match|matches|align|aligns|fit|fits|meet|meets|is a (good |strong )?(fit|match)|are a (good |strong )?(fit|match))\b/i;
var EMPLOYER_STEP = /\b(will|['’]ll|would|may|might|can|could)\b[^.?!]{0,60}?\b(schedul\w*|invit\w*|arrang\w*|set up|book|ask(ed)?|move|advance|call|reach out|contact\w*|be in touch|get in touch|follow up|let you know|notif\w*|receive|hear( back)? from)\b/i;
// a possibility ("You may be asked to complete an assessment"),
var POSSIBILITY = /\b(may|might|could) (also )?(be )?(asked|invited|required|contacted|requested)\b/i;
// and a description of the process ("Our interview process consists of a phone screen and an onsite").
var PROCESS_DESCRIPTION = /\b(about|on) (our|the) (interview|hiring|recruiting|selection) process\b|\b(our|the|this|a typical) (interview|hiring|recruiting|selection) process\b[^.?!]{0,30}?\b(consists?|includes?|involves?|comprises?|is made up|typically|usually|generally|will (include|consist|involve))\b|\b(typically|usually|generally) (consists?|includes?|involves?)\b/i;
// Boilerplate that only vetoes the broad topic match, never an explicit invite or scheduling signal ("We are currently
// reviewing your application and would like to schedule a phone screen" is kept): review wording ("We will review
// your application") and a vague promise of future contact ("You will hear from us about the interview stage soon")
// that does not commit to scheduling the candidate's own interview ("Our recruiter will contact you to schedule your
// interview" is kept).
var REVIEW_ONLY = /\b(will|we'?ll) (review|screen|be reviewing|be screening|carefully review)\b|\bcurrently (reviewing|screening)\b|\bunder review\b/i;
var FUTURE_CONTACT = /\b(will|['’]ll|would|shall|may|might|can)( \w+){0,2}? (reach out|be reaching out|contact you|be contacted|be in touch|get in touch|hear from us|hear back|be notified|notify you|let you know|follow up|get back to you|receive (an? |further |more |another )?(e-?mail|message|call|invitation|invite|notification|update|follow-up))\b|\bhear from us\b|\bbe in touch\b/i;

// "...we will be in touch if we would like to schedule an interview": the offer is itself the employer's condition.
var OFFER_AS_CONDITION = /\b(if|when|once|should|unless|whether|in case)(\s+[^\s,;:]+){0,3}\s*$/i;
// "...we won't be able to invite you to the next round": a negated offer is no offer.
var OFFER_NEGATED = /(\bnot|n['’]t|\bunable to|\bnever)( (?:be|able|to|going|happy|in a position))*( \w+)? ?$/i;

function directOffer_(sentence) {
  var direct = DIRECT_OFFERS.some(function (re) {
    var m = re.exec(sentence);
    var before = sentence.slice(0, m ? m.index : 0);
    return m && !OFFER_AS_CONDITION.test(before) && !OFFER_NEGATED.test(before);
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
    if (!offer && why.length === before && INTERVIEW_TOPIC.test(sentence) && !vagueContact_(sentence) && !notice_(sentence)) {
      add('about an interview', sentence);
    }
  });
  var link = String(body || '').match(INTERVIEW_LINK);
  if (link) why.push('link: ' + link[1]);
  var positive = why.some(function (r) { return r !== 'about an interview'; });
  return { interview: why.length > 0, positive: positive, reasons: why, evidence: evidence };
}

// The archive allowlist. A message is plain application mail only when its body confirms an application (or its
// subject is a verification code), it is not a rejection, it is not interview mail, nobody writes in the first person,
// and every sentence left once the greeting, the sign-off with its signature and the standard footer are set aside is
// a known acknowledgement. Scheduling words are judged per sentence: a sentence holding one passes only as a known
// boilerplate shape ("If your experience matches, we will reach out to schedule an interview", "Our interview process
// includes a recruiter screen and a technical interview"), never inside a role or company name, and a greeting or
// signature line holding one keeps the message. Any other sentence ("Please complete your HireVue by Friday", "Reply
// with your free times") keeps its thread in the Inbox.
var CONFIRMATION = /\bthank(s| you)\b[^.!?]{0,60}\bfor (applying|submitting|your (application|interest|submission)|taking the time to (apply|submit))\b|\b(received|receipt of|got) your (application|resume|cv)\b|\byour application\b[^.!?]{0,80}\b(has been|was|is|been) (successfully )?(received|submitted)\b|\bapplication (received|submitted|confirmation)\b/i;
var SCHEDULING_WORDS = /\b(interview\w*|calls?|called|calling|chat\w*|zoom|calendly|goodtime|calendar\w*|(re)?schedul\w*|availab(le|ility)|on-?site|screen\w*|next steps?|assessments?|meet|meeting|meetings|talk|talks|talking|speak\w*|conversations?|phone|video|rounds?|slots?|book|booked|booking|invit\w*|hackerrank|codesignal|codility|coderpad|testgorilla|hirevue|pymetrics|karat|spark ?hire|modern ?hire|harver|wonderlic|shl|ccat|criteria (corp|cognitive)|microsoft teams|teams (link|meeting|call|invite)|webex|bluejeans|gotomeeting|google meet|skype|whereby|take-?home|coding (challenge|exercise|test|assignment)|questionnaire|offers?|congratulat\w*|super ?day|hiring manager|background check|reference check|times? that works?|works? for you)\b|\b(can|could|would|will|are|do) you\b[^.!?]*\?/i;
var FIRST_PERSON = /\bI\b|\bI['’](m|ve|ll|d)\b|\b(me|my)\b|(^|[.!?]\s+)My\b/;

function plainConfirmation_(subject, body) {
  var text = String(body || '');
  if (!CONFIRMATION.test(text.replace(/[‘’]/g, "'")) || isInterview(text)) return false;
  return unacknowledged_(text) === null && actionIn_(subject, text) === null;
}

// The second veto, read on top of the allowlist: any sentence (footer sentences aside) that asks the candidate to act
// keeps the message, even when the allowlist accepts it. [reason, pattern]; patterns read straight quotes.
var ACTION_VERBS = '(?:complete|schedule|reschedule|book|select|choose|pick|confirm|reply|respond|verify|submit|upload|take(?! a look)|finish|click|tap|fill (?:out|in)|sign(?! up for (?:job|career) alerts)|provide|send|share|answer|record|accept|rsvp|attend|forward|return|grab|start|begin|activate|join (?:us|the|this|a|our (?:call|meeting|session|webinar|event)))';
var NOT_NEGATED = '(?:(?!\\b(?:not|never|don\'t|do not)\\b)[^.?!]){0,30}?';
var ABOUT_QUESTIONS = /^(do you |have |got |any )?(questions|concerns)\b|\b(if|should|in case|when) you have (any )?(further |additional |other )?(questions|concerns|queries)\b|\b(for|with) (any )?(further |additional |other )?(questions|concerns|queries)\b/i;
var ACTION_SIGNALS = [
  ['request', new RegExp('\\b(?:please|kindly|be sure to|make sure to|remember to|don\'t forget to|you(?:\'ll| will)? need to|you must|you(?:\'re| are) (?:required|invited|asked|requested) to|we need you to|we ask that you|we(?:\'d| would) (?:like|ask|love) (?:for )?you to)\\b' + NOT_NEGATED + '\\b' + ACTION_VERBS + '\\b', 'i'), true],
  ['imperative', new RegExp('^(?:(?:p\\.?s\\.?|note|important|reminder|next steps?|to do)[:,.]? )?' + ACTION_VERBS + '\\b', 'i'), true],
  ['request', /\b(click|tap)\b|\blet (us|me) know\b(?! if you (do not|don't|no longer) (want|wish) to be contacted)|\b(need|require|request|requested|requesting|want|would like|'d like|would love|'d love) (to (see|get|receive|have) )?(from )?(you(?! to know\b)|your)\b|\blink (is )?below\b|\bbelow link\b/i, true],
  ['task', /\b(assessments?|tests?|testing link|quiz(zes)?|challenges?|exercises?|questionnaires?|surveys?|case stud(y|ies)|(work|writing|code|coding) samples?|coding (project|task)s?|take[- ]?home|project brief|portfolio|references|reference (check|details|contacts?)|background (check|screening)|nda|transcripts?|presentations?|tryouts?|evaluations?|instructions|tasks?|(information|info|technical|onboarding|orientation) sessions?|attached|enclosed|attachments?)\b/i],
  ['tool', /\b(hirevue|karat|codesignal|hackerrank|hackerearth|codility|coderpad|testgorilla|pymetrics|harver|wonderlic|shl|ccat|criteria (corp|cognitive)|spark ?hire|modern ?hire|vervoe|imocha|mettl|calendly|goodtime|calendar|microsoft teams|teams (link|meeting|call|invite)|webex|bluejeans|gotomeeting|google meet|zoom|skype|whereby)\b/i],
  ['verification', /\b(verification|security|one[- ]time|access|login|sign[- ]in) (code|passcode|pin|link)\b|\b(otp|passcode)\b|\bverify your\b|\bconfirm your (e-?mail|account|identity|address)\b|\b(create|set up|set|reset) (an |your )?(account|password)\b/i],
  ['application not finished', /\b(started|begun|begin|continue|resume|finish|complete) (an |your |the )?application\b|\bapplication (is |was )?(incomplete|unfinished|not (yet )?(complete|submitted|finished))\b|\b(incomplete|unfinished|partial|draft|pending) applications?\b|\b(application|submission) limit\b|\blimit (has been |was )?reached\b|\breached the (maximum|limit)\b/i],
  ['date or time', /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(today|tomorrow|tonight|this (week|morning|afternoon|evening))\b|\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\.? \d{1,2}(st|nd|rd|th)?(?!\d)|\b\d{1,2}(st|nd|rd|th)? (of )?(jan(uary)?|feb(ruary)?|march|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[./]\d{1,2}([./]\d{2,4})?\b|\b\d{1,2} \d{1,2} \d{4}\b|\b\d{1,2}(:\d{2})? ?([ap]\.?m\b\.?)|\b\d{1,2}:\d{2}\b|\b(deadline|overdue|expires?|expir(ing|ation|ed)|end of (the )?(day|week)|eod|asap)\b|\b(is|are) due\b|\bdue (by|on|date|in|within|before)\b/i],
  ['link', /^URL$/],
  ['question', /\byou(r|rs|'re|'ll|'ve|'d)?\b[^?]*\?|\?[^?]*\byour?\b/i, true],
  ['offer', /\b(job|formal|verbal|written|employment|contingent) offer\b|\boffer (letter|of employment|package)\b|\b(extend|extending|make|making) (you )?an? (\w+ )?offer\b|\boffer you\b|\bcongratulat\w*\b(?! on (taking|applying|submitting))/i],
  ['personal note', FIRST_PERSON],
  ['personal note', /\b(loved|enjoyed|impressed|caught (our|the team's) (eye|attention)|stood out|stands out)\b/i],
  ['conversation', /\blet'?s (connect|chat|talk|meet|speak|find)\b|\b(wants?|wanted|would like|'d like|would love|'d love|hope|hoping|keen|eager|excited|look(ing)? forward) to (connect|chat|talk|speak|meet|see|get to know|hear(?! (that )?you('re| are) interested\b))\b|\bin front of (the|our) (team|hiring manager)\b/i],
  ['moving you forward', /\b(move|moving|moved|advance|advancing|advanced|progress|progressing|proceed|proceeding) (forward |ahead )?(with )?you\b|\bmov(e|ing|ed) you (forward|ahead|along|to)\b/i],
  ['waiting on you', /\b(action (is )?(required|needed)|required action|reminder|waiting for you|awaits|outstanding|your next step)\b/i],
  ['place', /\b\d{1,6} [A-Z][\w.'-]*( [A-Z][\w.'-]*){0,3} (St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Way|Ln|Lane|Pl|Place|Pkwy|Hwy|Ct|Sq)\b|\b(Floor|Suite|Room|Ste|Fl|Rm)\.? ?#?\d/]
];
// A booking, assessment or meeting link anywhere in the body, or a link whose path names one.
var ACTION_LINK = /https?:\/\/[^\s<>"')\]]*(\b(calendly\.com|goodtime\.io|cal\.com|savvycal\.com|youcanbook\.me|hirevue\.com|karat\.(io|com)|codesignal\.com|hackerrank\.com|hackerearth\.com|codility\.com|coderpad\.io|testgorilla\.com|pymetrics\.(ai|com)|harver\.com|criteriacorp\.com|sparkhire\.com|modernhire\.com|vervoe\.com|zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|bluejeans\.com|gotomeeting\.com|whereby\.com|calendar\.google\.com)\b|\/(book|booking|schedul\w*|assessments?|interviews?|availability|calendar|challenges?|tests?|quiz)\b)/i;

/** The first sign that a message asks the candidate to act, or null: a verification subject, a booking or assessment
 *  link, or a sentence matching ACTION_SIGNALS. A sentence that only offers help with questions is no request. */
function actionIn_(subject, body) {
  if (VERIFICATION_SUBJECT.test(subject)) return subject;
  var link = String(body || '').match(ACTION_LINK);
  if (link) return link[0];
  var parts = bodyParts_(body);
  if (parts.line) return parts.line;
  for (var i = 0; i < parts.sentences.length; i++) {
    var sentence = parts.sentences[i];
    if (footer_(sentence)) continue;
    var questions = ABOUT_QUESTIONS.test(sentence);
    for (var k = 0; k < ACTION_SIGNALS.length; k++) {
      if (questions && ACTION_SIGNALS[k][2]) continue;
      if (ACTION_SIGNALS[k][1].test(sentence)) return sentence;
    }
  }
  return null;
}

// Words that never belong to a role or company name, a greeting name or a signature line: an action, a time or a
// deadline, a pronoun, a conjunction or a task. A name holding one ("Acme and please complete your HireVue") is no
// name, so the sentence matches no acknowledgement.
var ACK_VETO = "please|kindly|complete\\w*|finish\\w*|start\\w*|begin\\w*|join\\w*|click\\w*|tap|repl\\w*|respond\\w*|submit\\w*|confirm\\w*|select\\w*|choose|pick|book\\w*|upload\\w*|sign\\w*|record\\w*|take|taking|attend\\w*|send|share|provide|fill|follow|log|login|verify|accept|decline|rsvp|review\\w*|continue|access|open|go|get|use|visit|check|view|track|download|install|prepare|practice|need\\w*|requir\\w*|action|must|should|can|could|would|will|may|might|shall|is|are|was|were|be|been|has|have|had|do|does|did|links?|below|above|attached|here|there|now|deadline|due|by|before|within|until|after|asap|urgent|today|tomorrow|tonight|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|jan|january|feb|february|mar|march|apr|april|june?|july?|aug|august|sept?|september|oct|october|nov|november|dec|december|am|pm|noon|midnight|morning|afternoon|evening|weeks?|weekend|days?|hours?|minutes?|times?|dates?|you|your|yours|we|us|our|i|me|my|tests?|games?|sessions?|tasks?|exercises?|challenges?|quiz|survey|form|questionnaire|portal|answers?|questions?|free|and|or|but|so|then|also|to|if|when|once|while|not|no|yes|thanks?|congrats|reminder|important|ready|pending|waiting|steps?|stages?|requested|expir\\w*|last|final|chance|immediately";
// A role or company name ("the Backend Engineer role at Acme"): up to ten words with no digit and no veto word,
// captured so its length (at most 60) is checked.
var ACK_NAME = "((?:(?!(?:" + ACK_VETO + "|at)\\b)[a-z&'()/+#.-]+(?![a-z&'()/+#.-])(?:,? (?=[a-z&'()/+#.-]))?){1,10})";
var ACK_ROLE = '(?:the |our |a |an |this )?' + ACK_NAME;
// A requisition number after a role ("Applied Scientist (Job number: 200030197)").
var ACK_REQ = '(?:,? \\(?(?:(?:job|req|requisition) (?:number|id|no\\.?|#)?:? ?)?(?:[a-z]{1,3}-?)?\\d{3,9}\\)?)?';
var ACK_ROLE_AT = ACK_ROLE + ACK_REQ + '(?: (?:at|with|within) ' + ACK_NAME + ')?';
var ACK_FOR_ROLE = '(?: (?:to|for|with|at|on|in) ' + ACK_ROLE_AT + ')?';
var ACK_TEAM = '(?:(?:the|our) )?(?:(?:recruiting|recruitment|hiring|talent(?: acquisition)?|people|hr|human resources|selection|search) )?team';
var ACK_WHO = '(?:we|' + ACK_TEAM + '(?: members?)?|(?:our|the|a) (?:hr|recruiting|talent) representatives?|(?:our|the|a|one of our|one of the) (?:(?:hiring|recruiting) )?(?:recruiters?|talent acquisition specialists?|hiring managers?)|(?:a |one of the |one of our )?members? of ' + ACK_TEAM + '|someone (?:from|on) ' + ACK_TEAM + ')';
var ACK_DOCS = '(?:application(?: packet)?|information|suitability|qualifications|background|experience|expertise|profile|resume|cv|submission|materials|candidacy|skills|skill ?set)';
var ACK_WHEN = '(?:soon|shortly|directly|again|either way|accordingly|carefully|thoroughly|closely|promptly|now|right away|with care|in detail|as soon as possible|in the (?:coming|next few|near) (?:days|weeks|future)|over the (?:coming|next few) (?:days|weeks)|within (?:the next )?(?:a few|two|three|several|\\d{1,2}(?: to \\d{1,2})?) (?:business )?(?:days|weeks)|as soon as (?:we can|we have an update(?: on (?:the )?next steps)?|there(?:\'s| is) an update(?: on (?:the )?next steps)?|a decision (?:has been|is) made)|once (?:we(?:\'ve| have) (?:reviewed|completed|finished)(?: (?:our|the|your) (?:review|application)(?: process)?)?|(?:our|this|the) review(?: process)? is complete|a decision (?:has been|is) made)|after (?:we review|reviewing|our review of) (?:your application|it))';
var ACK_TAIL = '(?:,? ' + ACK_WHEN + '){0,2}';
var ACK_IF = '(?:if|should|when|in case|once)(?: you have any questions,? or(?: if| when)?)?(?: you(?:\'re| are) (?:still )?interested and)?(?: (?:there is|there\'s|there are|(?:we|' + ACK_TEAM + '|the hiring manager) (?:find|finds|see|sees|identify|identifies|have|has)) (?:a |an |any )?(?:(?:good|strong|potential|mutual|suitable|possible) )?(?:match|fit|opening|alignment|interest|next steps?)(?: (?:with|for) (?:the|this|our) (?:role|position|opening|team))?' +
  '| your ' + ACK_DOCS + '(?:,? (?:and|or) (?:your )?' + ACK_DOCS + ')? (?:match(?:es)?|aligns?(?: with)?|fits?|meets?|(?:is|are|seems?|looks?)(?: like)? (?:a )?(?:(?:good|strong|great) )?(?:match|fit))(?: (?:for|with|to))?(?: (?:our|the|this) (?:needs|requirements|role|position|opening|team|qualifications|(?:role|position|job) requirements)(?: (?:for|of) (?:the|this|our) (?:role|position|opening|team))?| what (?:we\'re|we are|the (?:hiring )?team is) looking for| the necessary qualifications for the (?:role|position)| (?:the|this) (?:role|position)\'s (?:requirements|needs))?' +
  '| you are given further consideration(?: for (?:any |this |the )?(?:open )?(?:positions?|roles?))?| (?:you(?:\'re| are| have been)(?: not)? )?(?:selected|chosen|shortlisted)(?: (?:for|to (?:move forward|advance|proceed)(?: (?:to|with))?) (?:an? |the )?(?:(?:phone|video|initial|first|next) )?(?:interview|interview stage|next steps?|next (?:stage|round)(?: of (?:the|our) (?:process|interview process|hiring process))?))?' +
  '| you(?:\'re| are) (?:a )?(?:(?:good|strong|great|potential|possible) )?(?:fit|match)(?: for (?:the|this|our) (?:role|position|opening|team))?' +
  '| (?:the|this) (?:role|position|opening) (?:is|seems|looks)(?: like)? (?:a )?(?:(?:good|strong|great) )?(?:fit|match)(?: for you)?' +
  '| we (?:decide|choose|wish|want|would like|\'d like) (?:not )?to (?:move forward|proceed)(?: with your (?:application|candidacy))?' +
  '| (?:it\'s|it is) a (?:good |strong )?(?:fit|match)| a decision (?:has been|is) made| we have (?:an update|any updates|news))';
// What a promised contact is about. An interview topic passes only with a condition (ACK_INTERVIEW_STEP).
var ACK_ABOUT = '(?: (?:with|about|regarding|on|for|to discuss) (?:an update|any updates|updates|the outcome(?: of your application)?|our decision|a decision|the status of your application|your application(?: status)?|(?:the |any |further |possible |potential )?next steps|further (?:discussion|information|steps)(?: and (?:the )?next steps)?|more information))?';
var ACK_CONTACT = '(?:(?:aim|hope|expect|plan) to )?(?:be in touch|get in touch|be in contact|contact you|reach out(?: to you)?|be reaching out(?: to you)?|get back to you|follow up(?: with you)?|let you know|notify you|update you|be contacting you|be back in touch|send you (?:a response|an update|a decision))';
var ACK_MEETING = '(?:(?:(?:an?|the|your|a few|further|next) )?(?:(?:initial|phone|first|introductory|video|virtual|brief|short|follow-up|in-person|technical|on-?site|final|panel) )*(?:interviews?|calls?|conversations?|chats?|screens?|screening|meetings?|next steps?)|a time to (?:discuss|talk about) (?:this|the) (?:opportunity|role|position)(?: further)?)';
var ACK_BY = '(?: (?:by|from) (?:a member of |one of )?(?:' + ACK_TEAM + '|our recruiters|a recruiter|the hiring manager))?';
var ACK_HEAR ='you(?:\'ll| will| can expect to| should)(?: be sure to)? (?:hear (?:back )?from (?:us|one of our recruiters|a recruiter|' + ACK_TEAM + ')|hear back|be contacted|be notified|receive (?:an update|a response|a decision|further information|an? (?:e-?mail|message)))' + ACK_BY;
// A contact or invitation step about an interview, with the condition the employer sets for it, before or after.
var ACK_INTERVIEW_STEP = '(?:(?:(?:' + ACK_WHO + '(?= |\')(?: (?=will|shall|would))?)?(?:will|\'ll|shall|would)(?: be sure to| certainly| definitely)? )?' + ACK_CONTACT + '(?: with you)? (?:to (?:schedule|arrange|set up|discuss|book)|about|regarding|for) ' + ACK_MEETING +
  '|you(?:\'ll| will) be (?:contacted|invited|asked|notified)(?: (?:by|from) (?:a member of )?' + ACK_TEAM + ')? (?:to (?:schedule|arrange|book|participate in|take part in|attend) |to |for |about )' + ACK_MEETING +
  '|' + ACK_HEAR + ' (?:to (?:schedule|arrange|set up|discuss) |about |regarding )' + ACK_MEETING + ')' + ACK_TAIL;
// Interview stages listed as a description of the process.
var ACK_STAGE = '(?:(?:an?|the|one|two|three|several|multiple|a few|one or more|a series of) )?(?:(?:recruiter|hiring manager|technical|virtual|video|phone|initial|introductory|final|on-?site|behaviou?ral|team|panel|coding|culture|cultural|values|take-?home|skills|case|system design|short|brief|in-person|remote|\\d{2}-minute) )*(?:screens?|screening|calls?|interviews?|chats?|conversations?|assessments?|rounds?(?: of interviews)?|loops?|on-?sites?|exercises?|challenges?|presentations?|meetings?)(?: with (?:the |a |our )?(?:hiring manager|recruiter|team|members of (?:the|our) team))?';
var ACK_STAGES = ACK_STAGE + '(?:(?:,|,? and|,? followed by|,? then|,? and then|,? and finally) ' + ACK_STAGE + '){0,6}';
var ACK_KEEP_ON_FILE = '(?:we(?:\'ll| will| may)|will|may)(?: also)? keep your (?:resume|application|profile|information|details)(?: on file| in our (?:database|system|talent (?:community|pool|network)))(?: for (?:future|other) (?:opportunities|openings|roles|positions))?(?:,? (?:if|in case|should) (?:another|a future|a different|other|a new) (?:job|role|position|opening)s? (?:matches|match|fits|aligns with|opens up)(?: your (?:experience|skills|background|profile))?)?';
var ACK_JOIN_COMMUNITY = '(?:join|sign up for|subscribe to|opt into|opt in to|set up|create) (?:our |a |the )?(?:talent (?:community|network|pool)|job alerts?|career alerts?|job notifications)(?: URL)?' +
  '(?: (?:to|and) stay (?:connected|in touch|informed|up to date)(?: with us)?(?: (?:about|on|regarding|for) (?:future|new|other|upcoming) (?:openings|opportunities|roles|positions|jobs))?)?';
var ACK_PORTAL = '(?:your|our|the) (?:candidate |applicant |careers? |job seeker )?(?:portal|account|profile|dashboard|home|site)';
var ACK_STATUS = '(?:the status of your application|your application(?:\'s)?(?: status)?|the progress of your application)';
// Thank you for applying to the Backend Engineer role at Acme / for your interest in a career with Acme
var ACK_THANKS = '(?:thank you|thanks|many thanks)(?: so much| very much)?(?: again)?,? for (?:(?:applying|your (?:recent |online |job )?(?:application|submission)(?: and (?:your )?interest)?|your interest and (?:your )?application|submitting (?:your|an|the) application|taking the time to apply|the time to apply)' + ACK_FOR_ROLE +
  '|your interest(?: in (?:joining |working (?:at|with|for) |(?:a career|a position|a role|employment|opportunities|career opportunities) (?:at|with) )?(?:us|our team|' + ACK_ROLE_AT + '))?)(?:,? and (?:for )?(?:taking the time to apply|your interest))?';
// We encourage you to join our talent community or opt into a job alert
var ACK_COMMUNITY = '(?:we )?(?:(?:also )?(?:encourage|invite) you to|(?:please )?feel free to|be sure to|you (?:can|may)(?: also)?) ' + ACK_JOIN_COMMUNITY + '(?:,? (?:or|and) ' + ACK_JOIN_COMMUNITY + ')?';
var ACK_APPRECIATE = '(?:we )?(?:truly |really |sincerely |greatly |do )?appreciate (?:your interest(?: in (?:joining |working (?:at|with|for) |(?:a career|employment|opportunities) (?:at|with) )?(?:us|our team|' + ACK_ROLE + '))?|(?:you |your )?taking the time to apply' + ACK_FOR_ROLE + '|the time you (?:took|have taken|spent) (?:to apply|applying|on your application)|the time and effort you (?:put|have put|invested|spent) (?:into|in|on) (?:your application|applying))(?: and (?:for )?your interest(?: in (?:joining )?(?:us|our team))?)?';
var ACK_WISH = '(?:we )?(?:wish(?:ing)? you|good luck|best of luck)(?: (?:the (?:very )?best(?: of luck)?|all the best|good luck|luck|success|the best of success|every success))?(?: (?:in|with|on) your (?:job |career )?(?:search|career|future endeavou?rs))?';
var ACK_THANKS_TIME = '(?:thank you|thanks)(?: again)?(?: for (?:your (?:time|patience|interest)|thinking of us|considering (?:joining )?(?:us|our team|' + ACK_NAME + ')))?';
var ACK_CLAUSES = [
  ACK_THANKS,
  // We have received your application for the Backend Engineer role / This email confirms receipt of your application
  '(?:(?:this (?:e-?mail|message|note) (?:is to )?)?confirms? (?:that )?|(?:this is to )?confirm(?:ing)? (?:that )?|we(?:\'d| would)? (?:(?:just )?(?:want|wanted|like|are writing)(?: to)? )?(?:let you know|confirm|acknowledge)(?: that)? )?(?:we(?:\'ve| have)?(?: successfully| now| already| just)? received|we are in receipt of|(?:the )?receipt of) (?:your|the) (?:job |online |recent )?(?:application|submission|resume|cv|materials|information)(?: for the following (?:role|position|job|opening)s?:? ' + ACK_ROLE + ACK_REQ + '|' + ACK_FOR_ROLE + ')',
  // Your application for the Backend Engineer role has been received
  'your (?:job |online |recent )?(?:application|submission|resume|cv)' + ACK_FOR_ROLE + ' (?:has been|was|is|have been)(?: successfully)? (?:received|submitted)(?: successfully)?(?: (?:to|by) ' + ACK_ROLE + ')?',
  '(?:rest assured,? )?(?:your (?:application|resume|candidacy|submission) is|it is|it\'s) in (?:good|great|safe) hands',
  'we(?:\'re| are) (?:so |truly |really |genuinely )?(?:excited|thrilled|glad|happy|delighted)(?: that)? you(?:\'re| are)? (?:want to join|considering joining) (?:us|our team|' + ACK_NAME + ')',
  '(?:ps|p\\.s\\.)[:,]? if you(?:\'ve| have) applied (?:for|to) (?:multiple|several|more than one) (?:roles|positions),? you (?:may|might) hear (?:back )?from us more than once',
  '(?:your )?application (?:received|submitted|confirmation|confirmed)',
  // Our team will review your application carefully / the team is reviewing it now
  '(?:' + ACK_WHO + '(?= |\')(?: (?!\'))?)?(?:(?:will|\'ll|shall|are going to|is going to)(?: now)?(?: carefully| thoroughly| closely| personally)? (?:review|screen|be reviewing|be screening|consider|assess|evaluate|look (?:over|at|through)|read)|(?:is|are)(?: now| currently| actively)?(?: carefully)? (?:reviewing|screening|considering|evaluating|looking (?:over|at|through)|reading)) (?:it|them|(?:all )?(?:applications|submissions)|your ' + ACK_DOCS + '(?:(?:,|,? and) (?:your )?' + ACK_DOCS + '){0,3}(?: and (?:the )?next steps)?)(?: (?:for|against) ' + ACK_ROLE + ')?' + ACK_TAIL,
  // Your application will be reviewed by our recruiting team
  'your (?:application|resume|profile|submission|candidacy)' + ACK_FOR_ROLE + ' (?:will be|is being|is (?:now |currently )?being|is (?:now |currently )?under|has been (?:forwarded|passed|sent) to ' + ACK_TEAM + ' for)(?: carefully)? (?:reviewed|screened|considered|review|consideration|evaluated|taken into (?:careful )?consideration)(?: by ' + ACK_TEAM + ')?' + ACK_TAIL,
  // (If your experience matches,) we will be in touch / contact you / get back to you (if there is a match)
  '(?:' + ACK_IF + ',? )?(?:(?:' + ACK_WHO + '(?= |\')(?: (?=will|shall))?)?(?:will|\'ll|shall)(?: be sure to| certainly| definitely)? )?' + ACK_CONTACT + '(?: with you)?' + ACK_TAIL + ACK_ABOUT + ACK_TAIL + '(?:,? ' + ACK_IF + ')?',
  ACK_IF + ',? ' + ACK_INTERVIEW_STEP,
  ACK_INTERVIEW_STEP + ',? ' + ACK_IF,
  // You will hear from us (if there is a match)
  '(?:' + ACK_IF + ',? )?' + ACK_HEAR + ACK_ABOUT + ACK_TAIL + '(?:,? ' + ACK_IF + ')?',
  // Applicants who move forward to the interview stage will be contacted
  '(?:only )?(?:(?:shortlisted|selected|successful|qualified) (?:candidates|applicants)|(?:candidates|applicants) (?:who are |that are )?(?:selected|shortlisted|chosen)|(?:candidates|applicants) (?:(?:who|that) (?:move|advance|progress)|moving|advancing|progressing)(?: forward)?)(?: (?:to|for|in|into|through) (?:the |an )?(?:interview|next|hiring) (?:stage|round|step|process)| for (?:an )?interviews?)? will be (?:contacted|notified)' + ACK_BY + '(?: (?:to schedule|about|for|regarding) ' + ACK_MEETING + ')?' + ACK_TAIL,
  // Our interview process typically consists of a recruiter screen, a technical interview and an onsite
  '(?:our|the|a typical|this) (?:interview|hiring|recruiting|recruitment|selection) process (?:typically |usually |generally |will |may |can )?(?:consists? of|includes?|involves?|is made up of|comprises?)' + ' ' + ACK_STAGES,
  // We encourage you to join our talent community or opt into a job alert / stay connected
  ACK_COMMUNITY,
  '(?:we )?(?:(?:also )?encourage you to|(?:please )?feel free to) stay connected(?: with us)?(?: and (?:consider applying|apply|keep an eye out) (?:for|to) (?:future|other|new) (?:openings|opportunities|roles|positions)(?: that (?:match|fit|align with) your (?:skills|experience|interests|background)(?: and (?:skills|experience|interests|background))?)?)?',
  ACK_KEEP_ON_FILE,
  // Due to the high volume of applications, we are only able to respond to candidates selected for an interview
  '(?:due to the (?:high|large) (?:volume|number) of (?:applications|applicants|candidates)(?: we receive)?,? )?we(?: are|\'re| will(?: only)? be)(?: only)? able to (?:respond to|reply to|contact|reach out to) (?:those )?(?:candidates|applicants) (?:who are |that are )?(?:selected|shortlisted|chosen) for (?:an |the )?(?:interviews?|next steps?|next stage)',
  // We will be reaching out to candidates whose qualifications best match the requirements of the position
  '(?:we )?(?:will|\'ll) (?:be )?(?:reach(?:ing)? out to|contact(?:ing)?) (?:the )?(?:candidates|applicants) whose (?:qualifications|experience|skills|background|profiles?) (?:best |most closely )?(?:match|matches|align with|fit) (?:the|our) (?:requirements|needs)(?: (?:of|for) (?:the|this|our) (?:position|role|team))?',
  // You can track the status of your application in your candidate portal
  'you (?:can|may)(?: also)? (?:view|track|check|monitor|see|follow) ' + ACK_STATUS + '(?: at any time| anytime)?(?:,? (?:by (?:logging|signing) in(?:to| to)?|in|on|through|via|from|at) ' + ACK_PORTAL + ')?(?: at any time| anytime)?(?:(?::| here:?| at:?) URL)?',
  'to (?:view|track|check|monitor|see) ' + ACK_STATUS + ',? (?:please )?(?:log|sign) in(?:to| to)? ' + ACK_PORTAL + '(?:(?::| here:?| at:?) URL)?',
  // We appreciate your interest / are excited that you applied / wish you luck
  ACK_APPRECIATE,
  'we(?:\'re| are) (?:so |very |really |truly |genuinely )?(?:excited|thrilled|delighted|glad|happy|pleased)(?: that)? (?:(?:to hear (?:that )?)?you(?:\'re| are) interested in|you(?: would)? (?:consider(?:ed)?|are considering)|you\'re considering|you (?:applied|chose to apply)(?: (?:to|for))?|to (?:learn of|hear about|see|receive|have received) your (?:interest|application)(?: in| for| to)?)(?: (?:joining|working (?:at|with|for)))?(?: (?:us|our team|' + ACK_ROLE + '))?',
  ACK_WISH,
  ACK_THANKS_TIME,
  'welcome',
  // We can't respond to every applicant individually, so please know that we read each one
  '(?:(?:unfortunately|please (?:note|know)(?: that)?|due to (?:the |an? )?(?:incredibly |extremely |very |particularly )?(?:high|large) (?:volume|number|numbers) of (?:applications|applicants|candidates|interest)(?: (?:we receive|we(?:\'ve| have) been receiving|we(?:\'re| are) receiving))?),? ){0,2}(?:we )?(?:can\'t|cannot|can not|are unable to|aren\'t able to|are not able to|may not be able to|won\'t be able to|do not|don\'t) (?:personally |individually )?(?:respond|reply) (?:individually |personally )?to (?:every|each|all)(?: (?:applicant|application|candidate|submission)s?)?(?: (?:individually|personally))?',
  '(?:please know|rest assured) (?:that )?we (?:read|review|consider|look at) (?:each|every|all)(?: (?:one|application|applicant|submission)s?)?(?: (?:carefully|personally|we receive))?',
  '(?:only )?(?:shortlisted|selected|successful) (?:candidates|applicants) will be (?:contacted|notified)',
  'if you have (?:any )?(?:questions|concerns)(?: (?:about|regarding) (?:your application|the process|this (?:e-?mail|message)))?(?: in the meantime)?,? (?:please )?(?:feel free to )?(?:contact|e-?mail|reach out to|write to) (?:us|' + ACK_TEAM + ')(?: at EMAIL)?',
  // Where the application stands: received, with the team, being worked through
  '(?:it )?will be (?:carefully )?(?:reviewed|considered)(?: by ' + ACK_TEAM + ')?(?: to determine (?:if|whether) your (?:qualifications|experience|skills|background) (?:match|meet|align with) (?:the|our) (?:position|role|job)\'s (?:requirements|needs))?' + ACK_TAIL,
  '(?:we(?:\'re| are) )?(?:currently |still )?(?:working through|reviewing) (?:a (?:strong|large|high|great|significant) (?:pool|number|volume) of (?:candidates|applications|applicants|submissions)|(?:all )?applications)',
  '(?:we(?:\'re| are) |are )?(?:excited|eager) to learn more about you|(?:we |' + ACK_WHO + ' )?(?:look|(?:is|are|\'re) looking) forward to (?:reviewing|learning more about) (?:it|your application|your (?:background|experience|profile)|you)' + ACK_TAIL,
  'your (?:application|profile|resume|submission) is (?:with|in) (?:our hands|' + ACK_TEAM + ')(?: now)?',
  'we(?:\'re| are) giving it (?:a (?:thoughtful|careful|thorough) review|the (?:careful |full )?(?:attention|consideration) it deserves)',
  '(?:please )?keep an eye (?:out for|on) (?:a response|our response|an update|updates|your (?:inbox|e-?mail))(?: from us)?' + ACK_TAIL
];

// The boilerplate categories a confirmation may also hold, each an enumerated whole-sentence shape: thanks and
// appreciation, generic company and careers marketing, privacy and data notices, equal opportunity and pay
// transparency, accommodation and recruiting-scam warnings. A sentence in none of them keeps the thread.
var NB_NAME = ACK_NAME;
var NB_LINK = '(?:(?::| here:?| at:?)? ?\\(? ?URL ?\\)?)?';
var NB_MEANTIME = '(?:(?:in the meantime|meanwhile|until then|while you wait),? )?';
var NB_INVITE = '(?:(?:we )?(?:also )?(?:encourage|invite) you to |(?:please )?feel free to |you (?:can|may)(?: also)? |be sure to |please )?';
var NB_SOCIAL = '(?:linkedin|twitter|x|instagram|facebook|youtube|tiktok|glassdoor|threads|medium|github)(?: URL| \\( URL \\))?';
var NB_SOCIALS = NB_SOCIAL + '(?:(?: ?[•|·,/] ?|,? and |,? or )' + NB_SOCIAL + '){0,7}';
var NB_TOPIC = '(?:(?:our|the) )?(?:company|culture|mission|values|teams?|people|products?|blog|stories|news|work|benefits|perks|story|careers? (?:page|site|website)|jobs page|website|social (?:media )?channels)';
var NB_TOPICS = NB_TOPIC + '(?:(?:,| and|,? and) ' + NB_TOPIC + '){0,4}(?: page| site| blog)?';
var NB_CAREERS = '(?:our )?(?:jobs|careers?)(?: URL)? (?:page|site|website)(?: \\( URL \\)| URL)?';
var NB_CONSIDER = '(?:,? (?:as|while) we (?:give|review|carefully review|work through) (?:each|every|all) (?:application|submission|applicant|candidate)s?(?: (?:the )?(?:careful |thoughtful |full )?(?:consideration|attention|review) (?:it|they) deserves?)?)?';
var NB_SCAM_ASK = '(?:payment|money|fees?|bank(?:ing)? (?:details|information)|financial information|(?:sensitive )?personal (?:financial )?information|third-party services(?: \\(e\\.g\\.,? [a-z ]{1,30}\\))?|equipment purchases?)';
var NOTICE_CLAUSES = [
  // Appreciation
  '(?:please know (?:that )?)?we (?:truly |really |sincerely |greatly |do )?(?:value|appreciate) your (?:time|patience|interest|effort|understanding)(?:(?:,| and|,? and) (?:your )?(?:time|patience|interest|effort|understanding)){0,3}(?: in (?:us|our team|' + NB_NAME + '))?(?: in the meantime)?' + NB_CONSIDER,
  '(?:we )?(?:sincerely |truly )?thank you for your patience' + NB_CONSIDER,
  'we (?:truly |really |sincerely |greatly )?appreciate (?:you taking the time to (?:apply|submit your (?:application|information)|share your (?:story|experience|background) with us)(?: and (?:expressing |for your )?interest in (?:joining )?(?:us|our team|' + NB_NAME + '))?|the time and (?:effort|work) you (?:invested|put|spent|took) (?:in|into|on) (?:completing |submitting )?your application(?: and sharing your (?:background|experience) with us)?|your interest and the time you took to apply)',
  'we know applying takes (?:time and effort|effort and time)|we know (?:how much time and (?:effort|work|energy) goes into applying for (?:a|any) (?:new )?(?:job|position|role)|you took (?:the )?time and effort to share your (?:experience|background) with us)(?:,? (?:so|and) we (?:truly |really |sincerely )?(?:thank you for taking the time to (?:apply|explore (?:a|this) (?:career )?(?:growth )?opportunity (?:at|with) ' + NB_NAME + ')|appreciate it))?',
  'we(?:\'re| are) (?:so |very |really |truly |genuinely )?(?:thrilled|excited|delighted|glad|happy) to see your interest in joining (?:us|our team|' + NB_NAME + ')(?:,? and (?:we )?appreciate you taking the time to submit your application)?',
  '(?:we(?:\'re| are) grateful for|we appreciate) your interest in ' + NB_NAME + '(?:,? and look forward to the possibility of connecting(?: further)?)?',
  '(?:we appreciate you|thank you for|we(?:\'re| are) (?:thrilled|delighted|excited|glad|happy) that you(?: have| would)?) (?:considering|consider(?:ed)?|chosen|chose) (?:us|' + NB_NAME + ') (?:as|for) (?:a |the |your )?(?:potential |possible )?next step in your career',
  // Sign-offs inside a paragraph ("Regards, Acme Recruiting") and a closing cheer ("Happy hunting!")
  '(?:best|best regards|kind regards|warm regards|regards|sincerely|cheers|thanks|thank you),? (?:the )?' + NB_NAME + ' (?:recruiting|recruitment|talent(?: acquisition)?|people|hiring|hr|careers)(?: team)?',
  'happy ' + NB_NAME,
  '(?:the |your )?(?:' + NB_NAME + ' )?(?:(?:recruiting|recruitment|talent(?: acquisition)?|people|hiring|hr|careers)(?: team)?|team)|(?:recruiting|recruitment|talent(?: acquisition)?|people|hiring|hr|careers)(?: team)? (?:@|at) ' + NB_NAME,
  '(?:the )?' + NB_NAME + ',? (?:inc|llc|ltd|corp|co|gmbh|plc)\\.?',
  'we know how much time and (?:effort|work|energy) go(?:es)? into applying for (?:a|any) (?:new )?(?:job|position|role)(?: - |, |; )congratulations on taking (?:this|the) first step',
  // Company and careers marketing
  NB_MEANTIME + NB_INVITE + '(?:explore|learn (?:more )?about|read (?:more )?about|discover|get to know|check out|find out more about|take a (?:look|peek) at) (?:more )?(?:about )?(?:us|' + NB_TOPICS + '|what (?:we(?:\'re| are)|it\'s like) (?:building|doing|working on|to work (?:at|here|with us))|life at ' + NB_NAME + '|' + NB_NAME + ')(?: (?:at|on|in|through) (?:URL|our website|' + NB_NAME + '|' + NB_CAREERS + '|' + NB_TOPIC + ')(?::? URL(?: ?,? (?:and )?URL){0,4})?(?: and URL)?)?' + NB_LINK + '(?: to (?:learn more|get a (?:feel|sense) for (?:what it\'s like to work here|our culture)))?',
  NB_MEANTIME + NB_INVITE + 'check us out' + NB_LINK + '(?: to explore ' + NB_NAME + ' firsthand)?',
  NB_MEANTIME + '(?:to (?:stay|keep) (?:connected|up to date|in touch|up with the latest(?: ' + NB_NAME + ')? news),? )?' + NB_INVITE + '(?:(?:stay connected|keep up)(?: with us)? by )?(?:follow(?:ing)?|connect(?:ing)? with) (?:us|' + NB_NAME + ')(?: on (?:' + NB_SOCIALS + '|our social (?:media )?channels:?(?: URL(?:(?:,| and|,? and) URL)*)?))?(?: page)?' + NB_LINK + '(?: or check out our (?:latest )?blog(?: post)?(?: here)?' + NB_LINK + ')?',
  '(?:follow us|connect with us|find us on|stay connected)[:]? ' + NB_SOCIALS,
  '(?:if (?:you are|you\'re) not selected for this (?:position|role)|if this (?:role|position) (?:isn\'t|is not) the right fit(?: (?:at this time|right now))?)?,? ?(?:(?:please )?feel free to apply (?:to|for) (?:other|others|additional)(?: (?:roles|positions|openings|opportunities))?(?: that (?:may be|are) of interest)?,? or )?(?:we )?(?:encourage you to )?(?:keep an eye on|continue (?:exploring|to explore|checking|to check)(?: (?:other )?(?:career )?opportunities on)?) ' + NB_CAREERS + '(?:,? (?:as|since) we(?:\'re| are)? (?:always |constantly )?(?:growing|grow|hiring)(?:(?:,| and) (?:adding|continue to add|posting|add) (?:new )?(?:openings|opportunities|roles|positions))?)?',
  // Privacy and data notices
  'protecting your privacy and the security of your (?:personal )?(?:data|information) (?:are|is) (?:a |among )?(?:(?:longstanding|long-standing|top|our) )*priorit(?:y|ies)(?: (?:for|at) ' + NB_NAME + ')?',
  '(?:the |any )?(?:information|personal data|data|personal information) (?:you provide|you(?:\'ve| have) provided|you submit(?:ted)?)(?: to us)? will be (?:used|processed|handled|stored)(?: and (?:stored|processed))? (?:in accordance with|according to|as described in|under) (?:our|the|' + NB_NAME + ') (?:applicant and candidate |candidate |applicant |recruitment )?privacy (?:policy|notice|statement)' + NB_LINK,
  'if you are an? (?:internal|external) candidate,? (?:please )?(?:consult|see|read|review|refer to) (?:our|the) (?:employee |candidate |applicant )?privacy (?:policy|notice|statement)' + NB_LINK + '(?: (?:to (?:learn|know) more about|for (?:more )?information (?:on|about)) how we (?:collect|use|process|transfer|store|protect)(?:(?:,| and|,? and) (?:collect|use|process|transfer|store|protect)){0,3} (?:the |your )?personal (?:data|information)(?: of our (?:candidates|applicants))?)?',
  '(?:read|view|see) (?:the|our) (?:full )?(?:policy|privacy policy|privacy notice|privacy statement)(?: \\(pdf\\))?' + NB_LINK,
  '(?:to learn more about|for (?:more )?information (?:about|on)) our (?:candidate |applicant )?privacy (?:policy|notice|practices),? (?:you can |please )?(?:read|see|view|review) our statement(?: here)?' + NB_LINK,
  'you can let us know if you (?:do not|don\'t|no longer) (?:want|wish) to be contacted for recruit(?:ment|ing) purposes',
  '(?:for (?:more )?(?:details|information) (?:on|about)|to learn (?:more )?about) how we (?:collect|use|process|handle|protect|store)(?:(?:,| and|,? and) (?:collect|use|process|handle|protect|store)){0,3} your (?:personal )?(?:data|information)(?: during (?:this|the|our) (?:process|hiring process|recruiting process))?,? (?:please )?(?:review|see|read|visit|refer to|consult) (?:our|the) (?:(?:candidate |applicant )?privacy (?:policy|notice|statement) ?)?URL',
  '(?:regardless of the outcome of your application,? )?we (?:will|may) (?:retain|keep|store) your (?:details|information|data|application|resume)(?: on file)?(?: for (?:future reference|future opportunities))?(?: in accordance with (?:your local|applicable|our) (?:privacy|data protection) (?:laws|policy|notice))?',
  // Equal opportunity and pay transparency
  '(?:pay transparency (?:policy|nondiscrimination provision) )?(?:(?:our|the|' + NB_NAME + ') )?pay transparency (?:policy|nondiscrimination provision) (?:ensures|states|provides|means) that you (?:won\'t|will not) be (?:discharged|discriminated against)(?: or (?:in any other manner )?(?:discharged|discriminated against))? (?:based on|because) (?:whether )?you(?:\'ve| have)? (?:inquired about|discussed|disclosed)(?:(?:,| or|,? or) (?:inquired about|discussed|disclosed)){0,2} your (?:own )?(?:pay|compensation)',
  'learn more about (?:our|the) (?:equal (?:employment )?opportunity|eeo|pay transparency|diversity(?: and inclusion)?) (?:policy|statement)' + NB_LINK + '(?: and the eeoc\'s "equal employment opportunity is the law"(?: poster)?(?: \\(pdf\\))?' + NB_LINK + ')?',
  // Accommodation
  'if you (?:have a disability(?: or special need)?|are an individual with a disability|need|require)(?: that requires| and need| and require)? (?:an? )?(?:reasonable )?accommodations?(?: or (?:assistance|adjustments))? (?:to|in order to|for) (?:navigate our website|complete the application process|apply|use our (?:website|careers site))(?:(?:,| or) (?:navigate our website|complete the application process))*,? (?:please )?(?:e-?mail|contact)(?: us at)? EMAIL',
  // Hiring-process FAQ pointers
  'if you have (?:any )?questions about (?:the|our) (?:hiring|recruiting|interview|application) process(?: at ' + NB_NAME + ')?,? (?:you (?:might|may|can|will) find (?:the |some )?answers (?:on|in) our ?(?:common|frequently asked) questions|(?:please )?(?:see|visit|read) our (?:faq|frequently asked questions))' + NB_LINK + '(?: page)?',
  // Recruiting-scam warnings
  '(?:beware of (?:recruiting |recruitment |job )?(?:scams|fraud)[:,]? )?(?:we|' + NB_NAME + ') (?:will )?never (?:ask|request|require)(?: (?:you|candidates|applicants))?(?: for| to (?:pay|make|send|provide|purchase))? (?:any )?' + NB_SCAM_ASK + '(?:(?:,| or| and|,? or) ' + NB_SCAM_ASK + '){0,4}(?: (?:as part of|during) (?:our|the) (?:hiring|recruiting|recruitment|application) process)?'
];
// A heading before the boilerplate ("What's next?", "Here's what happens next:").
var ACK_NEXT = '(?:what\'s next|what happens next|what to expect(?: next)?|next steps|here\'s what happens next|here is what happens next|here\'s what to expect|here is what to expect)';
function ackSentence_(clauses) {
  var clause = '(?:' + clauses.join('|') + ')';
  var lead = '(?:(?:again|once again|also|additionally|in addition|in the meantime|meanwhile|unfortunately|please note(?: that)?|we (?:want|wanted) (?:you to know|to let you know)(?: that)?|(?:while|although) we(?:\'re| are) (?:not able|unable) to (?:reach out to|respond to|reply to|contact) (?:every|each|all) (?:applicants?|candidates?)),? )?';
  return new RegExp('^(?:' + ACK_NEXT + '[:?]? )?(?:' + ACK_NEXT + '\\??|' + lead + clause + '(?:(?:(?:,? and|,? but|,? so|;|,| -) | ?[—–] ?)' + lead + clause + '){0,3})$', 'i');
}
var ACKNOWLEDGEMENT = ackSentence_(ACK_CLAUSES.concat(NOTICE_CLAUSES));
var NOTICE = ackSentence_(NOTICE_CLAUSES);

/** True when the whole sentence is one of the enumerated boilerplate categories or a standard footer. */
function notice_(sentence) {
  var s = String(sentence || '').replace(/&nbsp;| /g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1 URL').replace(/<?(?:https?:\/\/|www\.)[^\s>]*[^\s>.,;:!?)]>?/gi, ' URL ')
    .replace(/<?[\w.+-]+@[\w-]+(?:\.[\w-]+)+>?/g, ' EMAIL ').replace(/\s+/g, ' ').trim();
  return footer_(s) || acknowledges_(NOTICE, s);
}

var GREETING_NAME = "(?: (?:[A-Z][A-Za-z'.-]*|there|all|team|candidate|applicant)){0,4}";
var GREETING_LINE = new RegExp('^(?:(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Gg]reetings|HI|HELLO|DEAR),?' + GREETING_NAME + ' ?[,!:.-]?|[A-Z][a-z\'-]+(?: [A-Z][a-z\'-]+)? ?,)$');
var GREETING_PREFIX = new RegExp('^(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Gg]reetings),?' + GREETING_NAME + ', ');
var SIGN_OFF = /^(?:best|kindly|best of luck|good luck|best regards|kind regards|warm regards|warmest regards|regards|warmly|sincerely|sincerely yours|yours sincerely|yours truly|respectfully|cheers|all the best|best wishes|many thanks|thanks|thank you|thanks again|thank you again|with appreciation|with gratitude)(?:\s*[,.!]\s*|\s*$)/i;
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
var FOOTER_CLAUSES = [
  // Do not reply / unattended mailbox / automated message
  '(?:please )?(?:do not|don\'t|kindly do not) (?:reply|respond)(?: directly)?(?: to (?:this|the|it|this ' + FOOTER_MAIL + ')(?: address)?)?',
  '(?:(?:this|the) ' + FOOTER_MAIL + '|it) (?:is|was|has been) (?:sent|generated|delivered) (?:from|by) an? (?:unattended|unmonitored|automated|send-only|no-?reply|system)(?: (?:mailbox|e-?mail address|address|account|inbox|system))?',
  '(?:this|the|it) (?:' + FOOTER_MAIL + ' )?(?:is|was|has been) (?:automatically|system|auto)[ -]generated',
  'report this ' + FOOTER_MAIL + '(?: as (?:spam|phishing))?' + FOOTER_LINK,
  '(?:we|' + FOOTER_NAME + ') (?:seek|aim|strive) to promote equal opportunity for all applicants without regard to ' + FOOTER_EEO_LIST,
  '(?:this|the|our) (?:e-?mail address|mailbox|inbox|address|account) (?:is not|isn\'t) (?:monitored|checked)|(?:this|the|our) (?:e-?mail address|mailbox|inbox|address|account) is (?:unmonitored|unattended)',
  'replies (?:to this (?:e-?mail|message|address) )?(?:will not|won\'t|are not|cannot|can not|will never) (?:be )?(?:read|monitored|received|answered|seen|reviewed)(?: by (?:the |our )?(?:recruiting|recruitment|talent acquisition|hiring|hr) team)?',
  'this is an? (?:automated|automatic|system|system-generated|auto-generated|automatically generated) ' + FOOTER_MAIL + '(?: response| reply)?(?: from ' + FOOTER_ATS + ')?',
  '(?:this|the) ' + FOOTER_MAIL + ' (?:was|is) (?:intended for|sent to|delivered to|addressed to) EMAIL',
  'we (?:can\'t|cannot|can not|are unable to|aren\'t able to|are not able to|do not|don\'t) (?:review|read|monitor|respond|reply)(?: (?:or|and) (?:review|read|respond|reply))?(?: to)? (?:messages|e-?mails|replies|responses)(?: (?:sent )?(?:to|at) this (?:address|mailbox|e-?mail address))?',
  '(?:ref|reference|message id|msg id)(?: ?(?:no|number|#))?[.:#]? ?[a-z0-9_-]{6,}',
  // Sent by / powered by an ATS
  '(?:(?:this|the) ' + FOOTER_MAIL + ' (?:was|is|has been) )?(?:sent|powered|delivered|generated) (?:by|via|with|through|from|using) (?:the )?' + FOOTER_ATS + '(?: (?:platform|system))?(?: on behalf of ' + FOOTER_NAME + ')?',
  // Unsubscribe, manage preferences, privacy policy
  FOOTER_ITEM + '(?: ?[|·•,] ?' + FOOTER_ITEM + '){0,5}',
  '(?:to|if you(?:\'d| would)? (?:no longer )?(?:wish|want|like) to) (?:unsubscribe|stop receiving (?:these|such|future) (?:e-?mails|messages|notifications))(?: from ' + FOOTER_STOP + ')?,? (?:please )?(?:click (?:here|the link below|URL)|visit URL|go to URL|URL)',
  'click (?:here|URL) to (?:unsubscribe|manage (?:your )?(?:e-?mail )?(?:preferences|subscriptions))(?: from ' + FOOTER_STOP + ')?',
  'you (?:can|may) unsubscribe(?: from ' + FOOTER_STOP + ')?(?: at any time)?(?: (?:here|URL))?',
  '(?:(?:to learn more|for (?:more )?information|for details) (?:about|on) how (?:we|' + FOOTER_NAME + ') (?:collects?|uses?|processes|handles?|protects?)(?:(?:,| and|,? and) (?:collects?|uses?|processes|handles?|protects?)){0,3} your (?:personal )?(?:data|information),? )?(?:please )?(?:see|read|review|visit|refer to|view) (?:our|the) (?:candidate |applicant )?privacy (?:policy|notice|statement)' + FOOTER_LINK,
  // Equal opportunity
  '(?:we|' + FOOTER_NAME + ') (?:is|are) (?:proud to be )?an? (?:proud )?equal (?:employment )?opportunity(?: and affirmative action)? employer(?: that is committed to (?:inclusion and diversity|diversity and inclusion))?(?:,? (?:m/f/d/v|minorities/females/veterans/disabled|minorities/women/veterans/disabled))?',
  '(?:an? )?equal (?:employment )?opportunity(?: and affirmative action)? employer|eoe|eeo',
  'all qualified applicants will receive consideration for employment without regard to ' + FOOTER_EEO_LIST,
  '(?:(?:we|' + FOOTER_NAME + ') )?(?:does not|do not|will not) discriminate (?:against any (?:applicant|employee) )?(?:on the basis of|based on|because of) ' + FOOTER_EEO_LIST,
  // Copyright
  '(?:copyright(?: ©| \\(c\\)| @)?|©|\\(c\\)) ?(?:\\d{4}(?: ?[-–] ?\\d{4})?,? ?)?(?:' + FOOTER_NAME + '(?:,? (?:inc|llc|ltd|corp|co|gmbh|plc)\\.?)?)?(?:,? all rights reserved)?',
  'all rights reserved',
  // Confidentiality notice
  '(?:this|the information in this) (?:e-?mail|message|communication|transmission)(?:,? (?:and|including|together with) any (?:attachments|files transmitted with it)(?: (?:to|with) it)?,?)? (?:is|are|may be|may contain information that is|contains information that (?:is|may be)) (?:strictly )?(?:confidential|privileged|proprietary)(?:(?:,| and|,? and/or|,? or) (?:legally )?(?:confidential|privileged|proprietary)){0,2},? and (?:(?:is|are) )?intended (?:solely|only|exclusively) for (?:the use of )?the (?:addressee|recipient|individual|person|entity|intended recipient)(?:\\(s\\)|s)?(?: (?:or|and) (?:entity|entities))?(?: (?:to whom|to which) (?:it is|they are) addressed| named above)?',
  'if you are not the intended recipient(?:,? (?:please )?notify the sender(?: immediately)?(?: and delete (?:it|this ' + FOOTER_MAIL + ')(?: from your system)?)?)?',
  'if you (?:have )?received this ' + FOOTER_MAIL + ' (?:in error|by mistake),? (?:please )?notify the sender(?: immediately)?(?: and delete (?:it|this ' + FOOTER_MAIL + ')(?: from your system)?)?'
];
var FOOTER_CLAUSE = new RegExp('^(?:(?:please note|note|important)[:,]? )?(?:' + FOOTER_CLAUSES.join('|') + ')$', 'i');
var FOOTER_JOIN = /[,;:]? (?:and|as|because|since|so) |[,;:] |(?<=EMAIL) /g;

// A mailing address is a footer only as a whole sentence of its own, read case-sensitively: a house number, one to
// four capitalised street words (or ordinals like 5th), a street suffix, then a city with a state and ZIP code or a
// suite. Street, city and company words hold no time, day, action or meeting word ("1 pm Thursday at 350 Mission St").
var ADDRESS_WORD = "[A-Z][A-Za-z'.-]*";
var ADDRESS_STREET = '\\d{1,6} ((?:(?:' + ADDRESS_WORD + '|\\d{1,3}(?:st|nd|rd|th)) ){1,4})(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Plaza|Parkway|Pkwy|Court|Ct|Place|Pl|Square|Sq|Highway|Hwy|Circle|Cir)\\.?';
var ADDRESS_UNIT = '(?:(?:Suite|Ste|Floor|Fl|Unit|Room|Rm)\\.? ?#?[A-Za-z0-9-]{1,6}|#[A-Za-z0-9-]{1,6}|\\d{1,3}(?:st|nd|rd|th) Floor)';
var ADDRESS_SEP = '(?:,| ·| •| \\|) ';
var ADDRESS_CITY = '(' + ADDRESS_WORD + '(?: ' + ADDRESS_WORD + '){0,3}), [A-Z]{2}';
var ADDRESS_ZIP = ' \\d{5}(?:-\\d{4})?(?:,? (?:USA|US|United States))?';
var ADDRESS_COMPANY = '(?:(' + ADDRESS_WORD + '(?: (?:' + ADDRESS_WORD + '|of|&)){0,5})(?:,? (?:Inc|LLC|Ltd|Corp)\\.?)?' + ADDRESS_SEP + ')?';
var ADDRESS_SHAPES = [
  new RegExp('^' + ADDRESS_COMPANY + ADDRESS_STREET + '(?:,? ' + ADDRESS_UNIT + ')?' + ADDRESS_SEP + ADDRESS_CITY + ADDRESS_ZIP + '$'),
  new RegExp('^' + ADDRESS_COMPANY + ADDRESS_STREET + ',? (?:Suite|Ste)\\.? ?#?[A-Za-z0-9-]{1,6}(?:' + ADDRESS_SEP + ADDRESS_CITY + ')?$'),
  new RegExp('^' + ADDRESS_UNIT + ADDRESS_SEP + ADDRESS_CITY + ADDRESS_ZIP + '$'),
  new RegExp('^' + ADDRESS_CITY + ADDRESS_ZIP + '$')
];
var ADDRESS_VETO_WORD = /\b(?:at|see|meet\w*|noon|o'?clock)\b/i;

function addressFooter_(sentence) {
  return ADDRESS_SHAPES.some(function (re) {
    var m = re.exec(sentence);
    return !!m && m.slice(1).every(function (g) {
      return !g || (g.length <= 60 && !ACK_VETO_WORD.test(g) && !ADDRESS_VETO_WORD.test(g));
    });
  });
}

function footerClause_(clause) {
  var m = FOOTER_CLAUSE.exec(clause);
  return !!m && m.slice(1).every(function (g) {
    return !g || (g.length <= 60 && FOOTER_NAME_SHAPE.test(g) && !ACK_VETO_WORD.test(g));
  });
}

function footerClauses_(text, depth) {
  if (footerClause_(text) || (depth > 0 && addressFooter_(text))) return true;
  if (depth >= 3) return false;
  var join = new RegExp(FOOTER_JOIN.source, 'g'), m;
  while ((m = join.exec(text))) {
    if (footerClause_(text.slice(0, m.index)) && footerClauses_(text.slice(m.index + m[0].length), depth + 1)) return true;
  }
  return false;
}

/** True when the whole sentence is a standard footer. */
function footer_(sentence) {
  var s = String(sentence).replace(/\s+/g, ' ').replace(/[.!*]+$/, '').trim();
  return !!s && s.length <= 400 && (addressFooter_(s) || footerClauses_(s, 0));
}

var NOT_A_NAME = /^(?:unfortunately|however|sadly|regrettably|congratulations|welcome|update|reminder|attention|note|notice|urgent|action|hooray|great|good|news)\b/i;

function greetingName_(greeting) {
  if (!/^(?:hi|hello|hey|dear|greetings)\b/i.test(greeting) && NOT_A_NAME.test(greeting)) return false;
  var name =greeting.replace(/^(?:hi|hello|hey|dear|greetings)\b|\b(there|all|team|candidate|applicant)\b/gi, '');
  return !ACK_VETO_WORD.test(name) && !SCHEDULING_WORDS.test(name);
}

// Signature lines, an allowlist: a line is set aside only when the whole line is one of these shapes. A person's name
// counts only directly under the sign-off (or above a job title when there is none), so "Technical Project
// Instructions" or "Let's Connect Soon" under a signature is body text. Names and companies hold no action word.
var SIG_COMPANY = "([A-Z][A-Za-z'&.-]*(?: (?:[A-Z][A-Za-z'&.-]*|&|of)){0,3})";
var SIG_NAME_WORD = "(?:[A-Z][a-z]+(?:[A-Z][a-z]+)?|[A-Z](?=[-']))(?:[-'][A-Z][a-z]+)*";
var SIG_NAME = new RegExp('^' + SIG_NAME_WORD + '(?: [A-Z]\\.)?(?: ' + SIG_NAME_WORD + '){1,2}$');
var SIG_DEPT = '(?:Recruiting|Recruitment|Talent Acquisition|Talent|People|People Operations|Hiring|HR|Human Resources|Careers)';
var SIG_TITLE_NOUN = '(?:Recruiter|(?:Recruiting|Recruitment) (?:Coordinator|Manager|Lead|Partner)|Sourcer|Talent Acquisition (?:Partner|Specialist|Manager|Lead|Coordinator)|Talent Partner|People Partner|HR (?:Manager|Generalist|Business Partner|Coordinator)|Hiring Manager|Engineering Manager|Founder|Co-[Ff]ounder|CEO|CTO|Head of (?:Talent|People|Recruiting))';
var SIG_TITLE_LINE = new RegExp('^(?:([A-Z][A-Za-z.-]*(?: [A-Z][A-Za-z.-]*){0,2}) )?' + SIG_TITLE_NOUN + '(?: (?:&|and) ' + SIG_TITLE_NOUN + ')?(?:(?: at|,| \\||| -| –| —| @) ' + SIG_COMPANY + ')?$');
// A phone number has ten digits, or eight after a +, and is not a date or time range ("2026-11-05", "10.30 - 11.30").
var SIG_PHONE = '(?:(?:Phone|Tel|Mobile|Cell|[MPTO])[:.]? ?)?(?!\\d{1,4}[./ -]\\d{1,2}[./ -]\\d{1,4}(?![\\d ().-]))(?:\\+(?=(?:[ ().-]*\\d){8})|(?=(?:[ ().-]*\\d){10}))[\\d(][\\d ().-]{6,18}\\d';
var SIG_CONTACT = '(?:' + SIG_PHONE + '|EMAIL|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|io|co|ai|org|net|dev|app|jobs))';
var SIG_SHAPES = [
  new RegExp('^(?:The )?(?:' + SIG_COMPANY + ' )?(?:' + SIG_DEPT + '(?: Team)?|Team)$'),
  new RegExp('^' + SIG_DEPT + '(?: Team)? (?:@|at) ' + SIG_COMPANY + '$'),
  new RegExp('^' + SIG_COMPANY + ',? (?:Inc|LLC|Ltd|Corp|Co|GmbH|Labs|Technologies|AI)\\.?$'),
  new RegExp('^' + SIG_CONTACT + '(?: ?[|·•,\\/] ?' + SIG_CONTACT + '){0,3}$')
];

function sigWords_(m) {
  return !!m && m.slice(1).every(function (g) { return !g || !ACK_VETO_WORD.test(g); });
}

/** A signature line other than a person's name: a job title, a team, a company, or contact details. A bare company
 *  name of one to four capitalised words counts only when the body above already names it. */
function signatureLine_(line, above) {
  var s = line.replace(/\.$/, '');
  if (sigWords_(SIG_TITLE_LINE.exec(s)) || SIG_SHAPES.some(function (re) { return sigWords_(re.exec(s)); })) return true;
  var company = new RegExp('^' + SIG_COMPANY + '$').exec(s);
  return sigWords_(company) && new RegExp("(?:^|[^A-Za-z'&-])" + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "(?![A-Za-z'&-])").test(above);
}

function signatureName_(line) { return SIG_NAME.test(line.replace(/\.$/, '')) && !ACK_VETO_WORD.test(line); }

/** Marks the signature lines from index `from` on: an optional name first, then title, team, company and contact
 *  lines, stopping at the first line that is none of these or at a blank line. */
function dropSignature_(lines, drop, from, nameAllowed, above) {
  for (var j = from; j < lines.length && lines[j]; j++) {
    if (!drop[j] && !signatureLine_(lines[j], above) && !(nameAllowed && j === from && signatureName_(lines[j]))) return;
    drop[j] = true;
  }
}

/** The body once the greeting, the sign-off with its signature and the footer lines are set aside:
 *  { line: a set-aside greeting or signature line holding a scheduling word (or null), sentences[], paragraphs[] }. */
function bodyParts_(body) {
  var text = String(body || '').replace(/\r/g, '').replace(/&nbsp;| /g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/^[ \t|]*\|[ \t]*|[ \t]*\|[ \t|]*$/gm, '').replace(/[ \t]*\|(?:[ \t]*\|)+[ \t]*/g, '\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1 URL')
    .replace(/<?(?:https?:\/\/|www\.)[^\s>]*[^\s>.,;:!?)]>?/gi, ' URL ')
    .replace(/<?[\w.+-]+@[\w-]+(?:\.[\w-]+)+>?/g, ' EMAIL ');
  var raw = text.split('\n');
  var lines = raw.map(function (l) { return l.replace(/\s+/g, ' ').replace(/^(?:[*•·>-]+ ?)+/, '').trim(); });
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
    if (!off) continue;
    var above = lines.slice(0, i).join('\n'), rest = line.slice(off[0].length);
    if (rest && !signatureLine_(rest, above) && !signatureName_(rest)) continue;
    signedOff = true;
    drop[i] = true;
    for (j = i + 1; j < lines.length && !lines[j]; j++);
    dropSignature_(lines, drop, j, !rest, above);
  }
  // Without a sign-off, only the one unbroken block of signature lines that ends the body is a signature; a name in it
  // counts only directly above a job title.
  for (i = lines.length - 1; i >= 0 && !lines[i]; i--);
  for (; !signedOff && i >= 0 && lines[i]; i--) {
    if (footerLine[i]) continue;
    if (signatureLine_(lines[i], lines.slice(0, i).join('\n'))) { drop[i] = true; continue; }
    if (signatureName_(lines[i]) && SIG_TITLE_LINE.test(lines[i + 1] || '')) drop[i] = true;
    break;
  }
  var odd = null;
  for (i = 0; i < lines.length && !odd; i++) {
    if (drop[i] && !footerLine[i] && SCHEDULING_WORDS.test(lines[i].replace(/\b(?:Phone|Tel|Mobile|Cell)\b[:.]?/g, ''))) odd = lines[i];
  }
  // A paragraph of one line may be a signed name only under a sign-off line or as a "- Name" line.
  var paragraphs = [], signable = [], current = [], signed = false, before = '';
  var close = function () {
    if (current.length) { paragraphs.push(current.join(' ')); signable.push(current.length === 1 && signed); }
    current = [];
  };
  lines.forEach(function (l, k) {
    if (!l || drop[k]) { close(); if (l) before = l; return; }
    if (!current.length) signed = /^\s*-\s*\S/.test(raw[k]) || RJ_SIGN_OFF_LINE.test(before);
    current.push(l);
    before = l;
  });
  close();
  var sentences = [];
  paragraphs.forEach(function (p) { sentences = sentences.concat(lineSentences_(p)); });
  return { line: odd, sentences: sentences, paragraphs: paragraphs, signable: signable };
}

/** The first body sentence that is neither a known acknowledgement nor a standard footer once the greeting, the
 *  sign-off with its signature and the footer lines are set aside, or null when every sentence is one. */
function unacknowledged_(body) {
  var parts = bodyParts_(body);
  if (parts.line) return parts.line;
  for (var s = 0; s < parts.sentences.length; s++) {
    if (!footer_(parts.sentences[s]) && !acknowledges_(ACKNOWLEDGEMENT, parts.sentences[s])) return parts.sentences[s];
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

function acknowledges_(re, sentence, vetoWord) {
  var greeting = GREETING_PREFIX.exec(sentence);
  var s = (greeting && greetingName_(greeting[0]) ? sentence.slice(greeting[0].length) : sentence)
    .replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
  if (!s) return true;
  if (s.length > 300) return false;
  var m = re.exec ? re.exec(s) : shapeMatch_(re, s);
  return !!m && m.slice(1).every(function (g) {
    return !g || (g.length <= 80 && !SCHEDULING_WORDS.test(g) && !(vetoWord && vetoWord.test(g)));
  });
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
  [2, /\b(not able|unable) to (move forward|proceed|advance|pursue|invite you|provide you with (a |an )?(suitable )?(position|role|opportunity))\b|\b(won't|will not|can't|cannot) be able to (invite|move you|advance|proceed)\b/i],
  [2, /\b(do not|don't|didn't|did not) see (a|the|an) (right |good |strong |direct )?(match|fit)\b|\b(isn't|is not|wasn't|was not) a direct (match|fit)\b/i],
  [2, /\bmade the (choice|decision) to (pursue|move forward with|proceed with|go with) (other|another|different) (candidates?|applicants?)\b/i],
  [2, /\b(will )?not be hiring for (this|the) (position|role)\b/i],
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
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
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

// A rejection that asks the candidate to reply ("please let us know if you are willing to relocate") needs an answer.
var REPLY_REQUEST = /\bplease (let us know|let me know|reply|respond|get back to (us|me)|confirm)\b[^.?!]{0,80}\b(if|whether) you(['’]re| are| would| were| can)\b/i;

// A rejection that might invite further contact is no plain rejection, so it stays in the Inbox ("Unfortunately we
// don't see a direct fit. Can we talk?"). Outside the footer, any of these keeps it: a question that does more than
// offer help with questions; a call, chat, talk, meeting or conversation not only thanked for as past; another role,
// team or opening, an interest in you for a role or a resume passed along, unless the sentence points to the job board;
// a handoff to another team or role; a promise that someone will reach out that is not tied to a future opening; a
// contact ACTION_SIGNALS kind (a question to you, a conversation, a date or time, a meeting tool, a request or an
// imperative); or a booking or meeting link anywhere.
var CONTACT_KINDS = ['question', 'conversation', 'date or time', 'tool', 'request', 'imperative'];
var CONTACT_SIGNALS = ACTION_SIGNALS.filter(function (sig) { return CONTACT_KINDS.indexOf(sig[0]) >= 0; });
var CONTACT_WORDS = /\b(call|chat|chats|chatting|talk|talks|talking|speak|speaking|meet|meeting|meetings|conversations?|discuss|discussing|discussions?|catch up|hop on|jump on|connect (with )?you)\b/i;
var CONTACT_PAST = /\bthank(s| you)\b[^.!?]*\b(for|of)\b[^.!?]*\b(time|speaking|talking|meeting|chatting|conversations?|calls?|chats?|discussions?)\b|\b(spoke|talked|met|chatted|discussed)\b|\bpleasure (of )?(speaking|meeting|talking|chatting|getting to know)\b|\b(enjoyed|appreciated|appreciate|valued) (\w+ ){0,3}(speaking|meeting|talking|chatting|conversations?|calls?|discussions?)\b/i;
// Thanks for past time does not cancel a call still to come ("Thank you for your time; our VP would like to call you").
var FORWARD_MODAL = /\b(would|['’]d) (like|love)\b|\b(will|['’]ll|can|could|let['’]s)\b/i;
var OTHER_ROLE = /\b(other|another|different|alternative|alternate|additional|new|separate|similar|related|open) (\w+ ){0,2}(roles?|positions?|openings?|opportunit(y|ies)|teams?|jobs?|reqs?|requisitions?|vacanc(y|ies)|departments?|groups?)\b|\binstead\b/i;
// "We encourage you to check our careers page for other openings" points to the job board, not to a conversation, and
// so does a status disclaimer ("if you have applied for other roles", "should your qualifications fit").
var JOB_BOARD = /\b(re)?appl(y|ying|ied|ications)\b|\bcareers?\b|\b(site|page|website|postings?|job board|listings?)\b|\b(visit|view|check|monitor|explore|exploring|browse|follow|keep an eye)\b|\bstay (informed|connected|in touch)\b|\b(if|whether) you(['’]re| are| have|['’]ve)? (currently )?(applied|interviewing)\b|\b(arise|comes? up|open up|opens up|become available|becomes available|posted)\b|\bfuture\b|\bshould (your|we|there|a|an|any|the)\b/i;
var WANTS_YOU = /\b(consider|considering) you\b|\byou (could|would|might|may|will) be (a |an )?(\w+ )?fit\b|\b(interested in|keen on|excited about) (you|your (profile|background|experience))\b|\b(we|I)(['’]ve| have| will|['’]ll| would|['’]d| are|['’]re| am|['’]m)? (also )?(pass|passed|passing|forward|forwarded|forwarding|share|shared|sharing|refer|referred|referring)( along)? your\b/i;
var CONDITIONAL_CONTACT = /\b(if|should|when|whenever|once|in case|in the event|as soon as)\b/i;
// A handoff to another team or role: reply if interested, a reach-out tied to your interest, a profile shared with a
// team, being put in touch, or an email to schedule next steps.
var HANDOFF = /\breply to (this|our|my) (e-?mail|message|note)\b|\bto schedule (next steps|a |an |time)|\bhear from (them|him|her|the|our)\b|\b(put|get|got) you in touch\b|\byour (profile|resume|r[ée]sum[ée]|cv|details|information) (has|have) been (shared|forwarded|passed|referred)\b|\bif (the|this|that|our) [^.!?]{0,40}interests you\b|\byou(['’]re| are) interested\b/i;

function contactSentence_(sentence) {
  var questions = ABOUT_QUESTIONS.test(sentence);
  if (!questions && /\?/.test(sentence)) return true;
  if (CONTACT_SIGNALS.some(function (sig) { return !(questions && sig[2]) && sig[1].test(sentence); })) return true;
  if ((WANTS_YOU.test(sentence) || OTHER_ROLE.test(sentence)) && !FUTURE_ONLY.test(sentence) && !JOB_BOARD.test(sentence)) {
    return true;
  }
  if (HANDOFF.test(sentence)) return true;
  if (CONTACT_WORDS.test(sentence) && (!CONTACT_PAST.test(sentence) || FORWARD_MODAL.test(sentence))) return true;
  return FUTURE_CONTACT.test(sentence) && !FUTURE_ONLY.test(sentence) && !CONDITIONAL_CONTACT.test(sentence);
}

/** The first link or sentence that might invite further contact, or null. Footer sentences are set aside. */
function invitesContact_(body) {
  var link = String(body || '').match(ACTION_LINK);
  if (link) return link[0];
  var sentences = bodyParts_(body).sentences;
  for (var i = 0; i < sentences.length; i++) {
    if (!footer_(sentences[i]) && contactSentence_(sentences[i])) return sentences[i];
  }
  return null;
}

// The rejection allowlist. A rejection is denied only when every sentence left once the greeting, the sign-off with its
// signature and the standard footer are set aside is one of these enumerated whole-sentence shapes: the decision, thanks
// or appreciation for the application, a wish of luck, a pointer to future openings that names no person, call or
// specific role, a status disclaimer for other applications, the applicant-pool courtesy, or the boilerplate a
// confirmation may also hold. A name slot holds at most 80 characters, with no scheduling word and no word from the veto list. Any other sentence ("Our recruiter will email
// you to set up time") keeps the thread in the Inbox, and the contact vetoes above are read on top.
// A name slot stops at the words that join clauses and is then held to the whole veto list once matched: ACK_NAME's
// inline veto, repeated in every slot, makes these expressions megabytes long and seconds to compile. A word may hold a
// digit after its first letter ("Q2"), and "repl" vetoes only the reply verbs so a name may start with it. A verb asking
// for contact in any form ("Contact Recruiting", "Emailing Jane") is never a name.
var RJ_CONTACT_VERB = 'e-?mail|contact|text|txt|ping|call|ring|phone|messag|msg|dm|write|reach|holler|chat|talk|speak|meet|ask|tell|connect|reply|interested';
// A word any contact request starts with. Outside the decision clause, the future-contact shapes, the status and
// applicant-pool lines, the footer lines and the footer notices, one in a sentence keeps the thread in the Inbox.
var RJ_CONTACT_STEMS = 'e-?mail|contact|call|reach|phon|schedul|connect|chat|meet|messag|text|ping|dm|talk|speak|ring|book|calendar';
var RJ_CONTACT_STEM = new RegExp('\\b(?:' + RJ_CONTACT_STEMS + ')\\w*', 'i');
var RJ_NAME_STOP = 'at|and|or|but|so|then|to|if|when|once|while|not|this|that|these|those|time|times|here|there|now|open|you|your|yours|we|us|our|i|me|my|is|are|was|were|be|been|will|would|can|could|may|might|should|shall|has|have|had|do|does|did|please|kindly';
var RJ_NAME_GUARD = '(?!(?:' + RJ_NAME_STOP + ')\\b|' + RJ_CONTACT_VERB + ')';
// The few guarded words that start most sentences' clauses, a subset of the guard that costs a sliver of its size.
var RJ_NAME_LOOSE_GUARD = '(?!(?:a(?:t|nd|re)|or|but|so|t(?:hen|o|his|hat|imes?)|i[fs]?|wh(?:en|ile)|once|you(?:rs?)?|we(?:re)?|us|our|here|open|was|please|m[ey])\\b|e-?mail)';
var RJ_GUARDED_WORD = new RegExp('^' + RJ_NAME_GUARD.replace('(?!', '(?:'), 'i');
var RJ_NAME = "((?:" + RJ_NAME_GUARD + "[a-z&'()/+#.-][a-z0-9&'()/+#.-]*(?![a-z0-9&'()/+#.-])(?:,? (?=[a-z&'()/+#.-]))?){1,10})";
var RJ_VETO_WORD = new RegExp('(?:^|\\s)(?:' + ACK_VETO.replace('repl\\w*', 'repl(?:y|ies|ied|ying)') + '|at|(?:' + RJ_CONTACT_VERB + '|' + RJ_CONTACT_STEMS + ')\\w*)\\b', 'i');
var RJ_POST ='(?:role|position|opening|opportunity|job|req|requisition|vacancy)';
var RJ_JOB = '(?:(?:the|this|our|that|your) (?:(?:particular|specific|current|open) )?' + RJ_POST + '(?: you applied (?:to|for))?' +
  '|(?:(?:the|this) (?:position|role|job)[:,]? )?(?:the |our |this |a |an )?(?:current )?(?:[a-z]{0,3}_?\\d{3,9} )?' + RJ_NAME + '(?: (?:[|/–-]|--) ' + RJ_NAME + '){0,2}(?: ' + RJ_POST + ')?' + ACK_REQ + '(?: (?:at|with|here at) (?:us|' + RJ_NAME + '))?)';
var RJ_TARGET1 = '(?:us|our (?:team|company|mission)|the work we(?:\'re| are) (?:doing|building)|the team(?: here)?(?: at ' + RJ_NAME + ')?|(?:a |an |the )?(?:career|position|role|employment|potential employment|opportunities|career opportunities|opportunity) (?:at|with|in) (?:us|' + RJ_NAME + ')|working (?:at|with|for|within) (?:us|' + RJ_NAME + ')|joining (?:us|our team|the team)(?: (?:here )?at ' + RJ_NAME + ')?|being (?:a )?part of (?:this journey|our (?:team|journey|mission)|the team|us)|' + RJ_JOB + ')';
var RJ_TARGET = '(?:(?:pursuing|exploring|joining|applying (?:to|for)) )?' + RJ_TARGET1 + '(?:,? and (?:in |for )?' + RJ_TARGET1 + ')?';
var RJ_DOC = '(?:application|applications|candidacy|resume|cv|submission|profile|background|experience|experiences|qualifications|skills|skill ?sets?|work|credentials|materials|expertise|alignment with the (?:job |role )?requirements)';
var RJ_DOCS = '(?:(?:your|the|all|our) )?(?:(?:previous|past|prior|relevant) )?' + RJ_DOC + '(?:(?:,|,? and|,? &) (?:your |the )?' + RJ_DOC + '){0,3}';
var RJ_WHEN = '(?: (?:at this (?:time|point|stage|moment)(?: (?:of|in) the process)?|at the moment|at this early stage of the process|right now|for now|currently|this time|at present))';
var RJ_FOR_JOB = '(?: (?:for|with|in|on|to) ' + RJ_JOB + ')';
// Why the others were chosen: "whose experience more closely aligns with our current needs".
var RJ_FIT = '(?:(?:more |most |better |closely |best )*(?:align|aligns|aligned|match|matches|matched|fit|fits)(?: (?:more|most) (?:closely|specifically)| better| best| closely)?(?: (?:with|to|for))?|(?:are |is )?(?:a )?(?:better|stronger|closer) (?:match|fit)(?: for| with| to)?|(?:are |is )?(?:more |most )?closely aligned (?:with|to))';
var RJ_NEEDS = '(?:(?:our|the|this) (?:team\'s |company\'s )?(?:(?:current|specific|immediate|particular) )*(?:(?:hiring|business) )?(?:needs|requirements|role requirements|role)(?: (?:of|for) (?:the|this|our) (?:(?:particular|specific) )?(?:role|position|team))?|the (?:(?:specific|current) )?(?:needs|requirements) (?:of|for) (?:the|this) (?:(?:particular|specific) )?(?:role|position|team)|(?:the|this) (?:(?:particular|specific) )?(?:role|position)|what (?:we(?:\'re| are| were)|the (?:hiring )?team (?:is|was)) (?:looking for|seeking)|what we need(?: for this role)?|current (?:hiring |business )?needs)';
var RJ_WHOSE = '(?:,? (?:whose|who|that|which|with) (?:we feel )?(?:' + RJ_DOC + '(?: (?:and|&) ' + RJ_DOC + ')? )?(?:that |which )?(?:are |is )?' + RJ_FIT + ' ' + RJ_NEEDS + '|,? who are based (?:in|within) ' + RJ_NAME + ')';
var RJ_OTHERS = '(?:(?:other|another|different|a different|a smaller group of|the|a few|several|a)(?: (?:qualified|strong))? )?(?:candidates?(?:\\(s\\))?|applicants?|folks|profiles|finalists?)(?: (?:for|to move forward with))?' + RJ_WHOSE + '?';
var RJ_FORWARD = '(?:move|moving|proceed|proceeding|go|going|continue|continuing|progress|progressing|advance|advancing)(?: forward| ahead| further)?(?: (?:(?:with|in|on|for) )?your (?:application|candidacy)(?: for ' + RJ_JOB + ')?| (?:with|in|on|for) the (?:interview |hiring |recruiting )?process)?(?: (?:to|in) the next (?:stage|round|step)(?: of (?:the|our) (?:hiring |interview |recruiting )?process)?)?';
var RJ_SUBJECT = '(?:we|the (?:hiring |recruiting |talent )?team|our (?:hiring |recruiting |talent )?team|the hiring manager(?: and (?:i|myself))?)';
var RJ_HAVE = '(?:\'ve| have| has| had)?';
var RJ_ARE = '(?:\'re| are| is| were| was)';
var RJ_ADV = '(?: (?:unfortunately|regretfully|sadly|ultimately|now|currently|therefore))?';
var RJ_NOT = '(?: (?:will|would) not| won\'t| (?:are|is|were) not| aren\'t|\'re not| did not| didn\'t)';
var RJ_DECIDED = '(?:decided|chosen|elected|opted|determined|made the (?:difficult |tough )?(?:decision|choice)|had to make the (?:difficult |tough )?decision)';
var RJ_NO_FIT = 'there (?:isn\'t|is not|wasn\'t|was not) (?:quite )?(?:an ideal |a |the right |a direct |a strong |a good )?(?:fit|match)(?: for (?:our current needs|' + RJ_JOB + '|what we are looking for))?';
var RJ_SPONSOR = '(?:we' + RJ_ARE + ' (?:unable|not able) to (?:provide|offer|support) (?:the )?(?:visa |immigration )?sponsorship(?: required)?(?: for (?:this|the) (?:position|role))?|' + RJ_NAME + ' does not (?:offer|provide) (?:visa )?sponsorships?' +
  '|we (?:can\'t|cannot|can not|are unable to|aren\'t able to|are not able to) (?:support|sponsor|provide) (?:the |a |your )?(?:visa|work visa|visa sponsorship|sponsorship|work authorization)(?: sponsorship)?' + RJ_WHEN + '?' + RJ_FOR_JOB + '?)';
var RJ_DECISION = '(?:' + [
  '(?:' + RJ_SUBJECT + RJ_HAVE + '|(?:have|has))' + RJ_ADV + ' ' + RJ_DECIDED + ' (?:that (?:we will not|we won\'t|we would not) be ' + RJ_FORWARD + '|that ' + RJ_NO_FIT + '|(?:not to|to not) ' + RJ_FORWARD + '|to (?:move|proceed|go|continue)(?: forward| ahead)? with ' + RJ_OTHERS + '|to (?:pursue|consider|focus on) ' + RJ_OTHERS + '|not to fill (?:the|this) (?:role|position)|to (?:close|cancel) (?:the|this) (?:role|position|requisition))',
  RJ_SUBJECT + RJ_HAVE + RJ_ADV + ' (?:feel|felt|believe|determined) that ' + RJ_NO_FIT,
  RJ_SUBJECT + '(?:\'ve| have| has| are|\'re| is| will|\'ll)?' + RJ_ADV + '(?: be)? (?:(?:moving|proceeding|going|move) forward|proceeding|pursuing) with ' + RJ_OTHERS,
  RJ_SUBJECT + RJ_ADV + RJ_NOT + '(?: be)? (?:moving|proceeding|progressing|advancing|continuing|move|proceed|advance)(?: forward| ahead)?(?: (?:(?:with|in) )?your (?:application|candidacy)(?: for ' + RJ_JOB + ')?| (?:with|in) the (?:interview |hiring )?process)?' + '(?: (?:to|in) the next (?:stage|round|step)(?: of (?:the|our) (?:hiring |interview )?process)?)?',
  RJ_SUBJECT + RJ_ADV + RJ_NOT + '(?: be)? moving (?:you|your application) (?:forward|ahead)(?: (?:in|to) (?:the process|the next (?:stage|round)|an interview))?',
  RJ_SUBJECT + RJ_ADV + RJ_NOT + '(?: be)? (?:advancing|progressing|advance|progress) (?:you|your (?:application|candidacy)) (?:forward |further )?(?:to|in|into) the next (?:stage|round|step|phase)(?: of (?:the|our) (?:hiring |interview |recruiting |selection )?process)?',
  RJ_SUBJECT + RJ_ADV + RJ_ARE + ' (?:unable|not able) to (?:move forward|proceed|advance|offer you a position|find a (?:good |strong |suitable )?match for your ' + RJ_DOCS + '|pursue (?:this|the) (?:employment )?opportunity with you|provide you with a suitable position(?: at the moment)?(?: (?:with|at) ' + RJ_NAME + ')?)(?: with your (?:application|candidacy))?',
  RJ_SUBJECT + '(?: won\'t| will not) be able to invite you to the next (?:round|stage|step)(?: of (?:our|the) (?:hiring |interview )?process| of interviews)?',
  '(?:you|your (?:application|candidacy))(?: have|\'ve| has| were| was) not (?:been )?(?:selected|chosen|successful|shortlisted)(?: (?:for|to move forward (?:for|with)) ' + RJ_JOB + ')?',
  '(?:you|your (?:application|candidacy))(?: have| has|\'ve| were| was) (?:been )?unsuccessful(?: (?:on this occasion|this time))?(?: (?:for|with) ' + RJ_JOB + ')?',
  'your ' + RJ_DOCS + ' (?:are|is) not (?:a |quite a |the right )?(?:match|fit) for ' + RJ_JOB,
  '(?:it|this) (?:isn\'t|is not|wasn\'t|was not) (?:quite )?(?:an ideal |a |the right |a direct |a strong |a good )?(?:fit|match)(?: for (?:our current needs|' + RJ_JOB + '|what we are looking for))?',
  RJ_NO_FIT,
  RJ_SUBJECT + '(?: do not| don\'t| did not| didn\'t) (?:see|have|believe there is) (?:quite )?(?:a|the right|a strong|a direct|a good) (?:match|fit)(?: (?:for|with) (?:our current needs|your profile|' + RJ_JOB + '))?' + RJ_FOR_JOB + '?',
  RJ_SUBJECT + '(?: do not| don\'t| did not| didn\'t) (?:believe|think|feel)(?: that)? (?:this|the) (?:position|role|opportunity) (?:is|was|would be) (?:the right|a good|a strong) (?:match|fit)(?: for you)?',
  RJ_SUBJECT + '(?: do not| don\'t) (?:currently )?have (?:a|an|any) (?:position|role|opening) that is a (?:strong |good )?(?:match|fit) (?:with|for) your (?:profile|background|experience)',
  RJ_SUBJECT + RJ_ARE + ' (?:considering|pursuing) ' + RJ_OTHERS + RJ_FOR_JOB + '?',
  RJ_SUBJECT + RJ_HAVE + ' identified (?:other|another) candidates?(?: to move forward with)?',
  RJ_SUBJECT + RJ_ADV + ' (?:have|has) ' + RJ_OTHERS,
  RJ_SUBJECT + RJ_HAVE + '(?: now| already| recently)? filled (?:the|this) (?:role|position|opening)(?: with (?:another|a different|an internal) candidate' + RJ_WHOSE + '?)?',
  '(?:the|this|our) (?:(?:particular|specific|current) )?(?:(?:[a-z]{0,3}_?\\d{3,9} )?' + RJ_NAME + ' )?(?:role|position|opening|requisition|job)(?: you applied (?:to|for))? (?:has|have|had|is)? ?(?:now |already |recently )?(?:been )?(?:filled|closed|cancel+ed)(?:,? and (?:we are|we\'re) no longer accepting applications)?',
  '(?:the|this|our) (?:(?:particular|specific|current) )?(?:(?:[a-z]{0,3}_?\\d{3,9} )?' + RJ_NAME + ' )?(?:role|position|opening|requisition|job)(?: you applied (?:to|for))? (?:is|was) no longer (?:available|open|a priority(?: for ' + RJ_NAME + ')?)(?:,? and will be taken down shortly)?',
  RJ_SUBJECT + RJ_ARE + ' no longer (?:hiring|accepting applications|reviewing applicants|reviewing applications|considering applicants) for ' + RJ_JOB,
  RJ_SUBJECT + '(?: will|\'ll) (?:therefore )?not be hiring for (?:this|the) (?:role|position)',
  '(?:' + RJ_SUBJECT + RJ_HAVE + '|(?:have|has))' + RJ_ADV + ' ' + RJ_DECIDED + ' (?:not to|to not) (?:pursue|consider) your (?:application|candidacy|resume|profile|cv)(?: (?:any )?further| for further consideration)?',
  RJ_SUBJECT + RJ_HAVE + ' (?:found|feel|felt|determined|believe)(?: that)? your ' + RJ_DOCS + ' (?:didn\'t|did not|don\'t|do not|doesn\'t|does not) (?:quite |fully )?(?:align|match|fit) (?:with |to )?' + RJ_NEEDS + RJ_FOR_JOB + '?',
  RJ_SPONSOR
].join('|') + ')';
// What may come before the decision, and the tails that may follow it.
var RJ_REVIEWED = '(?:after|upon|following|based on) (?:(?:a|an|our) )?(?:(?:careful|thorough|thoughtful|further|close|full|detailed|closer|much) )?(?:review|consideration|deliberation|evaluation|look)(?: (?:and|&) (?:careful )?consideration)?(?: of (?:' + RJ_DOCS + '|all (?:candidates|applications|applicants)|applications for this (?:role|position)))?' +
  '|after (?:(?:careful(?:ly)?|thorough(?:ly)?) )?(?:reviewing|considering|evaluating|assessing|looking (?:at|over|through)) (?:' + RJ_DOCS + '|applications for this (?:role|position)|all (?:candidates|applications|applicants)|all of them|them all)(?: for (?:this|the) (?:role|position))?';
var RJ_PRAISE = '(?:while|although|though) (?:we (?:are|were) (?:(?:very|truly) )?impressed (?:with|by) ' + RJ_DOCS + '|your ' + RJ_DOCS + ' (?:are|is|were|was) (?:(?:very|truly|really) )?(?:excellent|impressive|strong|great)|your ' + RJ_DOCS + ' (?:demonstrated|showed|shows|demonstrates) (?:strong|great|real|a lot of) potential|you have (?:many|a lot of) (?:(?:valuable|great|impressive|desirable|strong) )?(?:skills|qualifications)(?: that (?:could|would|might) be (?:of value|valuable) to (?:our|the) (?:organization|team|company))?|it didn\'t work out this time|this (?:role|position) (?:wasn\'t|was not|isn\'t|is not|may not have been) (?:quite )?(?:the right|a) (?:fit|match)' + RJ_WHEN + '?|this (?:wasn\'t|was not|is never|isn\'t) (?:an easy decision|easy news to share))';
var RJ_LEADS = 'again|once again|also|additionally|in addition|in the meantime|meanwhile|unfortunately|please note(?: that)?|however|sadly|regrettably|with regret|that said|that being said|with that said|(?:and )?so|as you can imagine|' +
  '(?:due to|given) (?:the )?(?:(?:very|extremely|incredibly) )?(?:high|large|overwhelming|significant|sheer) (?:volume|number) of (?:(?:strong|qualified|talented|exceptional) )?(?:applications|applicants|candidates)(?: (?:we(?:\'ve| have)? received|received))?(?: (?:for|to) (?:this|the) (?:role|position))?|' +
  'based on your (?:consent|privacy|data|communication) (?:selection|preferences?|choices?|settings)|(?:(?:best|kind|warm|warmest) )?regards|sincerely|best|cheers|warmly|' +
  'for this reason|as a result|therefore|thus|for now|at this (?:time|point|stage|moment)|at the moment|right now|upon further review|until then|at the same time|and|while|although|though|please know(?: that)?|' +
  'as (?:we|our team|' + RJ_NAME + ') (?:continues? to grow|grows?)(?: and has (?:future|new) (?:openings|opportunities))?|with only (?:one|a single|a few|a limited number of) (?:openings?|positions?|roles?|spots?) available|' +
  '(?:we ?)?(?:regret|are sorry|\'re sorry|have) to (?:inform(?: you)?|let you know|share|say|advise you)(?: that)?|whilst|we wanted to (?:get back to you and )?(?:let you know|share|follow up)(?: that)?|' + RJ_REVIEWED + '|' + RJ_PRAISE;
var RJ_JOIN = new RegExp('(?:,? (?:and|but|so|however|though|as|while),?|;|,| -) | ?[—–] ?', 'gi');
var RJ_DECISION_SENTENCE = RJ_DECISION + '(?:: ' + RJ_NAME + ')?' + RJ_WHEN + '?' + RJ_FOR_JOB + '?' + RJ_WHEN + '?' + '(?:,? (?:as|because) (?:' + RJ_SPONSOR + '|we(?:\'re| are) (?:moving forward|proceeding) with ' + RJ_OTHERS + '|we focus on ' + RJ_OTHERS + '))?' +
  '(?: due to (?:your )?(?:experience|location|background|qualifications)(?: (?:and/or|and|or) (?:your )?(?:experience|location|background|qualifications))?)?';
// Having looked at the application: "We've reviewed your application", "We have carefully reviewed your application".
var RJ_REVIEWED_CLAUSE = RJ_SUBJECT + '(?:\'ve| have| has)? (?:(?:now |carefully |thoroughly |closely )*)(?:reviewed|considered|had a chance to review) ' + RJ_DOCS + '(?: carefully)?' + RJ_FOR_JOB + '?';
// Praise that softens the decision: "We felt that your background is impressive".
var RJ_PRAISE_CLAUSE = '(?:we (?:felt|feel|think|believe) (?:that )?)?your ' + RJ_DOCS + ' (?:is|are|was|were) (?:(?:very|truly|really|quite) )?(?:impressive|strong|excellent|great)' +
  '|we(?:\'re| are| were) (?:(?:very|truly|really) )?impressed (?:with|by) ' + RJ_DOCS +
  '|we (?:genuinely )?believe you have a lot to offer' +
  '|you (?:clearly |certainly |obviously )?have (?:a lot|so much|lots) to offer' +
  '|you(?:\'ve| have) (?:done|accomplished) (?:some )?(?:(?:really|truly|very) )?(?:impressive|great|amazing|incredible|excellent) (?:work|things)';
// Opening courtesy: "We hope you're doing well", "We wanted to share an update regarding your application".
var RJ_OPENING = '(?:we |i )?hope (?:you(?:\'re| are) (?:doing )?well|this (?:e-?mail|message|note) finds you well)' +
  '|(?:we )?(?:wanted|want|would like|are writing) to (?:share|provide you with|give you) an update (?:regarding|on|about) your (?:recent )?application(?: for ' + RJ_JOB + ')?' +
  '|we(?:\'re| are) (?:following up|writing) (?:on|regarding|about) your (?:recent )?application(?: for ' + RJ_JOB + ')?' +
  '|we know it(?:\'s| has) been a (?:while|little while|bit) since you (?:first )?(?:applied|expressed (?:your )?interest|submitted your application)(?: for ' + RJ_JOB + ')?';

// Thanks and appreciation for applying, interest or time already spent.
var RJ_EFFORT = '(?:time|attention|patience|interest|consideration|understanding|application|submission|effort|efforts|energy|passion|thought|care|enthusiasm|work|trust you have shown)';
var RJ_EFFORTS = '(?:(?:your|the|all (?:of )?your|all the) )?(?:(?:recent|online|thoughtful|continued|kind) )?' + RJ_EFFORT + '(?:(?:,|,? and) (?:your |the )?' + RJ_EFFORT + '){0,3}';
var RJ_INTO_WHAT = '(?:your application|apply(?:ing)?(?: (?:for|to|with) (?:us|' + RJ_JOB + '))?(?: and (?:share|sharing) your (?:experience|background|story|qualifications)(?: with us)?)?' +
  '|(?:submit|submitting) (?:your|an) application(?: (?:and|&) (?:share|sharing) your (?:experience|background|story|qualifications)(?: with us)?)?' +
  '|(?:share|sharing) your (?:experience|background|story|qualifications|interest)(?: with us)?' +
  '|applying and (?:learning|learn) (?:more )?about (?:us|our team|the team|' + RJ_NAME + ')|the application process|this process|the (?:hiring )?process|preparing (?:your|an|the) application|connect(?:ing)? with us(?: and apply(?: (?:for|to) (?:us|' + RJ_JOB + '))?)?|exploring opportunities with us)';
var RJ_INTO = '(?: (?:(?:you(?:\'ve)?|that you(?:\'ve)?) (?:have )?)?(?:put forth|put in|put|invested|spent|took|taken|have shown|showed|gave)(?: (?:(?:in|into|on|to|with) )?' + RJ_INTO_WHAT + ')?)';
var RJ_FOR_WHAT = '(?:' + RJ_EFFORTS + RJ_INTO + '?(?: (?:in|for|to|with|of|at) (?:applying (?:to|for) )?' + RJ_TARGET + ')?(?: (?:and|in) applying)?' +
  '|(?:applying|interviewing|your application|submitting (?:your|an|the) application)(?: (?:to|for|with) (?:join )?' + RJ_TARGET + ')?' +
  '|(?:taking|investing) (?:the |your )?time(?: and effort)?(?: (?:to|and) (?:apply|interview|submit (?:your|an) application|learn more about ' + RJ_TARGET + '|share your (?:background|experience|interest|story|qualifications) with us|speak with (?:us|our team))(?: (?:to|for|with|in) ' + RJ_TARGET + ')?| in applying)?' +
  '|(?:investing|putting) your time and effort (?:in|into) applying' +
  '|the time(?: and effort)? you (?:took|spent|invested|put) (?:to (?:apply|consider ' + RJ_TARGET + ')|in(?:to)? (?:applying|your application|preparing your application))' +
  '|considering (?:' + RJ_TARGET + '|' + RJ_NAME + ' as (?:a |your )?(?:potential|possible) employer)(?: as (?:a |your )?(?:potential|possible) (?:employer|next step in your career))?' +
  '|(?:expressing|showing|sharing your) interest(?: in (?:' + RJ_TARGET + '|' + RJ_NAME + '))?' +
  '|taking the time to (?:express|share) (?:your )?interest in (?:' + RJ_TARGET + '|' + RJ_NAME + ')' +
  '|giving us the (?:opportunity|chance) to (?:learn more about|get to know) you' + RJ_FOR_JOB + '?' +
  '|giving us the (?:opportunity|chance) to (?:consider|review) (?:you|' + RJ_DOCS + ')(?: (?:for|with|at) (?:us|' + RJ_JOB + '))?' +
  '|sharing your (?:story|background|experience|qualifications|interest) with us' +
  '|your patience (?:as|while) we (?:progress|work|move)(?:ed)? through (?:the|our) (?:hiring |interview |recruiting )?process' +
  '|your (?:continued )?interest in (?:' + RJ_TARGET + '|' + RJ_NAME + '))';
var RJ_THANKS = '(?:(?:we |i )?(?:want|wanted|would like) to |we )?(?:thank you|thanks|many thanks)(?: (?:so|very) much)?(?:,? again| once again)?,? for ' + RJ_FOR_WHAT;
// What follows a split thanks or appreciation: "Thank you for your time, and for your interest in the team".
var RJ_THANKS_MORE = '(?:(?:as well as|also) )?(?:for )?(?:' + RJ_FOR_WHAT + ')';
var RJ_APPRECIATE_WHAT = '(?:' + RJ_EFFORTS + RJ_INTO + '?(?: (?:in|for|of|to) (?:applying (?:to|for) )?' + RJ_TARGET + ')?(?: in applying)?' +
  '|you (?:taking the time to apply|applying|sharing your (?:qualifications|background|experience|interest|story)(?: with us)?|considering ' + RJ_TARGET + '|taking the time to (?:apply|share your interest))(?: (?:to|for|with) ' + RJ_TARGET + ')?' +
  '|your considering ' + RJ_TARGET + '|the (?:opportunity|chance) to (?:learn more about|get to know) (?:you|your ' + RJ_DOCS + ')|the consideration' +
  '|your (?:continued )?interest in ' + RJ_NAME + ')';
var RJ_APPRECIATE = '(?:(?:we|our team|the team)(?:\'re| are)? ?)?(?:(?:truly|really|sincerely|genuinely|greatly|deeply|very much|very|so|do|always|also) )*(?:appreciate|appreciates|value|values|grateful for|thankful for) ' + RJ_APPRECIATE_WHAT +
  '|' + RJ_EFFORTS + ' (?:is|are) (?:always |greatly |truly )?appreciated' +
  '|we know (?:applying|exploring new opportunities) takes (?:time|thought|effort)(?: and (?:time|thought|effort))?' +
  '|we know a lot of (?:thought|time|effort)(?: and (?:consideration|effort|thought))? went into your application' +
  '|we know there are (?:many|so many|a lot of) (?:great )?companies to choose from' +
  '|we (?:know|understand|recogni[sz]e) (?:that )?(?:a|the|your) job search (?:can be|is) (?:a (?:big|huge|significant|major|real) (?:time )?investment|a lot of work|time-consuming|(?:hard|exhausting|demanding) work)' +
  '|we (?:know|understand|recogni[sz]e) (?:that )?(?:it takes (?:a lot of |real |significant )?(?:time|effort|thought|work)(?: and (?:time|effort|thought|energy|work))? to (?:apply|submit (?:an|your) application|prepare (?:an|your) application)' +
  '|you have (?:many|so many|a lot of|plenty of) (?:options|choices)(?: (?:when|in) (?:considering|choosing) (?:the |a |your )?(?:workplace|employer|company|place to work)(?: for (?:the|your) next step in your career)?)?)' +
  '|(?:we know (?:that )?)?(?:a lot of|so much|real) (?:thought|time|effort|consideration|work|care)(?: and (?:consideration|effort|thought|time|work|care))? (?:went|goes) into (?:your|an|each|every) application' +
  '|(?:we )?(?:(?:truly|really|sincerely|genuinely|greatly|deeply|also) )*(?:appreciate|are grateful) that you (?:considered|chose to consider|thought of) (?:us|our team|joining us|joining our team|' + RJ_NAME + ')(?: (?:in|during|as part of) your (?:job )?search)?' +
  '|it hasn\'t gone unnoticed' +
  '|we(?:\'re| are) (?:truly )?grateful (?:that you included us in your search|for the time you(?:\'ve)? spent with us)' +
  '|it (?:has been|was) (?:great|a pleasure) (?:learning|getting to know|to learn) more about you' +
  '|we (?:have )?(?:enjoyed|genuinely enjoyed) learning more about (?:you|your ' + RJ_DOCS + ')' +
  '|(?:for )?giving us a chance to get to know you' +
  '|(?:we )?(?:appreciate|thank you for) your understanding' +
  '|your (?:interest|application) means (?:a lot|so much|a great deal)(?: to us)?' +
  '|it means a lot that you considered (?:joining )?(?:us|our team|(?:our )?' + RJ_NAME + ')' +
  '|we(?:\'re| are) (?:truly |always )?inspired by the (?:talented |amazing |incredible )?(?:people|candidates|individuals) (?:who find their way to us|interested in ' + RJ_NAME + ')';
// Wishing you well or luck.
var RJ_WISH_OBJ = '(?:(?:current|ongoing|continued|future|next|job|career|professional|new) )*(?:search|job search|career|careers|endeavou?rs|journey|career journey|adventures?|career adventure|traveling adventures|steps|move|chapter|search for a (?:suitable|new) (?:position|role)|search for your next (?:opportunity|role|position|challenge)|next phase in your career|work ahead|what comes next)';
var RJ_WISH = '(?:we(?:\'re| are)? |i )?(?:(?:sincerely|truly|also) )?(?:(?:wish|wishing) you|good luck|(?:the )?best of luck|all the best|best wishes)(?: (?:the (?:very )?best(?: of luck)?|all the best|good luck|luck|success|continued success|every success|the best of success|well|the best of luck))?(?: to you)?' +
  '(?: (?:in|with|on|for) (?:both )?(?:all (?:of )?)?(?:your |the )?' + RJ_WISH_OBJ + '(?:(?:,| and|,? and) (?:in |with )?(?:your |the )?' + RJ_WISH_OBJ + '){0,3})?(?: (?:ahead|going forward|in the meantime|in (?:the )?future|as you continue your search|in the (?:upcoming|coming|months) (?:months|weeks|year|years)(?: ahead)?))?' +
  "(?:, ((?:(?!(?:" + ACK_VETO + ")\\b)[a-z'-]+)))?" +
  '|(?:we )?hope (?:we|our paths) (?:may |will )?(?:connect|cross)(?: paths)?(?: again)?(?: (?:in the future|soon|down the road))?' +
  '|(?:we )?hope (?:we will|we\'ll|to) have the (?:chance|opportunity) to consider you for (?:another|a future|a different) (?:role|position|opportunity) in the future' +
  '|(?:i|we) know this (?:isn\'t|is not|wasn\'t|was not) (?:exactly |quite )?the (?:news|outcome) you were hoping for' +
  '|we look forward to (?:the possibility of )?(?:connecting|crossing paths)(?: again)? in the future' +
  '|(?:we(?:\'re| are) |are )?(?:confident|sure|certain) (?:that )?you(?:\'ll| will) find (?:something|a (?:great |new )?role|the right (?:role|opportunity|fit)|a great (?:fit|opportunity))(?: (?:perfect|great|right) for you)?(?: soon)?' +
  '|we(?:\'re| are) (?:all )?(?:cheering you on|rooting for you)(?: (?:in|on) your (?:search|journey|next steps?)| as you (?:take|begin|start|continue) (?:the|your) next (?:step|steps|chapter)(?: in your (?:career|search|journey))?)?';

// Future openings, the careers page, the talent community, keeping the application on file: no person, call or role.
var RJ_PLACE = '(?:\\[\\d{1,2}\\] )?(?:(?:(?:our|the|a) )?(?:' + RJ_NAME + ' )?(?:careers? (?:page|site|website)|career site|jobs? (?:board|page|postings|openings|listings)|open (?:positions|roles)|website|page|postings|new job openings|URL)(?: \\( URL \\)| URL)?(?:(?:,| and|,? or) (?:on )?(?:our )?' + NB_SOCIALS + ')?' +
  '|[a-z0-9-]+\\.(?:com|io|ai|co|org|net)/(?:careers|jobs))';
var RJ_FUTURE = '(?:(?:any|other|future|new|additional|open|upcoming|relevant|available|current|exciting|career) )*(?:opportunities|openings|roles|positions|job openings|jobs|vacancies)';
var RJ_FUTURE_ONLY = '(?:(?:any|other|new|additional|exciting) )*(?:future|upcoming) (?:opportunities|openings|roles|positions|job openings|vacancies)';
var RJ_BG = '(?:your )?(?:(?:particular|specific|unique) )?(?:' + RJ_DOC + '|interests|career goals|location)(?:(?:,| and|,? and|/or| and/or) (?:your )?(?:' + RJ_DOC + '|interests|career goals|location))*';
var RJ_FITS_YOU = '(?:(?:be|is|are) (?:a )?(?:(?:good|better|strong|great|potential) )?(?:fit|match)(?: (?:for|with) (?:you|' + RJ_BG + '))?' +
  '|(?:is |are )?in alignment with ' + RJ_BG +
  '|(?:better |more closely )?(?:match|matches|align with|aligns with|fit|fits|suit|suits) (?:you|' + RJ_BG + ')(?: (?:more closely|better))?' +
  '|(?:more closely |better )?(?:align|aligns) (?:more closely |better )?with ' + RJ_BG +
  '|(?:feels?|seems?|looks?) like a (?:good |better |great |stronger |closer )?(?:fit|match)|(?:be|is|are) of interest(?: to you)?|interests? you|sparks? your interest|catch(?:es)? your eye|excites? you)';
var RJ_SUITS = '(?:,? (?:that|which) (?:may |might |could |would )?' + RJ_FITS_YOU + '|(?: in| that) the future| of interest(?: to you)?)';
var RJ_LATER = '(?: (?:in the (?:near )?future|down the (?:line|road)|as (?:they become available|(?:we|our team) (?:continues? to )?grows?|new (?:opportunities|roles|positions) (?:are often shared|are posted|open up|become available))|regularly|periodically|soon|again|should (?:your|the) (?:situation|circumstances) change|if (?:your|the) (?:situation|circumstances) changes?))';
// A role that may suit you later: "another role comes up that might be a fit", "a position opens up that may be a good fit".
var RJ_ROLE_FITS = '(?:a|an|another|any|other) (?:(?:more |better )?(?:future|new|other|different|open|relevant|suitable|similar|appropriate|matching|fitting) )?(?:role|position|opportunity|opening)s?(?: \\( URL \\))?(?: (?:at|with) ' + RJ_NAME + ')?(?: similar to (?:this|this one|the one you applied for))?(?: (?:comes?|opens?) up(?: again)?| (?:becomes|is) available| (?:arises|arise))?(?: (?:now or )?in the (?:near )?future)?' +
  '(?: that\'s in alignment with ' + RJ_BG + '|(?: that| which)?(?: (?:might|may|could|would))? ' + RJ_FITS_YOU + ')?(?: in the future)?';
var RJ_IF_ROLE = '(?:if|when|should|if/when|in the event(?: that)?)(?: in the future)? (?:you (?:see|find) |we (?:identify|find|see|come across) |there (?:is|are) )?' + RJ_ROLE_FITS;
var RJ_LOOK = '(?:(?:continue (?:to )?)?keep(?:ing)? (?:an eye|your eyes?)(?: out)? (?:on|for)|keep an eye out(?: (?:on|for))?|continue (?:to )?(?:check(?:ing)?|visit(?:ing)?|review(?:ing)?|explor(?:e|ing)|monitor(?:ing)?|look(?:ing)? at)|check(?: back)?(?: in)?(?: on)?|check out|visit|review|explore|peruse|browse|monitor|look at|stay engaged on|view)';
var RJ_INVITE = '(?:(?:we(?:\'d| would)? )?(?:also |do )?(?:would )?(?:like to )?(?:encourage|invite) you to(?: also)?|(?:we )?(?:also )?(?:encourage|invite) (?:all )?(?:of )?our (?:applicants|candidates) to|(?:please )?(?:feel free|(?:don\'t|do not) hesitate) to(?: also)?|(?:we )?(?:do )?(?:hope|recommend)(?: that)? you(?:\'ll| will)?|be sure to|please(?: do)?|you (?:can|may)(?: also)?|you(?:\'re| are) (?:also )?welcome to|(?:we(?:\'d| would) )?love for you to) ';
// Following the company on social media: "Feel free to follow us on LinkedIn for company updates".
var RJ_SOCIAL = '(?:(?:follow(?: along with)?|connect with) (?:us|our (?:URL|' + RJ_NAME + ')(?: page)?|' + RJ_NAME + ')(?: (?:on|at|via) (?:social media|(?:our )?URL|' + RJ_NAME + '(?: \\( URL \\)| URL)?)){0,2}' +
  '(?:(?:,| and|,? or) (?:on |at )?(?:our )?(?:URL|' + RJ_NAME + '(?: \\( URL \\)| URL)?)){0,4}' +
  '(?: (?:to (?:stay up(?: |-)to(?: |-)date|keep up|stay informed|learn more)(?: (?:on|with|about) (?:all things ' + RJ_NAME + '|our (?:growth|culture|news|company|team)(?: and (?:culture|growth|news|updates))?|company (?:news|updates)))?|for (?:company )?(?:updates|news)|for ' + RJ_FUTURE + RJ_SUITS + '?))?' +
  '|keep up with (?:the )?(?:latest )?(?:happenings|news|updates) (?:at|from) ' + RJ_NAME + ' by (?:reading our blog|following us)(?: \\( URL \\)| URL)?(?: and (?:staying connected|following us) on ' + RJ_NAME + '(?: \\( URL \\)| URL)?)?)';
// A list of links, as some letters close: "LinkedIn ( URL ) Blog ( URL )".
var RJ_LINK_ROW = '(?:' + RJ_NAME + ' \\( URL \\))(?: ' + RJ_NAME + ' \\( URL \\)){0,7}';
var RJ_GROWING = '(?:as |since )?(?:we(?:\'re| are| will)?|our team (?:is|will)|' + RJ_NAME + ' (?:is|will)) (?:always |constantly |continually |rapidly |quickly )?' +
  '(?:growing(?: our team)?(?: quickly| rapidly)?|hiring|evolving|(?:continue|continuing) to grow(?: our team)?|(?:looking to connect with|looking for|seeking|on the look ?out for) (?:new |great |top |exceptional |talented |amazing )?talent(?: across our business| to join (?:our|the) team)?|updating our (?:website|careers page) with new opportunities)' +
  '(?: and (?:changing|scaling|scale|evolving|will be adding new (?:opportunities|roles|positions)(?: in the future)?|adding new (?:opportunities|roles|positions)(?: on a regular basis| regularly| all the time)?))?(?: this year and beyond)?';
var RJ_FUTURE_JOIN = RJ_FUTURE + '(?: to join (?:our|the) team)?' + RJ_SUITS + '?';
var RJ_LOOK_TAIL = '(?: (?:on|at|via|through|by visiting|by checking) ' + RJ_PLACE + '| (?:(?:for (?:information (?:regarding|about|on) )?|to (?:apply for|find|see|explore|browse|view|search for|discover|learn about) ))?' + RJ_FUTURE_JOIN +
  '| (?:at|with) (?:us|' + RJ_NAME + ')| to (?:explore|see) what(?:\'s| is) (?:currently )?(?:available|open)| for (?:another|a new) (?:great |exciting )?(?:opportunity|role|position)(?: to pursue)?|' + RJ_LATER + ')';
var RJ_POINTER = '(?:' + RJ_INVITE + ')?' +
  '(?:' + RJ_LOOK + ' (?:' + RJ_PLACE + '|' + RJ_FUTURE_JOIN + ')' + RJ_LOOK_TAIL + '{0,4}' +
  '|searching for ' + RJ_FUTURE +
  '|stay in the loop(?: with us)?' +
  '|(?:to )?(?:also )?(?:update|keep) your (?:candidate |applicant )?profile(?: \\( URL \\)| URL)?(?: (?:and|&) (?:your )?(?:job )?preferences)?(?: up(?: |-)to(?: |-)date)?(?: to (?:stay up(?: |-)to(?: |-)date|stay informed|be notified) (?:on|about|of) ' + RJ_FUTURE + ')?' +
  '|(?:apply(?:ing)?|re-?apply(?:ing)?)(?: again)?(?: (?:to|for) ' + RJ_FUTURE + RJ_SUITS + '?)?' + RJ_LATER + '?(?: ' + RJ_IF_ROLE + ')?' +
  '|consider (?:re-?applying|applying(?: again)?)(?: (?:to|for|with) (?:us|' + RJ_NAME + ')| (?:to|for) ' + RJ_FUTURE + RJ_SUITS + '?|' + RJ_LATER + '){0,3}' +
  '|(?:consider|explore|pursue) ' + RJ_FUTURE + '(?: (?:at|with) (?:us|' + RJ_NAME + '))?' + RJ_SUITS + '?' + RJ_LATER + '?' +
  '|(?:stay|keep) (?:in touch|connected)(?: with us)?(?: (?:through|via|on) (?:our )?(?:website|social (?:media|channels)|URL)(?: (?:or|and) (?:our )?(?:website|social (?:media|channels)|URL))?)?(?: (?:for|about) ' + RJ_FUTURE_ONLY + RJ_SUITS + '?)?' + RJ_LATER + '?' +
  '|(?:keep|consider) (?:us|' + RJ_NAME + ') (?:in mind )?for ' + RJ_FUTURE + RJ_LATER + '?' +
  '|check back(?: in)?(?: with us)?(?: (?:for|on) ' + RJ_FUTURE_JOIN + ')?' + RJ_LATER + '?' +
  '|learn more about (?:us|URL|' + RJ_NAME + ')(?: from our (?:employees|team|people))?(?: on ' + RJ_NAME + '(?: \\( URL \\)| URL)?(?:(?:,| and|,? or) ' + RJ_NAME + '(?: \\( URL \\)| URL)?){0,4})?(?: \\(and mark "?i\'m interested"? to (?:keep|stay) in touch\\))?' +
  '|(?:' + ACK_JOIN_COMMUNITY + '|sign up for (?:our )?URL)(?: \\( URL \\))?(?: (?:on|at|via|through) ' + RJ_PLACE + ')?(?: to (?:get|be) (?:notified|kept informed)(?: (?:when|as) (?:new )?(?:roles|positions|opportunities|openings|jobs|vacancies) (?:are posted|open up|become available|arise))?)?' +
  '|' + RJ_SOCIAL + ')';
var RJ_KEEP_FOR = '(?: for ' + RJ_FUTURE + RJ_SUITS + '?)?(?:,? (?:in case|in the event that|should|if|as) (?:our needs change|our team continues to grow|your experience is a fit for future roles|' + RJ_ROLE_FITS + '))?';
var RJ_FUTURE_SENTENCES = [
  // Two pointers at most: unrollRepeats_ writes out each one in full, and a third would double the compile time.
  RJ_POINTER + '(?:(?:,| and|,? or|,? and/or) ' + RJ_POINTER + ')?(?:,? (?:as|since) ' + RJ_GROWING + ')?',
  RJ_GROWING,
  'we(?:\'ve| have) (?:a lot of|lots of|many|so many) exciting things happening(?: (?:at|with) ' + RJ_NAME + ')?',
  'we (?:make a point of revisiting|regularly revisit|periodically revisit|regularly review|periodically review) (?:past|previous|prior) applications(?: on a regular basis)?(?: to match them (?:to|with) (?:newly opened|new|open) (?:jobs|roles|positions|openings))?',
  '(?:there may be|new) ' + RJ_FUTURE + '(?: (?:may|might) (?:arise|open up|become available))?' + RJ_SUITS + '?' + RJ_LATER + '?',
  '(?:as an evolving company,? )?(?:new |other )?(?:positions|roles|opportunities)' + RJ_SUITS + '? (?:may|might|will) (?:arise|open up|become available)' + RJ_SUITS + '?' + RJ_LATER + '?',
  '(?:please note,? )?our (?:hiring )?needs (?:are (?:always|constantly) (?:evolving|changing)|(?:continue|continues) to (?:evolve|change|grow)|(?:are )?(?:always |constantly )?(?:evolving|changing))',
  '(?:new )?(?:positions|roles|opportunities|openings|jobs) (?:are|get) (?:posted|added|updated|shared) (?:frequently|regularly|often|all the time|daily|weekly|every week)',
  '(?:we(?:\'ll| will| may| would| can)? )?(?:also |gladly |happily |certainly )?consider you for (?:' + RJ_FUTURE_ONLY + RJ_SUITS + '?' + RJ_LATER + '?|' + RJ_FUTURE + RJ_SUITS + '?' + RJ_LATER + ')',
  '(?:(?:we|i)(?:\'ll| will| may| would love to|\'d love to| would like to|\'d like to)|will|may) (?:also |certainly |definitely )?keep (?:your (?:application|resume|profile|information|details|cv)|you) in mind for ' + RJ_FUTURE + RJ_SUITS + '?' + RJ_LATER + '?',
  '(?:we )?hope you(?:\'ll| will)? (?:continue to )?consider (?:us|' + RJ_NAME + ') for ' + RJ_FUTURE + RJ_SUITS + '?' + RJ_LATER + '?',
  '(?:we )?hope (?:that )?(?:we can|to|we may|we will be able to) keep you in (?:our (?:network|talent (?:network|community|pool))|mind)(?: for (?:the future|' + RJ_FUTURE + RJ_SUITS + '?))?' + RJ_LATER + '?',
  'if you (?:want|\'d like|would like|wish) to (?:stay in the loop|stay up to date|stay up-to-date|stay informed|keep up)(?: with (?:us|' + RJ_NAME + '))?',
  '(?:we )?(?:may|might) (?:also )?have ' + RJ_ROLE_FITS + RJ_LATER + '?',
  '(?:(?:we|i) )?(?:will|\'ll|would like to|would love to|\'d love to|\'d like to|may|also)(?: also)?(?: (?:certainly|definitely|gladly|happily))?(?: continue to)? (?:keep|retain) your (?:(?:candidate|applicant) )?(?:resume|application|profile|information|details|cv)(?: (?:on file|(?:in|within) our (?:active )?(?:database|system|files|talent (?:community|pool|network))|handy))?' + RJ_KEEP_FOR,
  'your (?:resume|application|profile|information|details) will be kept (?:on file|in our (?:active )?(?:database|system|files))' + RJ_KEEP_FOR,
  ACK_KEEP_ON_FILE,
  ACK_COMMUNITY,
  'we(?:\'d| would) (?:absolutely )?welcome (?:a new application|the opportunity to reconnect)',
  'we(?:\'d| would) love to keep in touch with you for ' + RJ_FUTURE,
  '(?:and )?with (?:that|this|it) comes? ' + RJ_FUTURE + RJ_SUITS + '?' + RJ_LATER + '?',
  'to stay (?:informed|up to date|up-to-date|updated) (?:about|on) ' + RJ_FUTURE + RJ_SUITS + '?',
  '(?:if you\'d like,? )?(?:you can )?stay (?:informed|up to date|up-to-date) (?:about|on) ' + RJ_FUTURE + '(?: and all things ' + RJ_NAME + ')? by following us(?: on (?:the following platforms|social media))?',
  'we (?:hope|would love for) you (?:will |\'ll )?(?:continue to explore|consider|keep exploring) ' + RJ_FUTURE + '(?: with us)?' + RJ_LATER + '?',
  'we hope (?:you\'ll|you will) (?:continue to )?(?:explore|consider) (?:' + RJ_FUTURE + '|opportunities) (?:with us|at ' + RJ_NAME + ')' + RJ_LATER + '?',
  'we hope you(?:\'ll| will)? (?:keep us in mind|consider applying again)(?: for ' + RJ_FUTURE + ')?' + RJ_LATER + '?',
  '(?:we )?(?:also )?encourage you not to let this be the end of your (?:exploration|search|journey) (?:of|for) (?:careers|opportunities) (?:at|with) (?:us|' + RJ_NAME + ')'
];
// Contact only on a future opening, staying connected with the company and thanks for contact already had: the one
// place outside the decision and the notices where a contact word may stand, and only in the literal text.
var RJ_STAY_CONNECTED = '(?:stay|keep) connected with us(?: (?:on|via|through) (?:social media|our social (?:media|channels)|' + NB_SOCIALS + '|URL))?' +
  '(?: (?:for|to (?:hear|learn) about) ' + RJ_FUTURE + RJ_SUITS + '?)?' + RJ_LATER + '?';
var RJ_FUTURE_CONTACT = [
  // "We'd love to stay in touch", "we'd be glad to consider you for future opportunities": never "consider you for other roles".
  '(?:we(?:\'d| would)?|would) (?:still |also |absolutely )?(?:love|like|be (?:glad|happy|more than happy)) to (?:(?:stay in touch|keep in touch(?: with you)?|stay connected|reconnect|hear from you|keep your (?:details|information|resume) on file and stay in touch)(?: (?:for|about|with) ' + RJ_FUTURE_ONLY + '(?: (?:at|with) ' + RJ_NAME + ')?' + RJ_SUITS + '?)?|consider you(?: for ' + RJ_FUTURE_ONLY + '(?: (?:at|with) ' + RJ_NAME + ')?' + RJ_SUITS + '?| for ' + RJ_FUTURE + RJ_SUITS + '?' + RJ_LATER + '))' + RJ_LATER + '?(?:(?:,? and|,) reconnect' + RJ_LATER + '?)?' +
    '(?: (?:as|when|once|in the event|if|should) (?:the timing is right|' + RJ_FUTURE + ' (?:open up|become available)(?: that (?:may|might) align (?:more closely)?)?|any suitable roles open up(?: on our team)?(?: in the future)?|our team continues to grow|' + RJ_ROLE_FITS + '))?',
  '(?:we|I) hope (?:that )?you (?:do not|don\'t) mind if (?:we|I) reach (?:back )?out (?:to you )?in the future (?:when|if|should) ' + RJ_ROLE_FITS,
  // Contact only on a future opening: "we will reach out if a position opens up that may be a good fit".
  '(?:(?:we(?: will|\'ll| may| hope to| would|\'d)|will|may|would)(?: also)?(?: (?:love|like|be happy) to)? )?reach (?:back )?out(?: to you)?(?: in the future)? (?:if|when|should|if/when|in the event(?: that)?) (?:' + RJ_ROLE_FITS + '|' + RJ_FUTURE + ' (?:arise|open up|become available)' + RJ_SUITS + '?|our needs change|anything changes?(?: on our end)?)' + RJ_LATER + '?',
  '(?:' + RJ_IF_ROLE + '|should there be ' + RJ_ROLE_FITS + ')(?:,? we (?:hope to|will|\'ll|would love to|would be happy to|may) (?:reach (?:back )?out(?: to you)?|contact you)(?: for more (?:details|information))?)?',
  '(?:should|if) (?:things|anything|circumstances|our needs) changes?(?: though)?,? we (?:may|might|will|would)(?: be able to)? (?:reconsider your application(?: and reach (?:back )?out(?: to you)?)?|reach (?:back )?out(?: to you)?)',
  '(?:URL|' + RJ_NAME + ')(?:(?:,| and|,? or) (?:URL|' + RJ_NAME + '))* (?:are|is) (?:also )?(?:a )?great (?:places?|ways?) to (?:keep up|stay up to date|stay connected) with (?:all things ' + RJ_NAME + '|us|our (?:news|team))',
  'we(?: will|\'ll) be in touch (?:should|if) your ' + RJ_DOCS + ' (?:be|are) a (?:good |strong )?(?:fit|match) for ' + RJ_FUTURE,
  '(?:' + RJ_INVITE + ')?' + RJ_STAY_CONNECTED,
  '(?:' + RJ_INVITE + ')?keep up with (?:the )?(?:latest )?(?:happenings|news|updates) (?:at|from) (?:us|' + RJ_NAME + ') by (?:reading our blog|following us)(?: \\( URL \\)| URL)?(?: and (?:staying connected|following us) on ' + NB_SOCIAL + ')?',
  '(?:we )?(?:(?:also|still|truly) )?(?:hope (?:that )?(?:we|our paths) (?:may |will |can )?(?:connect|cross paths)(?: again)?|hope to (?:connect|cross paths|be in touch)(?: with you)?(?: again)?|look forward to (?:the possibility of )?(?:connecting|crossing paths)(?: with you)?(?: again)?) (?:in the future|down the road|someday|one day)',
  '(?:(?:we |i )?(?:(?:really|truly|sincerely|genuinely) )?appreciate|thank you for|thanks for) (?:the time(?: and effort)? you (?:took|spent|invested|have taken)(?: to)?|taking the time to) (?:connect|speak|talk|chat|meet) with (?:us|me|our team)(?: (?:and|to) apply(?: for ' + RJ_JOB + ')?)?(?: (?:regarding|about|for) ' + RJ_JOB + ')?',
  '(?:we(?:\'ll| will) )?(?:be sure to |certainly |definitely )?(?:reconnect|reach (?:back )?out(?: to you)?|be in touch) (?:if|when|should|as soon as) (?:something|anything|a (?:new )?(?:role|position|opening)) (?:opens up|comes up|becomes available)' + RJ_SUITS + '?' + RJ_LATER + '?',
  'we(?:\'d| would)? (?:absolutely )?welcome the (?:opportunity|chance) to (?:stay connected|stay in touch|keep in touch)(?: with you)?' + RJ_LATER + '?',
  '(?:we )?(?:recommend|suggest) (?:setting up|creating|signing up for) (?:a )?job alerts?(?: (?:in|on|through|via) (?:your )?(?:' + RJ_NAME + ' )?(?:candidate |applicant )?(?:profile|account))?(?:,? so (?:that )?you (?:can|will|\'ll) (?:receive|get) (?:e-?mail )?(?:notifications|alerts|updates) (?:when|as) ' + RJ_FUTURE + RJ_SUITS + '? (?:become available|open up|are posted))?'
];
// A status disclaimer: this decision is only about this role.
var RJ_STATUS = [
  '(?:ps:? )?if you(?:\'ve| have) applied (?:for|to) (?:other|multiple|additional) (?:positions|roles|opportunities)(?: at ' + RJ_NAME + ')?,? (?:you(?:\'ll| will) (?:receive separate updates|still be considered for those)(?: regarding those applications| until otherwise noted)?|we(?:\'ll| will) (?:update|notify) you (?:on|about|of) each (?:application|one) separately|you may hear from us more than once|we will be in touch separately about the other roles|(?:please note that )?this (?:message|e-?mail|decision) (?:is|applies) only (?:in reference to|to) (?:the|this) (?:' + RJ_NAME + ' )?(?:role|position))',
  '(?:please note,? )?if you(?:\'re| are) currently (?:interviewing|being considered) for (?:another|other) (?:roles?|positions?)(?: with us)?,? this (?:doesn\'t|does not) affect (?:that|those) (?:process|processes|applications?)',
  'this (?:e-?mail|message) is only intended to address the status of your application for ' + RJ_JOB,
  '(?:ps:? )?if you(?:\'ve| have) applied (?:for|to) (?:other|multiple|additional) (?:positions|roles|opportunities)(?: (?:at|with) (?:us|' + RJ_NAME + '))?,? (?:please note (?:that )?)?this (?:e-?mail|message|decision|update|notification) (?:is|applies) only (?:in reference to|regarding|about|for|related to|relevant to|to) ' + RJ_JOB,
  '(?:ps:? )?if you(?:\'ve| have) applied (?:for|to) (?:other|multiple|additional) (?:positions|roles|opportunities)(?: (?:at|with) (?:us|' + RJ_NAME + '))?,? (?:those|these|your other) applications (?:are|remain) (?:still )?(?:active|open|under (?:review|consideration))(?: and (?:are )?(?:being )?(?:considered|reviewed) separately)?',
  '(?:those|these|your other) applications (?:are|remain) (?:still )?(?:active|open|under (?:review|consideration))(?: and (?:are )?(?:being )?(?:considered|reviewed) separately)?',
  'this (?:decision|e-?mail|message|update) (?:is|applies) only (?:for|to) (?:this|the) (?:specific |particular )?(?:role|position|application)',
  'if you have other applications in process or are currently interviewing for other positions,? this is not a representation of your status for those roles'
];
// The applicant pool and the difficulty of the decision.
var RJ_POOL = [
  '(?:we(?:\'ve| have)? )?(?:received|were fortunate to receive|had) (?:a|an) (?:(?:very|extremely|incredibly) )?(?:(?:large|high|strong|great|significant|overwhelming|huge) )?(?:number|volume|pool|response)(?: of (?:(?:qualified|strong|talented|exceptional) )?(?:applications|applicants|candidates))?(?: (?:to|for) (?:this|our) (?:role|position|opportunity))?',
  '(?:we(?:\'ve| have)? )?(?:receive|received) (?:many|a lot of|so many) (?:(?:qualified|strong|talented) )?(?:applications|applicants|candidates)(?: (?:for|to) (?:this|the) (?:role|position))?',
  '(?:making )?(?:these |our |hiring )?decisions? (?:often )?(?:comes?|came) down to (?:very )?specific needs (?:for|of) (?:this|the) (?:particular )?(?:role|position|team)(?:,? (?:rather than|and is not|not) a reflection (?:of|on) your (?:experience|skills|background|potential)(?: (?:or|and) (?:your )?(?:experience|skills|background|potential))?)?',
  '(?:we(?:\'ve| have) been|we were|we\'re|we are) (?:extremely |very |so )?fortunate to (?:have|receive|have received) (?:a|an) (?:(?:fantastic|great|strong|tremendous|large|overwhelming|incredible) )?response(?: from (?:(?:accomplished|talented|qualified|many|exceptional) )?(?:candidates|applicants)(?: such as yourself| like you(?:rself)?)?)?(?: (?:for|to) (?:this|our|the) (?:role|position))?',
  '(?:we(?:\'re| are|\'ve| have) (?:fortunate to have )?)?(?:received|have received|had|have had) a lot of (?:applicant )?interest(?: in (?:this|the) (?:role|position))?(?:,? resulting in a (?:very |highly )?competitive (?:candidate pool|process|selection process))?',
  '(?:we(?:\'re| are) )?(?:flattered|humbled) by the (?:huge |large |high )?(?:number|volume) of applications we (?:receive|received|have received)(?: from (?:exceptional|talented|qualified|strong) candidates)?',
  '(?:while exciting,? )?this (?:also )?makes the (?:hiring|selection) process (?:that much |even )?more (?:challenging|difficult|competitive)',
  '(?:this|it) was (?:a |an )?(?:(?:very|extremely|highly) )?(?:competitive|difficult|tough) (?:process|decision|search)',
  '(?:this|it) was not an easy decision',
  '(?:this|the) (?:decision|selection process) (?:was|is) (?:(?:very|highly|extremely) )?(?:competitive|difficult|not easy)',
  'competition for (?:the|this) (?:position|role) was (?:very )?strong',
  'some (?:candidates |applicants |of them )?(?:aligned|matched|fit) (?:more closely|better) than others',
  '(?:we )?received (?:quite a few|a (?:great|large) number of) (?:applications|applicants|candidates)(?: (?:for|to) (?:this|the) (?:job |role |position )?(?:opportunity|role|position))?',
  '(?:making|which made|which makes) (?:the|our) (?:selection|hiring|recruiting) process (?:(?:highly|very|extremely|incredibly) )?competitive',
  'we (?:carefully |thoroughly )?review each (?:candidate|applicant)\'s ' + RJ_DOCS,
  '(?:please be assured that )?your application was (?:carefully )?reviewed by (?:a member of )?our (?:' + RJ_NAME + ' )?(?:recruiting|talent acquisition|talent|hiring|people) team(?:,? in line with (?:the )?specific requirements (?:for|of) (?:this|the) (?:role|position))?',
  '(?:you )?may be disappointed (?:at|by|with) (?:the|this) (?:outcome|news|decision)',
  'there (?:was|has been) (?:(?:very|extremely|incredibly) )?(?:significant|considerable|tremendous|strong|high|a lot of|so much) interest in (?:the|this) (?:' + RJ_NAME + ' )?(?:role|position)',
  'please know that (?:we don\'t make these decisions lightly|this decision was not made lightly)',
  '(?:please know that )?(?:we (?:don\'t|do not) (?:make|take) (?:these|this|such) decisions? lightly|this decision was not made lightly)',
  '(?:we(?:\'ve| have)? )?(?:receive|received|had|have had) (?:so )?many (?:(?:highly |very )?(?:qualified|strong|talented|exceptional) )?(?:applications|applicants|candidates)(?: (?:for|to) (?:this|the) (?:role|position))?(?:,? including (?:yourself|you))?',
  'this decision (?:does not|doesn\'t) (?:diminish|reflect on) (?:the value we saw in your application(?: and background)?|your potential(?: or the value of your experience)?)',
  '(?:that|this|the) decision (?:doesn\'t|does not) take away from (?:the (?:great )?(?:skills|experience)(?: and (?:experiences?|skills))? you bring|your (?:skills|experience|qualifications))',
  'it (?:simply )?reflects how competitive (?:this|the) process (?:has been|was|is)',
  '(?:we )?(?:had|have) to make (?:some )?(?:(?:very|really|incredibly|extremely) )?(?:difficult|tough|hard) (?:choices|decisions|calls)(?: among an exceptional group of candidates)?',
  'these are never easy (?:messages|emails|decisions) to (?:send|make)',
  'we were faced with (?:several|many|some|a number of) (?:very )?(?:difficult|tough|hard) (?:decisions|choices)(?: during (?:the|our) (?:selection|hiring|review) process)?',
  'we understand how important timely (?:communication|updates) (?:is|are)(?: during a job search)?(?: and (?:wanted|want) to (?:ensure|make sure) (?:that )?we (?:provided|provide|gave|give) you (?:with )?a (?:clear|timely) update)?',
  'we understand (?:this|that this) may be disappointing(?:,? and we apologize for any inconvenience (?:this|it) may cause)?',
  '(?:due to (?:the )?(?:(?:high|large) (?:volumes?|number) of (?:applications|candidates|applicants)(?: we receive)?|number of candidates we(?:\'re| are) reviewing),? )?we(?:\'re| are| do not| don\'t) (?:unable|not able|have the (?:bandwidth|capacity|resources)) to (?:offer|provide) (?:(?:individual|custom|personal|specific|additional|detailed) )?feedback(?: (?:on your application|on (?:applications|resumes)(?: or (?:applications|resumes))?|at this (?:point|stage|time)|at this (?:point|stage) (?:in|of) the process|at this early stage of the process|due to the (?:(?:high|large) )?(?:volume|number) of (?:applications|candidates)(?: we(?:\'re| are) reviewing| we receive)?))*'
];
// The lines around the letter: a greeting, the team that signs it, a lone name, a link row, a requisition number.
var RJ_TEAM_NAME = '(?:the )?(?:' + RJ_NAME + ' )?(?:recruiting|recruitment|talent|talent acquisition|talent attraction|people|people & culture|hiring|hr)';
var RJ_TEAM_AT = '(?: (?:at|@) ?' + RJ_NAME + ')?';
var RJ_TEAM = RJ_TEAM_NAME + '(?: team)?' + RJ_TEAM_AT;
var RJ_FRAME = [
  '(?:hi|hello|dear|hey) ' + RJ_NAME,
  RJ_TEAM,
  '(?:the )?team (?:at|@) ' + RJ_NAME,
  '(?:' + RJ_NAME + ' )?jobs(?: \\( URL \\)| URL)?',
  RJ_PLACE,
  '[a-z0-9-]+\\.(?:com|io|ai|co|org|net)(?: \\( URL \\)| URL)?',
  '(?:[\\[\\](){}*#|·•>_-]|\\d{1,2}\\.?|URL|visible links| )+',
  '(?:' + RJ_NAME + '|URL)(?: ?\\( URL \\))?(?: ?[|·•] ?(?:' + RJ_NAME + '|URL)(?: ?\\( URL \\))?)+',
  '(?:' + RJ_NAME + ' ?)?[a-z]{0,3}-?\\d{4,9}',
  '[a-z0-9]{24,}',
  '(?:©|\\(c\\)|copyright) ?\\d{4}(?: ' + RJ_NAME + ')?(?: ?[|.,] ?all rights reserved)?',
  '(?:please note (?:that )?)?this (?:e-?mail|mailbox|inbox|e-?mail box) is not monitored(?:,? and replies will not be (?:seen|read)(?: or responded to)?)?',
  'replies to this (?:e-?mail|message) are undeliverable(?:,? and will not reach (?:the )?' + RJ_NAME + ')?',
  'this (?:e-?mail|message) was (?:sent|distributed) (?:by|on behalf of) (?:the )?' + RJ_NAME,
  'this (?:e-?mail|message|notification) was (?:automatically |auto-?)?generated by (?:the )?' + RJ_NAME,
  'in accordance with our (?:' + RJ_NAME + ' )?privacy (?:statement|policy|notice)(?: \\( URL \\)| URL)?,? we (?:will|may) (?:continue to )?(?:process|retain) your personal (?:information|data)(?:,? including to consider you for an? (?:alternative|future|other)(?: or (?:alternative|future|other))? (?:position|role)s?)?',
  'if you have any questions about our (?:candidate )?data practices(?: or (?:you )?would like to exercise your (?:rights|privacy rights)(?: and choices)?)?,? please (?:email|contact) us at EMAIL',
  '(?:for (?:more )?information (?:about|on) how we (?:handle|process|use|collect) (?:your |applicant )?(?:data|personal data|information),? )?(?:you (?:can|may) |please )?(?:review|read|see|view) our (?:' + RJ_NAME + ' )?(?:(?:and|&) ' + RJ_NAME + ' )?privacy (?:policy|notice)(?: here)?(?: \\( URL(?: \\))?| URL)?'
];
// How the applicant's data is kept, and the recruiting-fraud warning some letters carry.
var RJ_PRIVACY_POLICY = 'our ?(?:' + RJ_NAME + ' )?(?:(?:and|&) ' + RJ_NAME + ' )?privacy (?:policy|notice|statement)(?: \\( URL \\)| URL)?';
var RJ_NOTICES = [
  'your (?:applicant |personal |candidate )?(?:information|data) will (?:always )?be (?:stored|kept|retained)(?: and processed)? in accordance with ' + RJ_PRIVACY_POLICY,
  RJ_NAME + ' will retain and process your personal (?:data|information)(?: submitted (?:via|with|through) your application)?(?: for a limited period)? in accordance with ' + RJ_PRIVACY_POLICY,
  'if contacted by a suspicious (?:profile|person|account|message|recruiter)(?:,? or if something (?:feels|seems) off)?,? (?:don\'t|do not) engage(?: ?[—–-] ?|, | )email us (?:at )?(?:URL|EMAIL) to verify',
  'always (?:confirm|verify)(?: or apply for)? (?:any )?(?:open )?(?:roles|positions|jobs|opportunities) directly (?:on|through|via) (?:the |our )?(?:official )?' + RJ_PLACE
];
var RJ_CLAUSES = [RJ_DECISION_SENTENCE, RJ_REVIEWED_CLAUSE, RJ_PRAISE_CLAUSE, RJ_OPENING, RJ_THANKS, RJ_THANKS_MORE, RJ_APPRECIATE, RJ_APPRECIATE_WHAT, RJ_WISH,
  ACK_THANKS, ACK_APPRECIATE, ACK_WISH, ACK_THANKS_TIME].concat(RJ_FUTURE_SENTENCES, RJ_FUTURE_CONTACT, RJ_STATUS, RJ_POOL, RJ_NOTICES, NOTICE_CLAUSES);
var RJ_MAX_REPEAT = 8;

/** The pattern with every repeated group that holds a name slot written out copy by copy, an unbounded one up to
 *  RJ_MAX_REPEAT times. A capture inside a repeat keeps only its last match, so acknowledges_ could not check the
 *  slots of the earlier repeats; each copy captures its own. */
function unrollRepeats_(src) {
  for (;;) {
    var stack = [], site = null, inClass = false;
    for (var i = 0; i < src.length && !site; i++) {
      var c = src[i];
      if (c === '\\') { i++; continue; }
      if (inClass) { inClass = c !== ']'; continue; }
      if (c === '[') { inClass = true; continue; }
      if (c === '(') { stack.push({ start: i, capture: src[i + 1] !== '?' || src[i + 2] === '<' && /[A-Za-z]/.test(src[i + 3]), holds: false }); continue; }
      if (c !== ')') continue;
      var group = stack.pop(), q = /^(?:\*|\+|\{(\d+)(?:(,)(\d*))?\})(\??)/.exec(src.slice(i + 1));
      var min = !q ? 1 : q[0][0] === '*' ? 0 : q[0][0] === '+' ? 1 : Number(q[1]);
      var max = !q ? 1 : q[0][0] === '*' || q[0][0] === '+' || (q[2] && !q[3]) ? RJ_MAX_REPEAT : q[2] ? Number(q[3]) : min;
      if (max > 1 && group.holds) site = { start: group.start, end: i + 1, after: i + 1 + q[0].length, min: min, max: max, lazy: q[4] };
      if (stack.length) stack[stack.length - 1].holds = stack[stack.length - 1].holds || group.holds || group.capture;
    }
    if (!site) return src;
    var copy = src.slice(site.start, site.end), optional = '';
    for (var k = site.min; k < site.max; k++) optional = '(?:' + copy + optional + ')?' + site.lazy;
    src = src.slice(0, site.start) + new Array(site.min + 1).join(copy) + optional + src.slice(site.after);
  }
}

function rejectionRegExp_(pattern) { return new RegExp(unrollRepeats_(pattern), 'i'); }

/** The pattern split at its top-level "|". */
function topAlternatives_(src) {
  var out = [], depth = 0, inClass = false, from = 0;
  for (var i = 0; i < src.length; i++) {
    var c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { inClass = c !== ']'; continue; }
    if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && !depth) { out.push(src.slice(from, i)); from = i + 1; }
  }
  return out.concat(src.slice(from));
}

/** Lowercase literal runs any case-insensitive match of the pattern holds, as lists of which every match holds at
 *  least one string each. A run breaks at every escape, class, group, quantifier or non-ASCII character, so the lists
 *  are only ever looser than the pattern. */
function requiredLiterals_(src) {
  var i = 0, quant = /(?:[?*+]|\{(\d+)(?:,\d*)?\})\??/y;
  var minRepeat = function () {
    quant.lastIndex = i;
    var q = quant.exec(src);
    if (!q) return 1;
    i = quant.lastIndex;
    return q[0][0] === '+' ? 1 : q[0][0] === '{' ? Number(q[1]) : 0;
  };
  var shortest = function (any) { return Math.min.apply(null, any.map(function (s) { return s.length; })); };
  var sequence = function () {
    var need = [], run = '';
    var flush = function () { if (run.trim().length >= 3) need.push([run]); run = ''; };
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      var c = src[i], head = src.substr(i, 4);
      if (c === '(') {
        var look = /^\(\?<?[=!]/.test(head);
        i += look ? (src[i + 2] === '<' ? 4 : 3) : /^\(\?<[A-Za-z]/.test(head) ? src.indexOf('>', i) + 1 - i : src[i + 1] === '?' ? 3 : 1;
        var inner = alternation();
        i++;
        flush();
        if (minRepeat() > 0 && !look) need = need.concat(inner);
      } else if (c === '[') {
        for (i++; src[i] !== ']'; i++) if (src[i] === '\\') i++;
        i++;
        flush();
        minRepeat();
      } else if (c === '\\' || '.^${}?*+'.indexOf(c) >= 0 || c.charCodeAt(0) > 127) {
        i += c !== '\\' ? 1 : src[i + 1] === 'u' ? 6 : src[i + 1] === 'x' ? 4 : src[i + 1] === 'c' ? 3 : 2;
        flush();
        minRepeat();
      } else {
        i++;
        quant.lastIndex = i;
        if (quant.test(src)) { flush(); minRepeat(); } else run += c.toLowerCase();
      }
    }
    flush();
    return need;
  };
  var alternation = function () {
    var options = [sequence()];
    while (src[i] === '|') { i++; options.push(sequence()); }
    if (options.length === 1) return options[0];
    var any = [];
    for (var o = 0; o < options.length; o++) {
      if (!options[o].length) return [];
      any = any.concat(options[o].reduce(function (best, x) { return shortest(x) > shortest(best) ? x : best; }));
    }
    return [any.filter(function (s, k) { return any.indexOf(s) === k; })];
  };
  return alternation();
}

/** One anchored expression per top-level alternative of the pattern, built on first need, each with the literals a
 *  match must hold: a sentence without them never compiles or runs it. Tried in order, the first that matches stands
 *  for the whole alternation, as it would in the one expression. A part with name slots runs first with the loose guard
 *  in place of theirs, which is most of its size: it matches whatever the guarded one does, and when no word of its
 *  first match's names is guarded that match is the guarded one's first too. Only otherwise is the guarded one built. */
function rejectionShape_(pattern, tail) {
  return topAlternatives_(pattern).map(function (alt) {
    var source = '^(?:' + alt + ')' + tail, loose = source.split(RJ_NAME_GUARD).join(RJ_NAME_LOOSE_GUARD);
    return { source: source, loose: loose === source ? null : loose, need: requiredLiterals_(alt), re: null, strict: null };
  });
}

function guardedName_(name) {
  return !!name && name.split(/,? /).some(function (word) { return RJ_GUARDED_WORD.test(word); });
}

function shapeMatch_(shape, text) {
  var lower = text.toLowerCase();
  for (var i = 0; i < shape.length; i++) {
    var part = shape[i];
    if (!part.need.every(function (any) { return any.some(function (s) { return lower.indexOf(s) >= 0; }); })) continue;
    part.re = part.re || rejectionRegExp_(part.loose || part.source);
    var m = part.re.exec(text);
    if (m && part.loose && m.slice(1).some(guardedName_)) {
      part.strict = part.strict || rejectionRegExp_(part.source);
      m = part.strict.exec(text);
    }
    if (m) return m;
  }
  return null;
}

// One expression per clause alternative, and the leads apart: a single alternation of them all backtracks for seconds
// on a long near-miss sentence, the leads repeated in every clause cost seconds to compile, and compiling every
// alternative up front runs Apps Script out of memory.
var REJECTION_CLAUSES = RJ_CLAUSES.map(function (clause) { return rejectionShape_(clause, '$'); });
var RJ_CONTACT_EXEMPT = [RJ_DECISION_SENTENCE].concat(RJ_FUTURE_CONTACT, RJ_STATUS, RJ_POOL, RJ_NOTICES);
var RJ_CONTACT_CHECKED = RJ_CLAUSES.map(function (clause) { return RJ_CONTACT_EXEMPT.indexOf(clause) < 0; });
var RJ_ANY_LEAD = RJ_LEADS + '|' + RJ_TEAM_NAME + ' team' + RJ_TEAM_AT + '|' + RJ_LINK_ROW + '|(?:hi|hello|dear|hey) ' + RJ_NAME + ' ?';
var REJECTION_LEADS = rejectionRegExp_('^(?:' + RJ_ANY_LEAD + ')(?:,? (?:' + RJ_ANY_LEAD + ')){0,2},?$');
// A frame line stands alone as a whole sentence, never as one clause of a longer one; an emoji may trail it.
var REJECTION_FRAME = RJ_FRAME.map(function (line) {
  return rejectionShape_(line, '(?: ?(?:[\\uD83C-\\uD83E][\\uDC00-\\uDFFF]|[\\u2600-\\u27BF]))*$');
});

function rejectionClause_(text) {
  var bare = function (s) {
    var contact = RJ_CONTACT_STEM.test(s);
    return REJECTION_CLAUSES.some(function (re, i) { return !(contact && RJ_CONTACT_CHECKED[i]) && acknowledges_(re, s, RJ_VETO_WORD); });
  };
  if (bare(text)) return true;
  var s = text.replace(/\s+/g, ' ').trim();
  for (var p = s.indexOf(' '); p > 0 && p < 200; p = s.indexOf(' ', p + 1)) {
    var lead = s.slice(0, p);
    if (!RJ_CONTACT_STEM.test(lead) && acknowledges_(REJECTION_LEADS, lead, RJ_VETO_WORD) && bare(s.slice(p + 1))) return true;
  }
  return false;
}

/** True when the sentence is one allowlisted rejection clause, or up to four of them joined by a comma, a semicolon,
 *  a dash or a conjunction. */
function rejectionSentence_(sentence, depth) {
  if (rejectionClause_(sentence)) return true;
  if ((depth || 0) >= 3) return false;
  var join = new RegExp(RJ_JOIN.source, 'gi'), m;
  while ((m = join.exec(sentence))) {
    var head = sentence.slice(0, m.index).trim();
    if (head && rejectionClause_(head) && rejectionSentence_(sentence.slice(m.index + m[0].length), (depth || 0) + 1)) return true;
  }
  return false;
}

/** The first sentence, or set-aside greeting or signature line holding a scheduling word, that is neither a standard
 *  footer nor an allowlisted rejection or courtesy shape, or null when every sentence is one. */
function unexplainedRejection_(body) {
  var parts = bodyParts_(body);
  if (parts.line) return parts.line;
  var paragraphs = parts.paragraphs, last = paragraphs.length - 1;
  while (last >= 0 && lineSentences_(paragraphs[last]).every(frameSentence_)) last--;
  for (var p = 0; p < paragraphs.length; p++) {
    if (p === last && parts.signable[p] && signedName_(paragraphs[p])) continue;
    var sentences = lineSentences_(paragraphs[p]);
    for (var s = 0; s < sentences.length; s++) {
      if (!frameSentence_(sentences[s]) && !rejectionSentence_(bareSentence_(sentences[s]))) return sentences[s];
    }
  }
  return null;
}

function bareSentence_(sentence) { return sentence.replace(/^[-*•·]\s+/, '').replace(/[,:;]+$/, ''); }

function frameSentence_(sentence) {
  var bare = bareSentence_(sentence);
  return footer_(sentence) || REJECTION_FRAME.some(function (re) { return acknowledges_(re, bare, RJ_VETO_WORD); });
}

// The one capitalised word a letter may be signed with ("Best,\nJane", "- Shopify"), as the last paragraph before the
// footer and frame lines, right under a sign-off line or on a "- " line. A word that asks for contact ("Emailed.",
// "Holler.") is no signature.
var RJ_SIGNED_NAME = /^[A-Z][A-Za-z'&-]*\.?$/;
var RJ_SIGN_OFF_LINE = /^(?:best|(?:(?:best|kind|warm|warmest) )?regards|(?:many )?thanks|sincerely|cheers|warmly)\s*[,.!]?$/i;
var RJ_CONTACT_WORD = new RegExp('^(?:' + RJ_CONTACT_VERB + ')\\w*', 'i');

function signedName_(paragraph) {
  return RJ_SIGNED_NAME.test(paragraph) && !ACK_VETO_WORD.test(paragraph) && !SCHEDULING_WORDS.test(paragraph) &&
    !RJ_CONTACT_WORD.test(paragraph) && !RJ_CONTACT_STEM.test(paragraph);
}

// Never a plain rejection, whatever its shapes: a task to complete (an assessment, test, questionnaire or form), anything
// to upload, sign or submit, a direct question to the candidate, a specific other role the company wants to discuss, or
// a role paused or put on hold rather than filled or closed.
var RJ_VETOES = [
  [/\b(?:assessments?|tests?|testing|quiz(?:zes)?|questionnaires?|forms?|assignments?|take[- ]?homes?|case stud(?:y|ies)|work samples?|coding (?:exercises?|challenges?))\b/i,
    /\b(?:careful|thorough|our|initial|after|following|upon|based on) (?:\w+ ){0,2}assessment of\b|\bassessment of (?:your|the|all|each|every|our|many|candidates|applicants)\b|\bin any form\b|\bform of (?:a |an )?(?:\w+ )?(?:feedback|communication|discrimination|harassment|identification)\b/gi],
  [/\b(?:upload|re-?submit|submit|e-?sign|sign(?! (?:up|in|on)\b))\b/i,
    /\b(?:for|to) (?:\w+ ){0,4}?submit (?:your|an|the|this|a) (?:\w+ ){0,2}?(?:application|resume|cv|candidacy|profile|materials|information)\b|\bto submit for an? (?:new )?(?:role|position|job)\b|\b(?:hit(?:ting)?|click(?:ing)?|press(?:ing)?) ['"]?submit\b/gi],
  [/\b(?:you|your|yours|yourself)\b[^?]*\?["')\]]*$/i],
  [/\b(?:discuss|talk(?:ing)? (?:with you |to you )?about|chat(?:ting)? (?:with you )?about|speak(?:ing)? (?:with you |to you )?about|tell you (?:more )?about|introduce you to|refer(?:ring)? you (?:to|for)|connect you with|put you forward for|submit you for)\b[^.?!]{0,80}?\b(?:roles?|positions?|openings?|opportunit(?:y|ies)|teams?|reqs?|requisitions?|jobs?)\b/i],
  [/\bconsider(?:ing)? you for (?!(?:any |other |similar |new |open |relevant |suitable |potential |later |future |upcoming )?(?:future|other|upcoming|similar|new|open|relevant|suitable|potential|later)\b)[^.?!]{0,60}?\b(?:roles?|positions?|openings?)\b/i,
    /\bthank(?:s| you) (?:\w+ ){0,3}?for (?:giving us |allowing us |the )?(?:the )?(?:opportunity|chance|privilege) to consider you for\b|\bconsider(?:ing)? you for (?:an?|another|any|other) [^.?!]{0,40}?\bin the future\b/gi],
  [/\byou(?:'d| would| might| could| may)(?: also)? be (?:a |an )?(?:\w+ )?(?:fit|match) for (?!(?:this|the|that) (?:role|position|opening|job|opportunity)\b)/i],
  [/\b(?:on hold|paus(?:e|ed|es|ing)|hiring freeze|freez(?:e|es|ing)|frozen|postpon\w*|on ice|delay(?:ed|ing)? (?:the |this |our )?(?:hiring|search|role|position|process))\b/i]
];

/** The first sentence of the body that holds a veto, or null. */
function rejectionVeto_(body) {
  var sentences = splitSentences(String(body || '').replace(/[‘’]/g, "'"));
  for (var i = 0; i < sentences.length; i++) {
    for (var k = 0; k < RJ_VETOES.length; k++) {
      var harmless = RJ_VETOES[k][1];
      if (RJ_VETOES[k][0].test(harmless ? sentences[i].replace(harmless, ' ') : sentences[i])) return sentences[i];
    }
  }
  return null;
}

function rejectionStands_(body) {
  return unexplainedRejection_(body) === null && invitesContact_(body) === null && rejectionVeto_(body) === null &&
    !splitSentences(body).some(function (sentence) {
      return REPLY_REQUEST.test(sentence) || (directOffer_(sentence) && !FUTURE_ONLY.test(sentence));
    });
}
