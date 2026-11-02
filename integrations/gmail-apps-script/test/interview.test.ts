import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const APPLICATIONS = 'Job Duck/Applications';
const REJECTIONS = 'Job Duck/Rejections';
const INTERVIEWS = 'Job Duck/Interviews';

const INVITE_BODY =
  "Hi Danlin,\n\nExcited to kick off the interview process with you - before we schedule anything, I'd love for you to fill out a quick questionnaire.\n\nThe Salient Hiring Team";
const CONFIRMATION_BODY =
  'Hi Danlin,\n\nThank you for applying to the Platform Engineer position at Globex. We have received your application.\n\nGlobex Careers';
const REJECTION_BODY =
  'Hi Danlin,\n\nThank you for taking the time to interview with us. Unfortunately, we have decided not to move forward.\n\nHooli Recruiting';
const ACME_CONFIRMATION =
  'Hi Danlin,\n\nThank you for applying to the Backend Engineer role at Acme. We have received your application and our team will review it.\n\nAcme Recruiting';
const ACME_REJECTION =
  'Hi Danlin,\n\nThank you for applying to the Backend Engineer role at Acme. Unfortunately, we have decided not to move forward with your application.\n\nAcme Recruiting';
const RECRUITER_NOTE =
  "Hi Danlin,\n\nI'm the recruiter for this role and wanted to say thanks for applying. I have passed your profile to the team.\n\nMaya";

type Label = { name: string; getName(): string };
type Message = ReturnType<typeof message>;
type FakeThread = ReturnType<typeof thread>;

function label(name: string): Label {
  return { name, getName: () => name };
}

let nextId = 0;

function message(subject: string, body: string, from = 'Recruiting <no-reply@greenhouse.io>') {
  const id = ++nextId;
  const m = {
    thread: null as FakeThread | null,
    getFrom: () => from,
    getSubject: () => subject,
    getPlainBody: () => body,
    getDate: () => new Date(),
    getHeader: () => '<' + id + '@example.com>',
    getId: () => 'id-' + id,
    getThread: () => m.thread,
  };
  return m;
}

function thread(labels: string[], messages: Message[], inInbox = true) {
  const t = {
    labels: new Set(labels),
    inInbox,
    calls: [] as string[],
    getLabels: () => [...t.labels].map(label),
    getMessages: () => messages,
    addLabel: (l: Label) => { t.calls.push('add ' + l.name); t.labels.add(l.name); },
    removeLabel: (l: Label) => { t.calls.push('remove ' + l.name); t.labels.delete(l.name); },
    moveToArchive: () => { t.calls.push('archive'); t.inInbox = false; },
    moveToInbox: () => { t.calls.push('inbox'); t.inInbox = true; },
  };
  messages.forEach((m) => { m.thread = t; });
  return t;
}

function store(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getProperty: (k: string) => (k in data ? data[k] : null),
    setProperty: (k: string, v: string) => { data[k] = String(v); },
    deleteProperty: (k: string) => { delete data[k]; },
    getKeys: () => Object.keys(data),
    getProperties: () => ({ ...data }),
  };
}

function load(threads: FakeThread[], scriptProps: Record<string, string> = {}) {
  const logs: string[] = [];
  const scriptStore = store(scriptProps);
  const sandbox: Record<string, unknown> = {
    Logger: { log: (m: unknown) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => scriptStore, getUserProperties: () => store() },
    Session: { getActiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    GmailApp: {
      getUserLabelByName: (name: string) => label(name),
      search: (query: string, start: number, max: number) =>
        threads
          .filter((t) => (query.includes(APPLICATIONS) ? t.labels.has(APPLICATIONS) : query.includes('in:inbox') && t.inInbox))
          .slice(start, start + max),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') +
      '\nthis.__api = { processThread_, reauditApplications, previewReaudit, preview, isInterview };',
    sandbox,
  );
  const api = sandbox.__api as {
    processThread_(t: FakeThread): string;
    reauditApplications(): void;
    previewReaudit(): void;
    preview(): void;
    isInterview(body: string): boolean;
  };
  return { api, logs, scriptStore };
}

describe('processThread_ keeps interview mail in the Inbox', () => {
  test('interview mail gets Interviews, no Applications, and is not archived', () => {
    const t = thread([], [message('Salient | A few things to know before your interview...', INVITE_BODY, 'The Salient Hiring Team <no-reply@ashbyhq.com>')]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual(['add ' + INTERVIEWS]);
    expect(t.inInbox).toBe(true);
  });

  test('an Applications thread whose latest job message is an invite loses Applications', () => {
    const t = thread([APPLICATIONS], [message('Thanks for applying', CONFIRMATION_BODY), message('Next step with Acme', INVITE_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual(['add ' + INTERVIEWS, 'remove ' + APPLICATIONS]);
    expect([...t.labels]).toEqual([INTERVIEWS]);
  });

  test('KEEP_ACTION_MAIL_IN_INBOX set or unset never changes interview handling', () => {
    const t = thread([], [message('Next step with Acme', INVITE_BODY)]);
    const { api } = load([t], { KEEP_ACTION_MAIL_IN_INBOX: 'true' });
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).not.toContain('archive');
  });

  test('an interview subject over a confirmation body is archived as application mail', () => {
    const t = thread([], [message('Interview Scheduling Team: application received', CONFIRMATION_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('job');
    expect(t.calls).toEqual(['add ' + APPLICATIONS, 'archive']);
  });

  test('a thread already labeled Interviews is not archived when a plain update arrives', () => {
    const t = thread([INTERVIEWS], [message('Next step with Acme', INVITE_BODY), message('Your application', CONFIRMATION_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual([]);
  });

  test('a lone rejection is archived; a rejection after an invite keeps the thread in the Inbox', () => {
    const plain = thread([], [message('Your interview with Hooli', REJECTION_BODY)]);
    const interviewed = thread([INTERVIEWS], [message('Next step with Hooli', INVITE_BODY), message('Your interview with Hooli', REJECTION_BODY)]);
    const { api, scriptStore } = load([plain, interviewed]);
    expect(api.processThread_(plain)).toBe('deny');
    expect(plain.calls).toEqual(['add ' + REJECTIONS, 'archive']);
    expect(api.processThread_(interviewed)).toBe('interview');
    expect(interviewed.calls).toEqual([]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(1);
  });

  test('an invite after the latest rejection makes the thread interview, not deny', () => {
    const t = thread([APPLICATIONS], [message('Your interview with Hooli', REJECTION_BODY), message('Next step with Hooli', INVITE_BODY)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual(['add ' + INTERVIEWS, 'remove ' + APPLICATIONS]);
    expect(t.inInbox).toBe(true);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
  });

  test('a rejection that offers a call about another role is interview, not deny', () => {
    const body =
      "Hi Danlin,\n\nWe have decided not to move forward with your application for the Senior role, but we'd like to schedule a call about our Staff role.\n\nHooli Recruiting";
    const t = thread([], [message('Your application to Hooli', body)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual(['add ' + INTERVIEWS]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
  });

  test('a rejection that only thanks you for interviewing, or offers to keep in touch, stays deny', () => {
    const keepInTouch =
      "Hi Danlin,\n\nUnfortunately, we have decided not to move forward. We'd love to connect with you about future opportunities.\n\nHooli Recruiting";
    const plain = thread([], [message('Your interview with Hooli', REJECTION_BODY)]);
    const courtesy = thread([], [message('Your interview with Hooli', keepInTouch)]);
    const { api } = load([plain, courtesy]);
    expect(api.processThread_(plain)).toBe('deny');
    expect(api.processThread_(courtesy)).toBe('deny');
    expect(courtesy.calls).toEqual(['add ' + REJECTIONS, 'archive']);
  });

  test('a rejection that is not the latest job message keeps the thread in the Inbox', () => {
    const t = thread([], [message('Your interview with Hooli', REJECTION_BODY), message('Your application', CONFIRMATION_BODY)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual(['add ' + INTERVIEWS]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
  });

  test('a thread labeled Rejections and Interviews is left in the Inbox', () => {
    const t = thread([REJECTIONS, INTERVIEWS], [message('Your interview with Hooli', REJECTION_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('skipped');
    expect(t.calls).toEqual([]);
  });
});

describe('the archive is an allowlist', () => {
  const outcomes = (data: Record<string, string>) => Object.keys(data).filter((k) => k.startsWith('outcome:'));

  test('a Greenhouse confirmation followed by a rejection is archived as a rejection', () => {
    const t = thread([APPLICATIONS], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Update on your application', ACME_REJECTION)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('deny');
    expect(t.calls).toEqual(['add ' + REJECTIONS, 'remove ' + APPLICATIONS, 'archive']);
    expect(outcomes(scriptStore.data)).toHaveLength(1);
  });

  test('a recruiter note between the confirmation and the rejection keeps the thread in the Inbox', () => {
    const t = thread([APPLICATIONS], [
      message('Thank you for applying to Acme', ACME_CONFIRMATION),
      message('Re: Thank you for applying to Acme', RECRUITER_NOTE, 'Maya Chen <maya@acme.com>'),
      message('Update on your application', ACME_REJECTION),
    ]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual(['add ' + INTERVIEWS, 'remove ' + APPLICATIONS]);
    expect(t.inInbox).toBe(true);
    expect(outcomes(scriptStore.data)).toHaveLength(0);
  });

  test('a thread already labeled Rejections that gets an invite goes back to the Inbox as Interviews (F35-9)', () => {
    const rejection = message('Update on your application', ACME_REJECTION);
    const invite = message(
      'Re: Update on your application',
      'Hi Danlin,\n\nThank you for applying to the Backend Engineer role at Acme. Our Staff Engineer role just opened and we would like to schedule a phone screen with you for it next week.\n\nAcme Recruiting',
    );
    const t = thread([REJECTIONS], [rejection, invite]);
    const { api, scriptStore } = load([t], { ['outcome:' + rejection.getHeader()]: '{}' });
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual(['add ' + INTERVIEWS, 'remove ' + REJECTIONS, 'inbox']);
    expect([...t.labels]).toEqual([INTERVIEWS]);
    expect(outcomes(scriptStore.data)).toHaveLength(0);
  });

  test('a thread labeled Rejections whose rejection still stands is re-archived without being re-queued', () => {
    const t = thread([REJECTIONS], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Update on your application', ACME_REJECTION)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('skipped');
    expect(t.calls).toEqual(['archive']);
    expect(outcomes(scriptStore.data)).toHaveLength(0);
  });

  test('a confirmation with scheduling boilerplate stays in the Inbox', () => {
    const body =
      'Hi Danlin,\n\nThank you for applying to the Data Engineer role at Initech. Our team will review your application and next steps.\n\nIf your experience matches, we will reach out to schedule an interview.\n\nInitech Recruiting';
    const t = thread([], [message('Thank you for applying to Initech', body)]);
    const { api } = load([t]);
    expect(api.isInterview(body)).toBe(false);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.calls).toEqual(['add ' + INTERVIEWS]);
  });

  test('a personal note after a confirmation stays in the Inbox even without scheduling words', () => {
    const t = thread([], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Re: Thank you for applying to Acme', RECRUITER_NOTE, 'Maya Chen <maya@acme.com>')]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('interview');
    expect(t.inInbox).toBe(true);
  });

  test('two plain confirmations are archived as application mail', () => {
    const t = thread([], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Your application', CONFIRMATION_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('job');
    expect(t.calls).toEqual(['add ' + APPLICATIONS, 'archive']);
  });

  test('verification-code mail is application mail, kept in the Inbox only with KEEP_ACTION_MAIL_IN_INBOX', () => {
    const body = 'Your verification code is 482913. Enter it to continue your application for the Backend Engineer role.';
    const archived = thread([], [message('Your verification code', body)]);
    const kept = thread([], [message('Your verification code', body)]);
    expect(load([archived]).api.processThread_(archived)).toBe('job');
    expect(archived.calls).toEqual(['add ' + APPLICATIONS, 'archive']);
    expect(load([kept], { KEEP_ACTION_MAIL_IN_INBOX: 'true' }).api.processThread_(kept)).toBe('kept');
    expect(kept.calls).toEqual(['add ' + APPLICATIONS]);
  });
});

describe('isInterview reads invites in the body', () => {
  const { api } = load([]);

  test.each([
    'If you are still interested, we would like to schedule a phone screen with you next week.',
    'If you are interested, we would like to invite you to interview for the role.',
    'Should you wish to proceed, we can schedule a call with the hiring manager this week.',
    'Once you confirm, we will schedule your onsite interview.',
  ])('a courtesy conditional before an invite stays interview mail: %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(true);
  });

  test.each([
    'Congratulations! You have been selected to move forward to the interview stage.',
    'Your interview is confirmed for Tuesday at 2pm PT.',
  ])('stage and confirmed-time wording is interview mail: %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(true);
  });

  test.each([
    'If your experience matches, we will reach out to schedule an interview.',
    'If you are selected, we will reach out to schedule an interview.',
    'Should your background align with the role, we will contact you to schedule a call.',
  ])('an employer-side conditional promise is not interview mail: %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(false);
  });

  test.each([
    'Applicants who move forward to the interview stage will be contacted by a recruiter.',
    'If you are selected for the interview stage, you will receive an email from our team.',
    'Candidates moving forward in the interview process will be contacted within two weeks.',
    'If you are interested and your experience matches, we will reach out to schedule an interview.',
    'If you have any questions or if your background is a fit, we will reach out to schedule an interview.',
    'If your experience matches, we will schedule an interview.',
    'If we decide to move forward, we will schedule a phone screen.',
    'If selected, you will be invited to an onsite interview.',
    'You will hear from us about the interview stage soon.',
    'Please select the time zone you are located in.',
  ])('a future-contact promise or employer-side condition is not interview mail: %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(false);
  });

  test.each([
    'If you have time this week, we would like to schedule a phone interview.',
    'If it suits you, we would like to schedule an interview for Thursday.',
    'If you can make it, we would like to schedule your onsite for Friday.',
    'Would you be available for a 30-minute call next week?',
    'Are you available for a quick call this week?',
    'If you would like to move forward, we would love to schedule a 30 minute chat with the team.',
    'Please let me know a few times that work for you this week for a call.',
    'We are pleased to invite you to the next step of our hiring process.',
    "If your background is a fit, we'd love to set up a call with the team.",
    'You have been selected for the next round, and our coordinator will reach out with times.',
  ])('a direct offer is interview mail whatever condition precedes it: %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(true);
  });

  test.each([
    'Our recruiting team will reach out to schedule your onsite interview.',
    'Our recruiter will contact you to schedule your interview.',
    'Our coordinator will reach out shortly to schedule your phone screen.',
    'We will be in touch to schedule your final round.',
    'You will receive an email from GoodTime to schedule your interview.',
  ])('an unconditional promise to schedule your own interview is interview mail (F35-7): %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(true);
  });

  test.each([
    'The hiring manager would like to speak with you.',
    'Jane would love to chat with you about the role.',
    'Your interview with Acme has been scheduled for Monday.',
    'Here are the details for your upcoming interview.',
    'We would like to invite you to an onsite.',
    'We would like to move forward with your candidacy.',
    'Let me know when you are free for a quick chat.',
    'Can you do a call on Tuesday at 2pm?',
    'Looking forward to speaking with you on Tuesday.',
  ])('a sentence about a call or interview aimed at you is interview mail (F35-8): %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(true);
  });

  test.each([
    'The next step is a 30-minute call with our hiring manager.',
    'The hiring team would like to chat.',
    'We will reach out shortly to arrange a call with the CTO.',
    "Please find the Zoom link for tomorrow's interview below.",
    "Unfortunately, Jane is no longer able to make Tuesday's call. We'd like to move it to Thursday at 2pm.",
    "Unfortunately we can't proceed with the onsite on Friday since the office is closed. We'd like to find another date.",
  ])('a sentence about your own call or interview without a literal "you" is interview mail (F35-10): %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(true);
  });

  test.each([
    'We are currently reviewing your application and would like to schedule a phone screen.',
    'You will receive an invitation to your interview from Calendly.',
    'Our team will be in touch shortly to set up a time to talk.',
    'The team will reach out to book your technical interview.',
  ])('review or future-contact wording never hides an explicit invite (F35-11): %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(true);
  });

  test.each([
    'Thank you for applying. We will review your application and get back to you.',
  ])('plain review wording is not interview mail (F35-10): %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(false);
  });

  test.each([
    'Our interview process consists of a phone screen, a technical round and an onsite.',
    'The hiring process typically includes a recruiter call and two interviews.',
    'We will review your application and be in touch about next steps.',
    'In the meantime, you can learn more about our interview process on our careers page.',
    'If we would like to move forward with your application, we will contact you to set up an interview.',
    'Thank you for your interest; we will be in touch if we would like to schedule an interview.',
    'If the hiring manager would like to speak with you, we will reach out.',
    'If your skills match, we will call you.',
  ])('process descriptions and review boilerplate are not interview mail: %s', (sentence) => {
    expect(api.isInterview(sentence)).toBe(false);
  });
});

describe('reaudit restores archived interview mail', () => {
  test('previewReaudit logs an archived invite without changing it', () => {
    const t = thread([APPLICATIONS], [message('Next step with Acme', INVITE_BODY)], false);
    const { api, logs } = load([t]);
    api.previewReaudit();
    expect(t.calls).toEqual([]);
    expect(logs.some((l) => l.startsWith('would interview | ') && l.includes('Next step with Acme'))).toBe(true);
    expect(logs.some((l) => l.startsWith('previewReaudit complete.') && l.includes('"interview":1'))).toBe(true);
  });

  test('reauditApplications moves an archived invite to Interviews and back to the Inbox', () => {
    const invite = thread([APPLICATIONS], [message('Next step with Acme', INVITE_BODY)], false);
    const confirmation = thread([APPLICATIONS], [message('Your application', CONFIRMATION_BODY)], false);
    const { api, logs, scriptStore } = load([invite, confirmation]);
    api.reauditApplications();
    expect(invite.calls).toEqual(['add ' + INTERVIEWS, 'remove ' + APPLICATIONS, 'inbox']);
    expect([...invite.labels]).toEqual([INTERVIEWS]);
    expect(invite.inInbox).toBe(true);
    expect(confirmation.calls).toEqual([]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
    expect(logs.some((l) => l.startsWith('interview | ') && l.includes('Next step with Acme'))).toBe(true);
  });

  test('reauditApplications follows the thread rules: a recruiter note or scheduling boilerplate goes back to the Inbox', () => {
    const noted = thread([APPLICATIONS], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Re: Thank you for applying to Acme', RECRUITER_NOTE, 'Maya Chen <maya@acme.com>')], false);
    const boilerplate = thread([APPLICATIONS], [message('Thank you for applying to Initech', 'Thank you for applying to Initech. If your experience matches, we will reach out to schedule an interview.')], false);
    const rejected = thread([APPLICATIONS], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Update on your application', ACME_REJECTION)], false);
    const { api, scriptStore } = load([noted, boilerplate, rejected]);
    api.reauditApplications();
    expect(noted.calls).toEqual(['add ' + INTERVIEWS, 'remove ' + APPLICATIONS, 'inbox']);
    expect(boilerplate.calls).toEqual(['add ' + INTERVIEWS, 'remove ' + APPLICATIONS, 'inbox']);
    expect(rejected.calls).toEqual(['add ' + REJECTIONS, 'remove ' + APPLICATIONS]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(1);
  });

  test('preview follows the thread rules and changes nothing', () => {
    const rejected = thread([], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Update on your application', ACME_REJECTION)]);
    const noted = thread([], [
      message('Thank you for applying to Acme', ACME_CONFIRMATION),
      message('Re: Thank you for applying to Acme', RECRUITER_NOTE, 'Maya Chen <maya@acme.com>'),
      message('Update on your application', ACME_REJECTION),
    ]);
    const plain = thread([], [message('Your application', CONFIRMATION_BODY)]);
    const { api, logs, scriptStore } = load([rejected, noted, plain]);
    api.preview();
    expect([rejected, noted, plain].flatMap((t) => t.calls)).toEqual([]);
    expect(logs.filter((l) => l.startsWith('DENY '))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('INTERVIEW ') && l.includes('message besides the rejection'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('1 rejections, 1 interview emails, 1 other job emails'))).toBe(true);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
  });
});

describe('a plain confirmation is an allowlist of acknowledgement sentences (F35-12)', () => {
  const sandbox: Record<string, unknown> = { Logger: { log() {} }, PropertiesService: {}, Session: {}, GmailApp: {}, Gmail: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') + '\nthis.__a = { classifyThread_, unacknowledged_ };', sandbox);
  const { classifyThread_, unacknowledged_ } = sandbox.__a as {
    classifyThread_(messages: unknown[], rules: { excludedDomains: string[] }, me: string): { action: string };
    unacknowledged_(body: string, verification: boolean): string | null;
  };
  const wrapped = (sentence: string) =>
    'Hi Danlin,\n\nThank you for applying to the Backend Engineer role at Acme. ' + sentence + '\n\nBest,\nAcme Recruiting';
  const classify = (body: string, from = 'Acme Recruiting <no-reply@greenhouse.io>', subject = 'Your application to Acme') =>
    classifyThread_([{ getFrom: () => from, getSubject: () => subject, getPlainBody: () => body }], { excludedDomains: [] }, 'me@example.com').action;
  const ACTION_SENTENCES = [
    // probe12
    'Please complete your HireVue by Friday using the link below.',
    'As part of our process, please complete the Criteria Cognitive Aptitude Test (CCAT) within 48 hours.',
    'Please complete the Pymetrics games at the link below.',
    'Your Karat technical session link is below.',
    'Please record your answers on Spark Hire by Monday.',
    'Join the Microsoft Teams link below on Thursday at 3pm.',
    'We would love to get you in front of the team. Reply to this email with your free times.',
    // assessment vendors
    'Your Codility test is ready and must be finished within 3 days.',
    'You will receive a CodeSignal General Coding Framework link shortly.',
    'Please take the HackerRank challenge before Wednesday.',
    'Your TestGorilla evaluation is waiting for you.',
    'Criteria Corp will email you a link to the aptitude test.',
    'Harver will send you a short set of exercises to finish.',
    'The Wonderlic Select test takes about thirty minutes.',
    'Please take the SHL Verify numerical reasoning test.',
    'Your HireVue one-way recording is due Sunday night.',
    'Modern Hire will send your virtual job tryout.',
    // meeting tools and links
    'Here is the Google Meet link for Tuesday: https://meet.google.com/abc-defg-hij',
    'Webex details: https://acme.webex.com/join/xyz',
    'Use this link to join: https://zoom.us/j/123456789',
    'https://app.example.com/a/7f3c9',
    'Click here to begin.',
    'Our BlueJeans room opens at 10am PT.',
    // deadlines, dates and clock times
    'The deadline to submit is November 14.',
    'Kindly send it back by end of day Wednesday.',
    'We need this back by 5pm EST tomorrow.',
    'It is due on 11/14.',
    'You have until Sunday to finish.',
    // please / kindly / reply / confirm / complete / join / select / book / upload / sign
    'Please confirm receipt of this email.',
    'Kindly upload your portfolio to the portal.',
    'Reply YES to confirm your spot.',
    'Please select a time from the options below.',
    'Book a time with the team here.',
    'Please sign the attached NDA and return it.',
    'Upload your transcript at your earliest convenience.',
    'Please fill out the short form linked below.',
    'Complete the work sample at your convenience.',
    'Please join us for a virtual information session.',
    // moving forward, next stage, offer, congratulations
    "We'd like to move you forward in our process.",
    'You have advanced to the next stage.',
    'We are excited to extend you an offer.',
    'Congratulations, you made it to the final round!',
    'The team was impressed and wants to proceed with you.',
    // questions to the candidate
    'What is your expected salary range?',
    'Are you open to relocating to Austin?',
    'When could you start?',
    'Do you require visa sponsorship?',
    'Could you send over your updated resume?',
    // other requests, including requests hidden inside acknowledgement wording
    'Let us know your earliest start date.',
    'Feel free to grab any time on the team calendar.',
    'Please verify your identity using the attached instructions.',
    'Thank you for applying to Acme and please complete your work sample by Friday.',
    'We will review your application and get back to you once you finish the coding exercise.',
    'We have received your application and need your references.',
    'You can track the status of your application in the candidate portal, where a task is waiting.',
  ];

  test.each(ACTION_SENTENCES)('a confirmation that also asks you to act is kept: %s', (sentence) => {
    expect(classify(wrapped(sentence))).toBe('interview');
  });

  test.each(ACTION_SENTENCES)('the sentence allowlist alone rejects it, without the scheduling-word veto: %s', (sentence) => {
    expect(unacknowledged_(wrapped(sentence), false)).not.toBeNull();
  });

  test.each([
    ['an action after the sign-off', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nBest,\nAcme Recruiting\n\nP.S. Upload your portfolio by Friday.'],
    ['an action as a title-case line', 'Thank you for applying to Acme.\n\nAction Required\n\nAcme Recruiting'],
    ['an action in the signature', 'Thank you for applying to Acme.\n\nBest,\nPlease Reply By Friday'],
    ['an action inside a footer sentence', 'Thank you for applying to Acme.\n\nPlease do not reply to this email; instead, upload your portfolio by Friday.'],
    ['an action in the greeting line', 'Hi Danlin, please upload your portfolio.\n\nThank you for applying to Acme.'],
    ['a bare link line', 'Thank you for applying to Acme.\nhttps://acme.example.com/start\n\nAcme Recruiting'],
    ['a request in a footer sentence', 'Thank you for applying to Acme.\n\nThis email was sent by Greenhouse; respond with your portfolio.'],
    ['a title-case reminder at the end', 'Thank you for applying to Acme.\n\nAcme Recruiting\nFinal Step Reminder'],
  ])('%s is kept', (_name, body) => {
    expect(classify(body)).toBe('interview');
    expect(unacknowledged_(body, false)).not.toBeNull();
  });

  const ATS_CONFIRMATIONS: [string, string, string][] = [
    ['Greenhouse', 'Acme Recruiting <no-reply@greenhouse.io>',
      'Hi Danlin,\n\nThanks for applying to Acme. Your application has been received and we will review it right away.\n\nIf your application seems like a good fit for the position we will contact you soon.\n\nRegards,\nAcme\n\n** Please note: Do not reply to this email. This email is sent from an unattended mailbox. Replies will not be read.'],
    ['Lever', 'Acme <no-reply@hire.lever.co>',
      'Hi Danlin,\n\nThank you for your interest in Acme! We wanted to let you know we received your application for Senior Backend Engineer, and we are delighted that you would consider joining our team.\n\nOur team will review your application and will be in touch if your qualifications match our needs for the role.\n\nBest,\nThe Acme Team\n\nSent with Lever'],
    ['Workday', 'Acme Careers <acme@myworkday.com>',
      'Dear Danlin Shen,\n\nThank you for your interest in a career with Acme Corporation. We have received your application for the Backend Engineer position.\n\nOur recruiting team will carefully review your qualifications. If your background matches the requirements of the position, a member of our recruiting team will contact you.\n\nYou can track the status of your application at any time by logging in to your candidate home.\n\nSincerely,\nAcme Talent Acquisition\n\nAcme Corporation is an Equal Opportunity Employer. All qualified applicants will receive consideration for employment without regard to race, color, religion, sex, national origin, disability or protected veteran status.'],
    ['Ashby', 'Acme Recruiting <no-reply@ashbyhq.com>',
      "Hi Danlin,\n\nThanks for applying to the Backend Engineer role at Acme! We're excited that you're interested in joining our team.\n\nOur hiring team is reviewing your application and will get back to you in the coming weeks.\n\nBest,\nAcme Recruiting\n\nPowered by Ashby"],
    ['iCIMS', 'Acme Talent <acme@talent.icims.com>',
      'Dear Danlin,\n\nThank you for submitting your application for the Backend Engineer position at Acme. This email confirms that we have received your application.\n\nWe will review your background and qualifications carefully and contact you if there is a match.\n\nAgain, we appreciate your interest in Acme and wish you luck in your job search.\n\nKind regards,\nAcme Talent Acquisition Team\n\nThis message was sent by iCIMS on behalf of Acme. Please do not reply to this email.'],
    ['SmartRecruiters', 'Acme Hiring Team <noreply@smartrecruiters.com>',
      'Hi Danlin,\n\nThank you for applying to the Backend Engineer position at Acme. We have received your application and will review it shortly.\n\nIf your profile matches our requirements, we will get in touch with you.\n\nBest regards,\nAcme Hiring Team\n\nPrivacy Policy | Unsubscribe\nPowered by SmartRecruiters'],
  ];

  test.each(ATS_CONFIRMATIONS)('a %s acknowledgement with greeting, signature and footer is archived', (_ats, from, body) => {
    expect(classify(body, from, 'Thank you for applying to Acme')).toBe('job');
    expect(unacknowledged_(body, false)).toBeNull();
  });

  test('a plain review-and-get-back confirmation is still archived', () => {
    expect(classify(wrapped('We will review your application and get back to you.'))).toBe('job');
  });
});

describe('a footer is set aside only when the whole sentence is a standard footer (F35-13)', () => {
  const sandbox: Record<string, unknown> = { Logger: { log() {} }, PropertiesService: {}, Session: {}, GmailApp: {}, Gmail: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') + '\nthis.__a = { classifyThread_, unacknowledged_, footer_ };', sandbox);
  const { classifyThread_, unacknowledged_, footer_ } = sandbox.__a as {
    classifyThread_(messages: unknown[], rules: { excludedDomains: string[] }, me: string): { action: string };
    unacknowledged_(body: string, verification: boolean): string | null;
    footer_(sentence: string): boolean;
  };
  const wrapped = (sentence: string) =>
    'Hi Danlin,\n\nThank you for applying to the Backend Engineer role at Acme. ' + sentence + '\n\nBest,\nAcme Recruiting';
  const classify = (body: string, from = 'Acme Recruiting <no-reply@greenhouse.io>', subject = 'Your application to Acme') =>
    classifyThread_([{ getFrom: () => from, getSubject: () => subject, getPlainBody: () => body }], { excludedDomains: [] }, 'me@example.com').action;

  const FOOTER_WORDED_ACTIONS = [
    // probe13
    'This message was sent by the CTO, who loved your profile and wants to connect.',
    'This automated email is a reminder that your work sample is still outstanding.',
    'This is an automated notification that your coding project is waiting in the portal.',
    'The engineering team has requested your portfolio on behalf of the CTO.',
    'Note that the case study we sent is confidential.',
    'Your portfolio review with Jane is set for 10am; details are confidential.',
    // reviewer cases
    'This is an automated message with your test link: https://x.io/t/1',
    'This message was sent on behalf of the engineering lead, who wants your portfolio.',
    'Confidential: the take home project brief is attached.',
    'Sent via Greenhouse with your pair programming exercise.',
    'Your coding project was sent via a separate email.',
    'The attached case study is confidential and is due to the team in 3 days.',
    'Your work sample was sent by our team; it is confidential.',
    'This message is confidential: we loved your profile and want to connect.',
    'The case study is confidential.',
    // footer wording wrapped around an action
    'Please do not reply to this email; instead, send your portfolio to jane@acme.com.',
    'Do not reply here, but do complete the coding project in the portal.',
    'This email was sent from an unmonitored mailbox, so please book a time with Jane using the link below.',
    'Replies to this email will not be read, so please submit your work sample through the portal.',
    'This is an automated message to remind you that your case study is due Friday.',
    'This automated notification is to let you know your portfolio review has been set.',
    'Sent by Greenhouse on behalf of Jane, who would like to connect with you.',
    'Powered by Lever: your take-home brief is attached.',
    'This message was sent via Workday because your work sample is overdue.',
    'Sent with Ashby on behalf of the CTO, who wants to see your portfolio.',
    "On behalf of the hiring manager, we'd love to see a code sample.",
    'Confidential: please send the signed NDA back today.',
    'This email and any attachments are confidential; the case study inside is due in a week.',
    'The enclosed exercise is confidential and intended solely for you to complete.',
    'Unsubscribe from reminders by finishing your work sample.',
    'To unsubscribe, simply reply with your portfolio link.',
    'Our privacy notice explains why we need your references by Monday.',
    'Acme is an equal opportunity employer and would love to see your portfolio.',
    'All qualified applicants will receive consideration for employment once their work sample is in.',
    '© 2026 Acme. Your case study is attached.',
    'All rights reserved; your take-home project is attached.',
    'If you are not the intended recipient of this case study, please forward it to Jane.',
    'This mailbox is not monitored, so upload your portfolio in the portal instead.',
    'Note: this message was sent by our CTO, who loved your portfolio.',
    'The engineering lead asked us to send this on behalf of the team: we want your portfolio.',
    'This message has been sent by Jane Doe to request your writing sample.',
    'This is an automated email from Greenhouse with your work sample instructions.',
    'Sent via iCIMS with your portfolio request.',
    'This email is sent from an unattended mailbox; the case study is in the portal.',
    'Privacy Policy | Unsubscribe | Your Case Study',
  ];

  test.each(FOOTER_WORDED_ACTIONS)('a confirmation with an action in footer wording is kept: %s', (sentence) => {
    expect(classify(wrapped(sentence))).toBe('interview');
    expect(unacknowledged_(wrapped(sentence), false)).not.toBeNull();
  });

  test.each([
    ['an unsigned title line above an unsigned signature', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nCoding Project Instructions\n\nAcme Recruiting'],
    ['an automated-message line after the signature', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\nAutomated message: the take-home project is in your portal.'],
    ['an automated-email line after the signature', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\nThis automated email has your portfolio request.'],
    ['a confidential line after the signature', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\nConfidential: your take-home project awaits.'],
    ['an address line carrying instructions', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\n123 Main Street, Suite 400 coding project instructions'],
    ['a title line above the signature', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nYour Case Study\nAcme Recruiting'],
    ['a linked title above the signature', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nTechnical Project Instructions <https://acme.io/p>\nAcme Recruiting'],
    ['a title-case note above a name', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nWe Want To Connect\nJane Doe'],
    ['a signature block that is not the end of the body', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\nYour Case Study'],
    ['a title line after a signed block across a blank line', 'Hi Danlin,\n\nThank you for applying to Acme.\n\nBest,\nAcme Recruiting\n\nCoding Project Instructions'],
  ])('%s is kept', (_name, body) => {
    expect(classify(body)).toBe('interview');
    expect(unacknowledged_(body, false)).not.toBeNull();
  });

  const STANDARD_FOOTERS: [string, string, string][] = [
    ['Greenhouse', 'Acme Recruiting <no-reply@greenhouse.io>',
      '\n\nPlease do not reply to this email, as this mailbox is not monitored.\n\nPowered by Greenhouse'],
    ['Lever', 'Acme <no-reply@hire.lever.co>', '\n\nSent with Lever\nPrivacy Policy | Unsubscribe'],
    ['Workday', 'Acme Careers <acme@myworkday.com>',
      '\n\nThis is an automated message. Please do not reply to this email.\n\n© 2026 Acme Corporation. All rights reserved.\nAcme Corporation, 100 Market Street, Suite 300, San Francisco, CA 94105'],
    ['iCIMS', 'Acme Talent <acme@talent.icims.com>',
      '\n\nThis message was sent by iCIMS on behalf of Acme. Please do not reply to this email.\n\nThis email and any attachments are confidential and intended solely for the addressee. If you have received this email in error, please notify the sender and delete it.'],
    ['SmartRecruiters', 'Acme Hiring Team <noreply@smartrecruiters.com>',
      '\n\nPrivacy Policy | Unsubscribe\nPowered by SmartRecruiters\n\nTo unsubscribe from these emails, click here.'],
    ['EEO', 'Acme Recruiting <no-reply@greenhouse.io>',
      '\n\nAcme is an Equal Opportunity Employer. We do not discriminate on the basis of race, religion, color, national origin, gender, sexual orientation, age, marital status, veteran status, or disability status.\n\nAll qualified applicants will receive consideration for employment without regard to race, color, religion, sex, sexual orientation, gender identity, national origin, disability, protected veteran status, or any other characteristic protected by law.'],
  ];

  test.each(STANDARD_FOOTERS)('a plain confirmation with the standard %s footer is archived', (_ats, from, footers) => {
    const body = wrapped('We will review your application and get back to you.') + footers;
    expect(classify(body, from, 'Thank you for applying to Acme')).toBe('job');
    expect(unacknowledged_(body, false)).toBeNull();
  });

  test('the probe13 footers on a plain confirmation are archived', () => {
    const footers =
      '\n\n** Please note: Do not reply to this email. This email is sent from an unattended mailbox. Replies will not be read.\n\nThis message was sent by iCIMS on behalf of Acme. Please do not reply to this email.\n\nPrivacy Policy | Unsubscribe\nPowered by SmartRecruiters\n\nAcme Corporation is an Equal Opportunity Employer. All qualified applicants will receive consideration for employment without regard to race, color, religion, sex, national origin, disability or protected veteran status.';
    expect(classify(wrapped('We will review your application and get back to you.') + footers)).toBe('job');
  });

  test.each([
    'We will be in touch with an update.',
    'Thanks for your interest!',
    'We have received your application for the role.',
    'Thank you for applying to the Staff Engineer team lead opportunity at Acme.',
  ])('a plain acknowledgement stays archivable: %s', (sentence) => {
    expect(classify(wrapped(sentence))).toBe('job');
  });

  test('an unsigned signature as the one unbroken block ending the body is set aside', () => {
    expect(classify('Hi Danlin,\n\nThank you for applying to Acme.\n\nAcme Recruiting\nTalent Team')).toBe('job');
  });

  test.each([
    'Do not reply to this email.',
    'This message was sent by Greenhouse on behalf of Acme Corporation.',
    'Sent via Workday',
    'Powered by SmartRecruiters',
    'Manage your email preferences | Unsubscribe',
    'Copyright © 2026 Acme, Inc.',
    '500 Howard Street, San Francisco, CA 94105',
  ])('footer_ accepts the standard footer: %s', (sentence) => {
    expect(footer_(sentence)).toBe(true);
  });
});
