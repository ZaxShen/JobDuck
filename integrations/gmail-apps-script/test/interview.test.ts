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
        threads.filter((t) => query.includes(APPLICATIONS) && t.labels.has(APPLICATIONS)).slice(start, start + max),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') +
      '\nthis.__api = { processThread_, reauditApplications, previewReaudit, isInterview };',
    sandbox,
  );
  const api = sandbox.__api as {
    processThread_(t: FakeThread): string;
    reauditApplications(): void;
    previewReaudit(): void;
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

  test('a rejection still wins, and is archived unless the thread carries Interviews', () => {
    const plain = thread([], [message('Your interview with Hooli', REJECTION_BODY)]);
    const interviewed = thread([INTERVIEWS], [message('Next step with Hooli', INVITE_BODY), message('Your interview with Hooli', REJECTION_BODY)]);
    const { api, scriptStore } = load([plain, interviewed]);
    expect(api.processThread_(plain)).toBe('deny');
    expect(plain.calls).toEqual(['add ' + REJECTIONS, 'archive']);
    expect(api.processThread_(interviewed)).toBe('deny');
    expect(interviewed.calls).toEqual(['add ' + REJECTIONS]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(2);
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

  test('a plain update after the latest rejection does not overrule it', () => {
    const t = thread([], [message('Your interview with Hooli', REJECTION_BODY), message('Your application', CONFIRMATION_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('deny');
  });

  test('a thread labeled Rejections and Interviews is left in the Inbox', () => {
    const t = thread([REJECTIONS, INTERVIEWS], [message('Your interview with Hooli', REJECTION_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('skipped');
    expect(t.calls).toEqual([]);
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
});
