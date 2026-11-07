import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const APPLICATIONS = 'Job Duck/Applications';
const REJECTIONS = 'Job Duck/Rejections';
const LEGACY_INTERVIEWS = 'Job Duck/Interviews';

const INVITE_BODY =
  "Hi Alex,\n\nExcited to kick off the interview process with you - before we schedule anything, I'd love for you to fill out a quick questionnaire.\n\nThe Yoyodyne Hiring Team";
const CONFIRMATION_BODY =
  'Hi Alex,\n\nThank you for applying to the Platform Engineer position at Globex. We have received your application.\n\nGlobex Careers';
const REJECTION_BODY =
  'Hi Alex,\n\nThank you for taking the time to interview with us. Unfortunately, we have decided not to move forward.\n\nHooli Recruiting';
const ACME_CONFIRMATION =
  'Hi Alex,\n\nThank you for applying to the Backend Engineer role at Acme. We have received your application and our team will review it.\n\nAcme Recruiting';
const ACME_REJECTION =
  'Hi Alex,\n\nThank you for applying to the Backend Engineer role at Acme. Unfortunately, we have decided not to move forward with your application.\n\nAcme Recruiting';
const RECRUITER_NOTE =
  "Hi Alex,\n\nI'm the recruiter for this role and wanted to say thanks for applying. I have passed your profile to the team.\n\nJordan";

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

function load(
  threads: FakeThread[],
  scriptProps: Record<string, string> = {},
  existingLabels: string[] = [APPLICATIONS, REJECTIONS],
  userProps: Record<string, string> = {},
) {
  const logs: string[] = [];
  const created: string[] = [];
  const existing = new Set(existingLabels);
  const scriptStore = store(scriptProps);
  const userStore = store(userProps);
  const sandbox: Record<string, unknown> = {
    Logger: { log: (m: unknown) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => scriptStore, getUserProperties: () => userStore },
    Session: { getActiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    GmailApp: {
      getUserLabelByName: (name: string) => (existing.has(name) ? label(name) : null),
      createLabel: (name: string) => { created.push(name); existing.add(name); return label(name); },
      search: (query: string, start: number, max: number) =>
        threads
          .filter((t) =>
            query.includes(APPLICATIONS)
              ? t.labels.has(APPLICATIONS)
              : query.includes(REJECTIONS)
                ? t.labels.has(REJECTIONS)
                : query.includes('in:inbox') && t.inInbox,
          )
          .slice(start, start + max),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') +
      '\nthis.__api = { processThread_, reauditApplications, previewReaudit, reauditRejections, previewReauditRejections, resetReaudit, preview, isInterview, unexplainedRejection_ };',
    sandbox,
  );
  const api = sandbox.__api as {
    processThread_(t: FakeThread): string;
    reauditApplications(): void;
    previewReaudit(): void;
    reauditRejections(): void;
    previewReauditRejections(): void;
    resetReaudit(): void;
    preview(): void;
    isInterview(body: string): boolean;
    unexplainedRejection_(body: string): string | null;
  };
  return { api, logs, scriptStore, userStore, created };
}

describe('processThread_ leaves kept mail untouched in the Inbox', () => {
  test('interview mail gets no label and is not archived', () => {
    const t = thread([], [message('Yoyodyne | A few things to know before your interview...', INVITE_BODY, 'The Yoyodyne Hiring Team <no-reply@ashbyhq.com>')]);
    const { api, created } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(t.labels.size).toBe(0);
    expect(t.inInbox).toBe(true);
    expect(created).toEqual([]);
  });

  test('an Applications thread whose latest job message is an invite loses Applications and stays in the Inbox', () => {
    const t = thread([APPLICATIONS], [message('Thanks for applying', CONFIRMATION_BODY), message('Next step with Acme', INVITE_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual(['remove ' + APPLICATIONS]);
    expect(t.labels.size).toBe(0);
    expect(t.inInbox).toBe(true);
  });

  test('KEEP_ACTION_MAIL_IN_INBOX set or unset never changes how kept mail is handled', () => {
    const t = thread([], [message('Next step with Acme', INVITE_BODY)]);
    const { api } = load([t], { KEEP_ACTION_MAIL_IN_INBOX: 'true' });
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual([]);
  });

  test('an interview subject over a confirmation body is archived as application mail', () => {
    const t = thread([], [message('Interview Scheduling Team: application received', CONFIRMATION_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('job');
    expect(t.calls).toEqual(['add ' + APPLICATIONS, 'archive']);
  });

  test('a thread still labeled with the v5.2 Interviews label is left alone when a plain update arrives', () => {
    const t = thread([LEGACY_INTERVIEWS], [message('Next step with Acme', INVITE_BODY), message('Your application', CONFIRMATION_BODY)]);
    const { api } = load([t], {}, [APPLICATIONS, REJECTIONS, LEGACY_INTERVIEWS]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual([]);
  });

  test('a lone rejection is archived; a rejection after an invite keeps the thread in the Inbox', () => {
    const plain = thread([], [message('Your interview with Hooli', REJECTION_BODY)]);
    const interviewed = thread([], [message('Next step with Hooli', INVITE_BODY), message('Your interview with Hooli', REJECTION_BODY)]);
    const { api, scriptStore } = load([plain, interviewed]);
    expect(api.processThread_(plain)).toBe('deny');
    expect(plain.calls).toEqual(['add ' + REJECTIONS, 'archive']);
    expect(api.processThread_(interviewed)).toBe('keep');
    expect(interviewed.calls).toEqual([]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(1);
  });

  test('an invite after the latest rejection keeps the thread, not deny', () => {
    const t = thread([APPLICATIONS], [message('Your interview with Hooli', REJECTION_BODY), message('Next step with Hooli', INVITE_BODY)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual(['remove ' + APPLICATIONS]);
    expect(t.inInbox).toBe(true);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
  });

  test('a rejection that offers a call about another role is kept, not deny', () => {
    const body =
      "Hi Alex,\n\nWe have decided not to move forward with your application for the Senior role, but we'd like to schedule a call about our Staff role.\n\nHooli Recruiting";
    const t = thread([], [message('Your application to Hooli', body)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
  });

  test('a rejection that only thanks you for interviewing stays deny; one that would love to connect stays untouched', () => {
    const keepInTouch =
      "Hi Alex,\n\nUnfortunately, we have decided not to move forward. We'd love to connect with you about future opportunities.\n\nHooli Recruiting";
    const plain = thread([], [message('Your interview with Hooli', REJECTION_BODY)]);
    const courtesy = thread([], [message('Your interview with Hooli', keepInTouch)]);
    const { api } = load([plain, courtesy]);
    expect(api.processThread_(plain)).toBe('deny');
    expect(plain.calls).toEqual(['add ' + REJECTIONS, 'archive']);
    expect(api.processThread_(courtesy)).toBe('keep');
    expect(courtesy.calls).toEqual([]);
  });

  test('a rejection that is not the latest job message keeps the thread in the Inbox', () => {
    const t = thread([], [message('Your interview with Hooli', REJECTION_BODY), message('Your application', CONFIRMATION_BODY)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
  });

  test('a thread labeled Rejections whose rejection no longer stands loses the label and goes back to the Inbox', () => {
    const t = thread([REJECTIONS], [message('Your interview with Hooli', REJECTION_BODY), message('Next step with Hooli', INVITE_BODY)], false);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual(['remove ' + REJECTIONS, 'inbox']);
    expect(t.labels.size).toBe(0);
  });

  test('no code path creates an Interviews or Review label', () => {
    const threads = [
      thread([], [message('Next step with Acme', INVITE_BODY)]),
      thread([], [message('Your application', CONFIRMATION_BODY)]),
      thread([], [message('Your interview with Hooli', REJECTION_BODY)]),
      thread([APPLICATIONS], [message('Next step with Acme', INVITE_BODY)], false),
    ];
    const { api, created } = load(threads, {}, []);
    threads.slice(0, 3).forEach((t) => api.processThread_(t));
    api.preview();
    api.previewReaudit();
    api.reauditApplications();
    expect(created.filter((name) => /Interviews|Review/.test(name))).toEqual([]);
    expect([...new Set(created)].sort()).toEqual([APPLICATIONS, REJECTIONS]);
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
      message('Re: Thank you for applying to Acme', RECRUITER_NOTE, 'Jordan Rivera <jordan@acme.com>'),
      message('Update on your application', ACME_REJECTION),
    ]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual(['remove ' + APPLICATIONS]);
    expect(t.inInbox).toBe(true);
    expect(outcomes(scriptStore.data)).toHaveLength(0);
  });

  test('a thread already labeled Rejections that gets an invite loses the label and goes back to the Inbox unlabeled (F35-9)', () => {
    const rejection = message('Update on your application', ACME_REJECTION);
    const invite = message(
      'Re: Update on your application',
      'Hi Alex,\n\nThank you for applying to the Backend Engineer role at Acme. Our Staff Engineer role just opened and we would like to schedule a phone screen with you for it next week.\n\nAcme Recruiting',
    );
    const t = thread([REJECTIONS], [rejection, invite]);
    const { api, scriptStore } = load([t], { ['outcome:' + rejection.getHeader()]: '{}' });
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual(['remove ' + REJECTIONS, 'inbox']);
    expect(t.labels.size).toBe(0);
    expect(outcomes(scriptStore.data)).toHaveLength(0);
  });

  test('a thread labeled Rejections whose rejection still stands is re-archived without being re-queued', () => {
    const t = thread([REJECTIONS], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Update on your application', ACME_REJECTION)]);
    const { api, scriptStore } = load([t]);
    expect(api.processThread_(t)).toBe('skipped');
    expect(t.calls).toEqual(['archive']);
    expect(outcomes(scriptStore.data)).toHaveLength(0);
  });

  test('a confirmation whose only scheduling words are an employer-side conditional is archived as application mail', () => {
    const body =
      'Hi Alex,\n\nThank you for applying to the Data Engineer role at Initech. Our team will review your application and next steps.\n\nIf your experience matches, we will reach out to schedule an interview.\n\nInitech Recruiting';
    const t = thread([], [message('Thank you for applying to Initech', body)]);
    const { api } = load([t]);
    expect(api.isInterview(body)).toBe(false);
    expect(api.processThread_(t)).toBe('job');
    expect(t.calls).toEqual(['add ' + APPLICATIONS, 'archive']);
  });

  test('a personal note after a confirmation stays in the Inbox even without scheduling words', () => {
    const t = thread([], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Re: Thank you for applying to Acme', RECRUITER_NOTE, 'Jordan Rivera <jordan@acme.com>')]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.inInbox).toBe(true);
  });

  test('two plain confirmations are archived as application mail', () => {
    const t = thread([], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Your application', CONFIRMATION_BODY)]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('job');
    expect(t.calls).toEqual(['add ' + APPLICATIONS, 'archive']);
  });

  test('verification-code mail asks for an action, so it stays untouched in the Inbox with or without KEEP_ACTION_MAIL_IN_INBOX', () => {
    const body = 'Your verification code is 482913. Enter it to continue your application for the Backend Engineer role.';
    const plain = thread([], [message('Your verification code', body)]);
    const flagged = thread([], [message('Your verification code', body)]);
    expect(load([plain]).api.processThread_(plain)).toBe('keep');
    expect(plain.calls).toEqual([]);
    expect(load([flagged], { KEEP_ACTION_MAIL_IN_INBOX: 'true' }).api.processThread_(flagged)).toBe('keep');
    expect(flagged.calls).toEqual([]);
  });
});

describe('v5.4: archive only what is certainly a plain confirmation', () => {
  const untouched = (subject: string, body: string, from?: string) => {
    const t = thread([], [message(subject, body, from)]);
    const { api } = load([t]);
    return { action: api.processThread_(t), t };
  };

  test.each([
    ['recruiter will reach out to schedule', 'Thank you for applying', 'Hi Jordan,\n\nThank you for applying to the Backend Engineer role at Acme. Our recruiter will reach out to schedule your interview this week.\n\nAcme Recruiting'],
    ['online assessment', 'Your Acme assessment', 'Hi Jordan,\n\nThank you for applying to the Backend Engineer role at Acme. As a next step, please complete the HackerRank coding assessment within 7 days: https://www.hackerrank.com/test/example\n\nAcme Recruiting'],
    ['verify your email', 'Verify your email', 'Hi Jordan,\n\nThanks for applying to the Backend Engineer role at Acme. Verify your email to finish your application: https://careers.example.com/verify\n\nAcme Recruiting'],
    ['security code', 'Your security code', 'Hi Jordan,\n\nYour security code for your application to the Backend Engineer role at Acme is 551204. It expires in 10 minutes.\n\nAcme Recruiting'],
    ['application limit reached', 'Application limit reached', 'Hi Jordan,\n\nThank you for your interest in Acme. Application limit reached: you have applied to the maximum number of roles in 30 days.\n\nAcme Recruiting'],
    ['application started, not submitted', 'You have started your application', "Hi Jordan,\n\nYou've started your application for the Backend Engineer role at Acme. Return any time to submit it.\n\nAcme Recruiting"],
    ['phone screen confirmed with a date', 'Phone screen confirmed', 'Hi Jordan,\n\nThank you for applying to the Backend Engineer role at Acme. Your phone screen is confirmed for Tuesday, March 3 at 10:00 AM PT.\n\nAcme Recruiting'],
    ['recruiter would love to chat', 'Your application to Acme', "Hi Jordan,\n\nThanks for applying to the Backend Engineer role at Acme. I'd love to chat about your background.\n\nSam Lee\nRecruiter, Acme"],
  ])('%s stays untouched in the Inbox', (_name, subject, body) => {
    const { action, t } = untouched(subject, body);
    expect(action).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(t.inInbox).toBe(true);
  });

  test('an unknown non-boilerplate sentence in an otherwise plain confirmation keeps the thread untouched', () => {
    const plain = 'Hi Jordan,\n\nThank you for applying to the Backend Engineer role at Acme. We have received your application.\n\nAcme Recruiting';
    const odd = 'Hi Jordan,\n\nThank you for applying to the Backend Engineer role at Acme. We have received your application. The hiring manager mentioned your open source work.\n\nAcme Recruiting';
    expect(untouched('Thank you for applying', plain).action).toBe('job');
    const { action, t } = untouched('Thank you for applying', odd);
    expect(action).toBe('keep');
    expect(t.calls).toEqual([]);
  });

  test.each([
    ['Ashby', 'Recruiting <no-reply@ashbyhq.com>', "Hi Jordan,\n\nThank you for applying to the Backend Engineer role at Acme. We've received your application and our team will review it. If your experience is a match for the role, we will reach out about next steps.\n\nBest,\nAcme Recruiting\n\nAcme is an equal opportunity employer. We do not discriminate on the basis of race, religion, color, national origin, gender, sexual orientation, age, marital status, veteran status, or disability status.\n\nPowered by Ashby"],
    ['Greenhouse', 'Acme <no-reply@us.greenhouse-mail.io>', 'Hi Jordan,\n\nThanks for applying to Acme. Your application has been received and we will review it right away. If your application seems like a good fit for the position, we will contact you soon.\n\nRegards,\nAcme Recruiting\n\nAcme will never ask for payment or banking details during the hiring process.\n\n** Please note: Do not reply to this email. This email is sent from an unattended mailbox. Replies will not be read.'],
    ['Lever', 'Acme <no-reply@hire.lever.co>', 'Hi Jordan,\n\nThank you for your interest in Acme! We wanted to let you know we received your application for the Backend Engineer role, and we are delighted that you would consider joining our team.\n\nOur team will review your application and will be in touch if your qualifications match our needs for the role.\n\nThe Acme Team\n\nFor details on how we handle your personal information, please review our https://www.example.com/privacy'],
    ['Workday', 'Acme Careers <acme@myworkday.com>', 'Dear Jordan,\n\nThank you for applying for the Backend Engineer position (R-123456) at Acme. We have received your application and it will be reviewed by our team.\n\nIf your qualifications match the position\'s requirements, a member of our recruiting team will contact you.\n\nSincerely,\nAcme Talent Acquisition\n\nThis is an automated email response. Please do not reply to this email.'],
  ])('a %s-style confirmation with boilerplate footers is archived as application mail', (_ats, from, body) => {
    const { action, t } = untouched('Thank you for applying to Acme', body, from);
    expect(action).toBe('job');
    expect(t.calls).toEqual(['add ' + APPLICATIONS, 'archive']);
  });

  const DECLINES = [
    "Unfortunately we don't see a direct fit for this role.",
    'Unfortunately, we are not able to move forward with your application.',
    'We will not be hiring for this position.',
    'Unfortunately, we have decided not to move forward with your application.',
  ];
  const CONTACT_INVITES = [
    'Are you free Tuesday to chat about a different position?',
    'Would you be open to a quick call next week about our Staff role?',
    "We'd love to chat about our Platform team.",
    'Please book a time here: https://calendly.com/acme-recruiting/intro',
    'Reply with a few times that work for a call on Thursday.',
  ];
  const rejectionWith = (decline: string, invite: string) =>
    'Hi Dan,\n\nThank you for your interest in the Backend Engineer role at Acme. ' + decline + ' ' + invite + '\n\nAcme Recruiting';

  test.each(DECLINES.flatMap((d) => CONTACT_INVITES.map((q) => [d, q])))(
    'a rejection that invites further contact stays untouched (F48-1): %s %s',
    (decline, invite) => {
      const { action, t } = untouched('Your application to Acme', rejectionWith(decline, invite), 'Acme Recruiting <no-reply@greenhouse.io>');
      expect(action).not.toBe('deny');
      expect(t.calls).toEqual([]);
      expect(t.inInbox).toBe(true);
    },
  );

  const MAYBE_CONTACT = [
    'Could we set up a call about our Staff role?',
    'Can we talk?',
    'Would a quick call about another opening work?',
    'Our hiring manager would like to set up a call about a different role.',
    'Interested in a different role? Reply to this email.',
    'Open to other roles? Our Platform team is hiring.',
    'Happy to set up a call about other openings.',
    'We have another opening on our Platform team that may be a better fit, and the hiring manager would like to speak with you.',
    'We think you could be a great fit for our Staff role instead.',
    'Feel free to grab time on my calendar: https://acme.com/recruiter',
    "We'd like to consider you for our Staff role instead.",
    'Would love to chat about another role.',
    "We'd like to invite you to interview for a different position.",
    "I've passed your resume to our Platform team, who will reach out.",
    'A recruiter will reach out about other roles.',
    'Please email us if you would like us to reach out about additional opportunities.',
  ];

  test.each(DECLINES.flatMap((d) => MAYBE_CONTACT.map((q) => [d, q])))(
    'a rejection that might invite further contact stays untouched (F49-1): %s %s',
    (decline, invite) => {
      const { action, t } = untouched('Your application to Acme', rejectionWith(decline, invite), 'Acme Recruiting <no-reply@greenhouse.io>');
      expect(action).not.toBe('deny');
      expect(t.calls).toEqual([]);
      expect(t.inInbox).toBe(true);
    },
  );

  const D = 'Unfortunately, we have decided not to move forward with your application.';
  const signedRejectionWith = (sentence: string) =>
    'Hi Dan,\n\nThank you for your interest in the Backend Engineer role at Acme. ' + D + ' ' + sentence + '\n\nBest,\nAcme Recruiting';
  test.each([
    ['a signature line offering a call', 'Hi Dan,\n\nThank you for your interest in the Backend Engineer role at Acme. ' + D + '\n\nBest,\nJane Doe\nRecruiter at Acme\nBook a call with me anytime\n'],
    ['a question in the greeting', 'Hi Dan, are you free Tuesday?\n\nThank you for your interest in the Backend Engineer role at Acme. ' + D + '\n\nBest,\nAcme Recruiting'],
  ])('a rejection with %s stays untouched (F49-1)', (_name, body) => {
    const { action, t } = untouched('Your application to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>');
    expect(action).not.toBe('deny');
    expect(t.calls).toEqual([]);
  });

  test.each([
    ['F49-2', 'We would like to consider you for another role on our team that better matches your application.'],
    ['F49-2', 'We would love to consider you for the Staff Engineer role instead, should you be interested.'],
    ['F49-3', 'Thank you for your time, and our VP would like to call you about a Staff opening.'],
    ['F49-3', 'Thanks for speaking with us; we would love to chat again next week about our Platform team.'],
    ['F49-4', 'If you are interested in our Staff role, just reply to this email.'],
    ['F49-4', 'Our recruiter will reach out if the Staff role interests you, so watch your inbox.'],
    ['F49-4', 'Your profile has been shared with our Platform team; expect to hear from them soon.'],
    ['F49-4', 'The hiring manager asked me to put you in touch with the Platform team.'],
    ['F49-4', 'Expect an email from the Platform team coordinator to schedule next steps.'],
  ])('a rejection that offers another role, a call or a handoff stays untouched (%s): %s', (_id, invite) => {
    const { action, t } = untouched('Your application to Acme', signedRejectionWith(invite), 'Acme Recruiting <no-reply@greenhouse.io>');
    expect(action).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(t.inInbox).toBe(true);
  });

  test.each([
    'We wish you the best in your search.',
    'However, we will be in touch should your qualifications be a good fit for other opportunities.',
  ])('a signed courtesy rejection is still denied (F49-2, F49-3, F49-4): %s', (courtesy) => {
    const { action } = untouched('Your application to Acme', signedRejectionWith(courtesy), 'Acme Recruiting <no-reply@greenhouse.io>');
    expect(action).toBe('deny');
  });

  test.each([
    'We encourage you to apply for future roles.',
    'We wish you the best in your search.',
    'We encourage you to visit our careers page for other opportunities that match your interests.',
    'Please continue to check our career site for new openings and apply if a role catches your eye.',
    'However, we will be in touch should your qualifications be a good fit for other opportunities.',
  ])('a rejection with a courtesy sentence and no contact invite is still denied (F49-1): %s', (courtesy) => {
    const { action } = untouched('Your application to Acme', rejectionWith(D, courtesy), 'Acme Recruiting <no-reply@greenhouse.io>');
    expect(action).toBe('deny');
  });

  test('a rejection whose signature is a row of profile links is still denied', () => {
    const body = 'Hi Dan,\n\nThank you for your interest in the Backend Engineer role at Acme. ' + D + '\n\nBest,\nJane Doe\nRecruiter at Acme\nhttps://acme.com/jane | https://linkedin.com/in/jane\n';
    const { action } = untouched('Your application to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>');
    expect(action).toBe('deny');
  });

  test.each(DECLINES)('a plain rejection with equal opportunity and do-not-reply footers is still denied: %s', (decline) => {
    const body = 'Hi Dan,\n\nThank you for your interest in the Backend Engineer role at Acme. ' + decline +
      ' We wish you the best in your search.\n\nBest,\nAcme Recruiting\n\nAcme is an equal opportunity employer. All qualified applicants will receive consideration for employment without regard to race, color, religion, sex, national origin, disability or protected veteran status.\n\nPlease do not reply to this email. This email is sent from an unattended mailbox.';
    const { action } = untouched('Your application to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>');
    expect(action).toBe('deny');
  });

  test.each([
    ['bullet-separated', 'https://acme.com/offer/sign • https://acme.com/careers'],
    ['comma-separated', 'https://acme.com/onboarding/documents, https://acme.com/careers'],
    ['pipe-separated', 'https://acme.com/portal/tasks | https://acme.com/careers'],
    ['single', 'https://acme.com/offer/sign'],
    ['labelled social', 'LinkedIn https://linkedin.com/company/acme • Twitter https://twitter.com/acme'],
  ])('a confirmation with a %s row of links stays untouched (F48-2)', (_name, links) => {
    const body = 'Hi Dan,\n\nThank you for applying to the Backend Engineer role at Acme. We have received your application.\n\n' + links + '\n\nAcme Recruiting';
    const { action, t } = untouched('Thank you for applying to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>');
    expect(action).toBe('keep');
    expect(t.calls).toEqual([]);
  });
});

describe('v5.5: a rejection is denied only when every sentence is an allowlisted shape', () => {
  const D = 'Unfortunately, we have decided not to move forward with your application.';
  const run = (sentence: string) => {
    const body = 'Hi Dan,\n\nThank you for your interest in the Backend Engineer role at Acme. ' + D + ' ' + sentence + '\n\nBest,\nAcme Recruiting';
    const t = thread([], [message('Your application to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>')]);
    const { api } = load([t]);
    return { action: api.processThread_(t), t };
  };

  test.each([
    'The weather in Denver is lovely this week.',
    'Our recruiter Jane will email you to set up time.',
    "I'd be happy to introduce you to the Platform hiring manager.",
    'We would like to consider you for other roles that fit your applications.',
    "Thanks for your time; I'd love to stay in touch about a Staff role opening next month.",
    'We have a lot of exciting things happening at Acme and would like to tell you about one of them.',
    'Please update your candidate profile so our recruiter can reach you.',
    'Always confirm or apply for any open roles directly with Jane.',
  ])('a rejection with an unrecognised sentence stays untouched in the Inbox: %s', (sentence) => {
    const { action, t } = run(sentence);
    expect(action).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(t.inInbox).toBe(true);
  });

  test('a careful-consideration rejection with an unrelated office-closure sentence stays untouched in the Inbox', () => {
    const body = 'Hi Dan,\n\nThank you for your interest in the Backend Engineer role at Acme. After careful consideration, we have decided not to move forward with your application at this time. ' +
      'Please note our office will be closed on Monday for the holiday.\n\nBest,\nAcme Recruiting';
    const t = thread([], [message('Your application to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>')]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(t.inInbox).toBe(true);
  });

  test.each([
    'We wish you the best of luck in your job search.',
    'We encourage you to visit our careers page periodically for other roles that might interest you.',
    'This was not an easy decision, as we received a number of strong applications.',
    'We will keep your information on file for future opportunities.',
    'Stay in the loop and join our talent community.',
    'Thank you again for your interest in joining our team.',
    'We truly appreciate the time and effort you put into your application.',
    'Your applicant information will be stored and processed in accordance with our privacy policy.',
  ])('a rejection whose extra sentence is an allowlisted courtesy shape is denied: %s', (sentence) => {
    expect(run(sentence).action).toBe('deny');
  });

  const CAREFUL = 'After careful consideration, we have decided not to move forward with your application at this time.';
  const runBody = (body: string) => {
    const t = thread([], [message('Your application to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>')]);
    const { api } = load([t]);
    return { action: api.processThread_(t), t, api };
  };
  const SHORT_CONTACT = ['Email Jane.', 'Contact Jane.', 'Text Jane.', 'Reach out.', 'Write back.', 'Ping Jane.', 'Holler anytime.'];

  test.each(SHORT_CONTACT)('a short contact sentence after a careful-consideration rejection stays untouched in the Inbox (F50-1): %s', (sentence) => {
    const { action, t } = runBody('Hi Dan,\n\n' + CAREFUL + ' ' + sentence + '\n\nBest,\nAcme Recruiting');
    expect(action).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(t.inInbox).toBe(true);
  });

  test.each(SHORT_CONTACT)('a short contact sentence after a plain rejection stays untouched in the Inbox (F50-1): %s', (sentence) => {
    expect(run(sentence).action).toBe('keep');
  });

  test.each(['Contact Recruiting.', 'Email Recruiting.', 'Call Recruiting.'])('a contact verb before a team name after a careful-consideration rejection stays untouched in the Inbox: %s', (sentence) => {
    const { action, t } = runBody('Hi Dan,\n\n' + CAREFUL + ' ' + sentence + '\n\nBest,\nAcme Recruiting');
    expect(action).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(t.inInbox).toBe(true);
  });

  test.each(['Email Jane.', 'Reach out.', 'Holler.'])('a short contact line on its own before the sign-off stays untouched in the Inbox: %s', (line) => {
    expect(runBody('Hi Dan,\n\n' + CAREFUL + '\n\n' + line + '\n\nBest,\nAcme Recruiting').action).toBe('keep');
  });

  test.each([
    'Website · Phone screen with Jane ( URL ) · Blog',
    'Website · Phone screen with Jane URL · Blog',
    'Careers · Book a call with Jane ( URL ) · LinkedIn',
    "Careers · Jane's calendar ( URL ) · LinkedIn",
    'Follow us on LinkedIn, Jane Smith phone screen Monday, and Instagram.',
    'We have decided to move forward with other candidates for the Backend - Phone Interview Monday - Platform role.',
  ])('a repeated slot holding a scheduling word before the last repeat stays untouched in the Inbox (F50-2): %s', (sentence) => {
    const { action, t, api } = runBody('Hi Dan,\n\n' + CAREFUL + ' ' + sentence + '\n\nBest,\nAcme Recruiting');
    expect(action).toBe('keep');
    expect(t.inInbox).toBe(true);
    expect(api.unexplainedRejection_('Hi Dan,\n\n' + CAREFUL + ' ' + sentence + '\n\nBest,\nAcme Recruiting')).not.toBeNull();
  });

  test.each(['Contacting.', 'Emailed.', 'Emailing.', 'Contacted.', 'Messaging.', 'Callback.', 'Reaching out.', 'Reaching.', 'Pinging.', 'Texted.'])(
    'an inflected contact word as the last paragraph stays untouched in the Inbox (F51-1): %s', (line) => {
      const { action, t } = runBody('Hi Dan,\n\n' + CAREFUL + '\n\n' + line);
      expect(action).toBe('keep');
      expect(t.inInbox).toBe(true);
    });

  test.each([
    'Website · Emailing Jane ( URL ) · Blog',
    'Website · Messaging Jane ( URL ) · Blog',
    'Follow us on LinkedIn, Twitter and Messaging Jane.',
    'Emailed Jane 12345.',
    'Contacting jobs.',
  ])('an inflected contact word in a name slot stays untouched in the Inbox (F51-1): %s', (sentence) => {
    const { action, t } = runBody('Hi Dan,\n\n' + CAREFUL + ' ' + sentence + '\n\nBest,\nAcme Recruiting');
    expect(action).toBe('keep');
    expect(t.inInbox).toBe(true);
  });

  test.each([
    'We will keep your resume on file and contact you should a suitable position open.',
    'We encourage you to stay connected with us through our website for future openings.',
    'Thank you for your interest in Acme and for connecting with us.',
    'We wish you the best of luck in your job search; feel free to book time with Jane.',
    'Thank you for your time, and please schedule a chat with Jane.',
  ])('a courtesy sentence holding a contact word stays untouched in the Inbox: %s', (sentence) => {
    const { action, t } = runBody('Hi Dan,\n\n' + CAREFUL + ' ' + sentence + '\n\nBest,\nAcme Recruiting');
    expect(action).toBe('keep');
    expect(t.inInbox).toBe(true);
  });

  test.each(['Voicemail.', 'WhatsApp.', 'Hired.', 'Acme'])('a lone capitalised word with no sign-off above it stays untouched in the Inbox: %s', (line) => {
    const { action, t } = runBody('Hi Dan,\n\n' + CAREFUL + ' We wish you the best of luck in your job search.\n\n' + line);
    expect(action).toBe('keep');
    expect(t.inInbox).toBe(true);
  });

  test.each([
    'Website · LinkedIn ( URL ) · Blog',
    'Follow us on LinkedIn, Twitter and Instagram.',
  ])('a repeated slot of plain names still denies: %s', (sentence) => {
    expect(runBody('Hi Dan,\n\n' + CAREFUL + ' ' + sentence + '\n\nBest,\nAcme Recruiting').action).toBe('deny');
  });

  test.each([
    ['a bare first name under the sign-off', 'Best,\nJane'],
    ['a bare first name a blank line under the sign-off', 'Best,\n\nJane'],
    ['a dashed company line with no sign-off', '- Acme'],
  ])('a plain rejection signed with %s still denies', (_, signature) => {
    expect(runBody('Hi Dan,\n\n' + CAREFUL + ' We wish you the best of luck in your job search.\n\n' + signature).action).toBe('deny');
  });

  test('unexplainedRejection_ names the first unrecognised sentence and returns null for a plain rejection', () => {
    const { api } = load([]);
    expect(api.unexplainedRejection_('Hi Dan,\n\n' + D + ' We wish you the best in your search.\n\nBest,\nAcme Recruiting')).toBeNull();
    expect(api.unexplainedRejection_('Hi Dan,\n\n' + D + ' The weather in Denver is lovely this week.\n\nBest,\nAcme Recruiting')).toContain('weather in Denver');
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

describe('reaudit returns archived mail that is not a plain application to the Inbox untouched', () => {
  test('previewReaudit logs an archived invite without changing it', () => {
    const t = thread([APPLICATIONS], [message('Next step with Acme', INVITE_BODY)], false);
    const { api, logs } = load([t]);
    api.previewReaudit();
    expect(t.calls).toEqual([]);
    expect(logs.some((l) => l.startsWith('would keep | ') && l.includes('Next step with Acme'))).toBe(true);
    expect(logs.some((l) => l.startsWith('previewReaudit complete.') && l.includes('"keep":1'))).toBe(true);
  });

  test('reauditApplications takes Applications off an archived invite and moves it to the Inbox with no new label', () => {
    const invite = thread([APPLICATIONS], [message('Next step with Acme', INVITE_BODY)], false);
    const confirmation = thread([APPLICATIONS], [message('Your application', CONFIRMATION_BODY)], false);
    const { api, logs, scriptStore, created } = load([invite, confirmation]);
    api.reauditApplications();
    expect(invite.calls).toEqual(['remove ' + APPLICATIONS, 'inbox']);
    expect(invite.labels.size).toBe(0);
    expect(invite.inInbox).toBe(true);
    expect(confirmation.calls).toEqual([]);
    expect(created).toEqual([]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
    expect(logs.some((l) => l.startsWith('keep | ') && l.includes('Next step with Acme'))).toBe(true);
  });

  test('reauditApplications also takes off an existing v5.2 Interviews label, and never creates one', () => {
    const invite = thread([APPLICATIONS, LEGACY_INTERVIEWS], [message('Next step with Acme', INVITE_BODY)], false);
    const { api, created } = load([invite], {}, [APPLICATIONS, REJECTIONS, LEGACY_INTERVIEWS]);
    api.reauditApplications();
    expect(invite.calls).toEqual(['remove ' + APPLICATIONS, 'remove ' + LEGACY_INTERVIEWS, 'inbox']);
    expect(invite.labels.size).toBe(0);
    expect(invite.inInbox).toBe(true);
    expect(created).toEqual([]);
  });

  test('reauditApplications follows the thread rules: a recruiter note goes back to the Inbox, a conditional promise stays archived', () => {
    const noted = thread([APPLICATIONS], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Re: Thank you for applying to Acme', RECRUITER_NOTE, 'Jordan Rivera <jordan@acme.com>')], false);
    const boilerplate = thread([APPLICATIONS], [message('Thank you for applying to Initech', 'Thank you for applying to Initech. If your experience matches, we will reach out to schedule an interview.')], false);
    const rejected = thread([APPLICATIONS], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Update on your application', ACME_REJECTION)], false);
    const { api, scriptStore } = load([noted, boilerplate, rejected]);
    api.reauditApplications();
    expect(noted.calls).toEqual(['remove ' + APPLICATIONS, 'inbox']);
    expect(boilerplate.calls).toEqual([]);
    expect(rejected.calls).toEqual(['add ' + REJECTIONS, 'remove ' + APPLICATIONS]);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(1);
  });

  test('preview follows the thread rules, logs KEEP lines and changes nothing', () => {
    const rejected = thread([], [message('Thank you for applying to Acme', ACME_CONFIRMATION), message('Update on your application', ACME_REJECTION)]);
    const noted = thread([], [
      message('Thank you for applying to Acme', ACME_CONFIRMATION),
      message('Re: Thank you for applying to Acme', RECRUITER_NOTE, 'Jordan Rivera <jordan@acme.com>'),
      message('Update on your application', ACME_REJECTION),
    ]);
    const plain = thread([], [message('Your application', CONFIRMATION_BODY)]);
    const { api, logs, scriptStore, created } = load([rejected, noted, plain]);
    api.preview();
    expect([rejected, noted, plain].flatMap((t) => t.calls)).toEqual([]);
    expect(created).toEqual([]);
    expect(logs.filter((l) => l.startsWith('DENY '))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('KEEP ') && l.includes('message besides the rejection'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('1 rejections, 1 job emails kept in the Inbox, 1 application confirmations'))).toBe(true);
    expect(Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:'))).toHaveLength(0);
  });
});

describe('v5.6: reauditRejections sends every Rejections thread that is no longer a rejection back to the Inbox', () => {
  const OFFER_TO_TALK = 'Hi Alex,\n\nUnfortunately, we have decided not to move forward with your application. Would you be open to a different position?\n\nAcme Recruiting';
  const outcomeKey = (m: Message) => 'outcome:' + m.getHeader();

  test('previewReauditRejections logs the thread it would send back and changes nothing', () => {
    const m = message('Update on your application', OFFER_TO_TALK);
    const t = thread([REJECTIONS], [m], false);
    const { api, logs, scriptStore } = load([t], { [outcomeKey(m)]: '{}' });
    api.previewReauditRejections();
    expect(t.calls).toEqual([]);
    expect(t.labels.has(REJECTIONS)).toBe(true);
    expect(scriptStore.data[outcomeKey(m)]).toBe('{}');
    expect(logs.some((l) => l.startsWith('would back | ') && l.includes('Update on your application'))).toBe(true);
    expect(logs.some((l) => l.startsWith('previewReauditRejections complete.') && l.includes('"back":1'))).toBe(true);
  });

  test('reauditRejections takes the label off, drops the pending outcome and moves the thread to the Inbox; a rejection that stands is untouched', () => {
    const offer = message('Update on your application', OFFER_TO_TALK);
    const backThread = thread([REJECTIONS], [offer], false);
    const plain = message('Update on your application', ACME_REJECTION);
    const stays = thread([REJECTIONS], [plain], false);
    const { api, logs, scriptStore, created } = load([backThread, stays], { [outcomeKey(offer)]: '{}', [outcomeKey(plain)]: '{}' });
    api.reauditRejections();
    expect(backThread.calls).toEqual(['remove ' + REJECTIONS, 'inbox']);
    expect(backThread.labels.size).toBe(0);
    expect(backThread.inInbox).toBe(true);
    expect(stays.calls).toEqual([]);
    expect(stays.labels.has(REJECTIONS)).toBe(true);
    expect(created).toEqual([]);
    expect(outcomeKey(offer) in scriptStore.data).toBe(false);
    expect(outcomeKey(plain) in scriptStore.data).toBe(true);
    expect(logs.some((l) => l.startsWith('back | ') && l.includes('Update on your application'))).toBe(true);
    expect(logs.some((l) => l.startsWith('reauditRejections complete.') && l.includes('"back":1') && l.includes('"unchanged":1'))).toBe(true);
  });

  test('resetReaudit clears the Applications and the Rejections cursors', () => {
    const { api, userStore } = load([], {}, [APPLICATIONS, REJECTIONS], {
      reauditOffset: '100',
      previewReauditOffset: '100',
      reauditRejectionsOffset: '100',
      previewReauditRejectionsOffset: '100',
      backfillOffset: '200',
    });
    api.resetReaudit();
    expect(Object.keys(userStore.data)).toEqual(['backfillOffset']);
  });
});

describe('v5.6: more standard parts of a rejection are allowlisted, and requests veto it', () => {
  const D = 'Unfortunately, we have decided not to move forward with your application.';
  const run = (sentence: string) => {
    const body = 'Hi Dan,\n\nThank you for your interest in the Backend Engineer role at Acme. ' + D + ' ' + sentence + '\n\nBest,\nAcme Recruiting';
    const t = thread([], [message('Your application to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>')]);
    const { api } = load([t]);
    return { action: api.processThread_(t), t, api, body };
  };

  test.each([
    'There was significant interest in this role.',
    'We received a large number of applications, making the selection process highly competitive.',
    'Due to high volumes of applications, we are unable to provide individual feedback at this stage.',
    'Please be assured that your application was carefully reviewed by our recruiting team.',
    'We will keep your resume in our database should another opportunity similar to this one open up.',
    "We'll be sure to reconnect if something opens up that may be a better match.",
    "We'd welcome the opportunity to stay connected with you.",
    'Your interest means a lot to us.',
    'We know that a job search can be a lot of work.',
    'We hope you will consider us for future opportunities.',
    'We wish you all the best in the search for your next opportunity.',
    'We are growing and adding new roles regularly, so we encourage you to explore our careers page.',
    'This email was automatically generated by Acme.',
    'We will keep your information on file and reach out if future opportunities arise that match your background.',
    'Thank you for taking the time to speak with our team.',
    'This was not an easy decision, and we had to make some difficult calls.',
    'We would appreciate your feedback on your application experience through this optional survey.',
    'You may receive a brief, optional survey about your candidate experience.',
  ])('a rejection whose extra sentence is a standard part is denied: %s', (sentence) => {
    const { action, api, body } = run(sentence);
    expect(api.unexplainedRejection_(body)).toBeNull();
    expect(action).toBe('deny');
  });

  test.each([
    ['an assessment link', 'Please complete the assessment at https://acme.example.com/test.'],
    ['a question', 'Would you be open to a different position?'],
    ['a specific other role', "We'd love to discuss our Staff Engineer opening with you."],
    ['an on-hold role', 'The role has been put on hold.'],
    ['an upload request', 'Please upload your portfolio to the candidate portal.'],
    ['a form', 'Please fill out the short questionnaire below.'],
    ['a paused role', 'We have paused hiring for this position.'],
    ['a required survey', 'Please complete the required survey by Friday.'],
    ['a survey with a deadline', 'You may receive a brief, optional survey about your candidate experience, due by Friday.'],
    ['a survey about interview availability', 'Please complete this survey about your availability for an interview.'],
  ])('a rejection with %s stays untouched in the Inbox', (_shape, sentence) => {
    const { action, t } = run(sentence);
    expect(action).toBe('keep');
    expect(t.calls).toEqual([]);
    expect(t.inInbox).toBe(true);
  });

  test('a paused role is not a decision on its own', () => {
    const body = 'Hi Dan,\n\nThank you for applying to the Backend Engineer role at Acme. We have put this role on hold for now.\n\nBest,\nAcme Recruiting';
    const t = thread([], [message('Your application to Acme', body, 'Acme Recruiting <no-reply@greenhouse.io>')]);
    const { api } = load([t]);
    expect(api.processThread_(t)).toBe('keep');
    expect(t.calls).toEqual([]);
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
    'Hi Alex,\n\nThank you for applying to the Backend Engineer role at Acme. ' + sentence + '\n\nBest,\nAcme Recruiting';
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
    expect(classify(wrapped(sentence))).toBe('keep');
  });

  test.each(ACTION_SENTENCES)('the sentence allowlist alone rejects it, without the scheduling-word veto: %s', (sentence) => {
    expect(unacknowledged_(wrapped(sentence), false)).not.toBeNull();
  });

  test.each([
    ['an action after the sign-off', 'Hi Alex,\n\nThank you for applying to Acme.\n\nBest,\nAcme Recruiting\n\nP.S. Upload your portfolio by Friday.'],
    ['an action as a title-case line', 'Thank you for applying to Acme.\n\nAction Required\n\nAcme Recruiting'],
    ['an action in the signature', 'Thank you for applying to Acme.\n\nBest,\nPlease Reply By Friday'],
    ['an action inside a footer sentence', 'Thank you for applying to Acme.\n\nPlease do not reply to this email; instead, upload your portfolio by Friday.'],
    ['an action in the greeting line', 'Hi Alex, please upload your portfolio.\n\nThank you for applying to Acme.'],
    ['a bare link line', 'Thank you for applying to Acme.\nhttps://acme.example.com/start\n\nAcme Recruiting'],
    ['a request in a footer sentence', 'Thank you for applying to Acme.\n\nThis email was sent by Greenhouse; respond with your portfolio.'],
    ['a title-case reminder at the end', 'Thank you for applying to Acme.\n\nAcme Recruiting\nFinal Step Reminder'],
  ])('%s is kept', (_name, body) => {
    expect(classify(body)).toBe('keep');
    expect(unacknowledged_(body, false)).not.toBeNull();
  });

  const ATS_CONFIRMATIONS: [string, string, string][] = [
    ['Greenhouse', 'Acme Recruiting <no-reply@greenhouse.io>',
      'Hi Alex,\n\nThanks for applying to Acme. Your application has been received and we will review it right away.\n\nIf your application seems like a good fit for the position we will contact you soon.\n\nRegards,\nAcme\n\n** Please note: Do not reply to this email. This email is sent from an unattended mailbox. Replies will not be read.'],
    ['Lever', 'Acme <no-reply@hire.lever.co>',
      'Hi Alex,\n\nThank you for your interest in Acme! We wanted to let you know we received your application for Senior Backend Engineer, and we are delighted that you would consider joining our team.\n\nOur team will review your application and will be in touch if your qualifications match our needs for the role.\n\nBest,\nThe Acme Team\n\nSent with Lever'],
    ['Workday', 'Acme Careers <acme@myworkday.com>',
      'Dear Alex Doe,\n\nThank you for your interest in a career with Acme Corporation. We have received your application for the Backend Engineer position.\n\nOur recruiting team will carefully review your qualifications. If your background matches the requirements of the position, a member of our recruiting team will contact you.\n\nYou can track the status of your application at any time by logging in to your candidate home.\n\nSincerely,\nAcme Talent Acquisition\n\nAcme Corporation is an Equal Opportunity Employer. All qualified applicants will receive consideration for employment without regard to race, color, religion, sex, national origin, disability or protected veteran status.'],
    ['Ashby', 'Acme Recruiting <no-reply@ashbyhq.com>',
      "Hi Alex,\n\nThanks for applying to the Backend Engineer role at Acme! We're excited that you're interested in joining our team.\n\nOur hiring team is reviewing your application and will get back to you in the coming weeks.\n\nBest,\nAcme Recruiting\n\nPowered by Ashby"],
    ['iCIMS', 'Acme Talent <acme@talent.icims.com>',
      'Dear Alex,\n\nThank you for submitting your application for the Backend Engineer position at Acme. This email confirms that we have received your application.\n\nWe will review your background and qualifications carefully and contact you if there is a match.\n\nAgain, we appreciate your interest in Acme and wish you luck in your job search.\n\nKind regards,\nAcme Talent Acquisition Team\n\nThis message was sent by iCIMS on behalf of Acme. Please do not reply to this email.'],
    ['SmartRecruiters', 'Acme Hiring Team <noreply@smartrecruiters.com>',
      'Hi Alex,\n\nThank you for applying to the Backend Engineer position at Acme. We have received your application and will review it shortly.\n\nIf your profile matches our requirements, we will get in touch with you.\n\nBest regards,\nAcme Hiring Team\n\nPrivacy Policy | Unsubscribe\nPowered by SmartRecruiters'],
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
    'Hi Alex,\n\nThank you for applying to the Backend Engineer role at Acme. ' + sentence + '\n\nBest,\nAcme Recruiting';
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
    expect(classify(wrapped(sentence))).toBe('keep');
    expect(unacknowledged_(wrapped(sentence), false)).not.toBeNull();
  });

  test.each([
    ['an unsigned title line above an unsigned signature', 'Hi Alex,\n\nThank you for applying to Acme.\n\nCoding Project Instructions\n\nAcme Recruiting'],
    ['an automated-message line after the signature', 'Hi Alex,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\nAutomated message: the take-home project is in your portal.'],
    ['an automated-email line after the signature', 'Hi Alex,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\nThis automated email has your portfolio request.'],
    ['a confidential line after the signature', 'Hi Alex,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\nConfidential: your take-home project awaits.'],
    ['an address line carrying instructions', 'Hi Alex,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\n123 Main Street, Suite 400 coding project instructions'],
    ['a title line above the signature', 'Hi Alex,\n\nThank you for applying to Acme.\n\nYour Case Study\nAcme Recruiting'],
    ['a linked title above the signature', 'Hi Alex,\n\nThank you for applying to Acme.\n\nTechnical Project Instructions <https://acme.io/p>\nAcme Recruiting'],
    ['a title-case note above a name', 'Hi Alex,\n\nThank you for applying to Acme.\n\nWe Want To Connect\nJane Doe'],
    ['a signature block that is not the end of the body', 'Hi Alex,\n\nThank you for applying to Acme.\n\nAcme Recruiting\n\nYour Case Study'],
    ['a title line after a signed block across a blank line', 'Hi Alex,\n\nThank you for applying to Acme.\n\nBest,\nAcme Recruiting\n\nCoding Project Instructions'],
  ])('%s is kept', (_name, body) => {
    expect(classify(body)).toBe('keep');
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
    expect(classify('Hi Alex,\n\nThank you for applying to Acme.\n\nAcme Recruiting\nTalent Team')).toBe('job');
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

describe('a mailing address is a footer only as a whole sentence of capitalised address words (F35-14)', () => {
  const sandbox: Record<string, unknown> = { Logger: { log() {} }, PropertiesService: {}, Session: {}, GmailApp: {}, Gmail: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') + '\nthis.__a = { classifyThread_, footer_ };', sandbox);
  const { classifyThread_, footer_ } = sandbox.__a as {
    classifyThread_(messages: unknown[], rules: { excludedDomains: string[] }, me: string): { action: string };
    footer_(sentence: string): boolean;
  };
  const wrapped = (sentence: string) =>
    'Hi Alex,\n\nThank you for applying to the Backend Engineer role at Acme. ' + sentence + '\n\nBest,\nAcme Recruiting';
  const classify = (body: string) =>
    classifyThread_([{ getFrom: () => 'Acme Recruiting <no-reply@greenhouse.io>', getSubject: () => 'Your application to Acme', getPlainBody: () => body }], { excludedDomains: [] }, 'me@example.com').action;

  test.each([
    // probe F35-14
    'Important: 1 pm Thursday at 350 Mission St, Floor 4, San Francisco, CA',
    '10 am Friday at 500 Market St.',
    'Note: 9 am Monday at 1 Hacker Way.',
    'Please note: 11 am tomorrow at our Main St',
    '500 Market St, see you on monday, ok',
    'Suite 300, see you tomorrow, ok',
    // the same with capitalised words or a full address
    '1 PM Thursday At 350 Mission St, Floor 4, San Francisco, CA 94105',
    '10 AM Friday, 500 Market St, Suite 300, San Francisco, CA 94105',
    '500 Market St, Suite 300, See You Monday, OK',
    'Suite 300, See You Tomorrow, CA 94105',
    'Meet Jane, 500 Market St, Suite 300, San Francisco, CA 94105',
    '500 Market St, Room 4',
    '500 Market St, Floor 4, San Francisco, CA',
    'Floor 4.',
    'Room 12B.',
    '500 Market St.',
    'Interview: 500 Market St, Suite 300, San Francisco, CA 94105',
    '500 Market St, Suite 300, San Francisco, CA 94105, at 2 pm',
  ])('a meeting time or place on a confirmation is kept: %s', (sentence) => {
    expect(footer_(sentence)).toBe(false);
    expect(classify(wrapped(sentence))).toBe('keep');
  });

  test.each([
    '500 Market St, Suite 300, San Francisco, CA 94105',
    '1 Hacker Way, Menlo Park, CA 94025',
    '500 Howard Street, San Francisco, CA 94105',
    'Acme Corporation, 100 Market Street, Suite 300, San Francisco, CA 94105',
    '350 5th Ave, New York, NY 10118, USA',
    'Acme · 1 Infinite Loop Blvd · Cupertino, CA 95014',
    'San Francisco, CA 94105',
    '500 Market St, Suite 300',
  ])('a real mailing address stays a footer: %s', (address) => {
    expect(footer_(address)).toBe(true);
    expect(classify(wrapped(address))).toBe('job');
  });

  const signed = (line: string) => 'Hi Alex,\n\nThank you for applying to Acme.\n\nBest,\nJane Doe\nRecruiter, Acme\n' + line;

  test.each(['2026-11-05', '11.05.2026', '05 11 2026', '10.30 - 11.30'])(
    'a date or time line under the signature is not a phone line: %s',
    (line) => {
      expect(classify(signed(line))).toBe('keep');
    },
  );

  test.each(['(555) 123-4567', '+1 415.555.0123', 'T: 020 7946 0958', 'jane@acme.com | +44 20 7946 0958'])(
    'a phone line under the signature is set aside: %s',
    (line) => {
      expect(classify(signed(line))).toBe('job');
    },
  );
});

describe('after a sign-off only allowlisted signature lines are set aside', () => {
  const sandbox: Record<string, unknown> = { Logger: { log() {} }, PropertiesService: {}, Session: {}, GmailApp: {}, Gmail: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') + '\nthis.__a = { classifyThread_, unacknowledged_ };', sandbox);
  const { classifyThread_, unacknowledged_ } = sandbox.__a as {
    classifyThread_(messages: unknown[], rules: { excludedDomains: string[] }, me: string): { action: string };
    unacknowledged_(body: string, verification: boolean): string | null;
  };
  const classify = (body: string) =>
    classifyThread_([{ getFrom: () => 'Acme Recruiting <no-reply@greenhouse.io>', getSubject: () => 'Your application to Acme', getPlainBody: () => body }], { excludedDomains: [] }, 'me@example.com').action;
  const signed = (signature: string) => 'Hi Alex,\n\nThank you for applying to the Backend Engineer role at Acme.\n\nBest,\n' + signature;

  test.each([
    'Acme Recruiting\nTechnical Project Instructions',
    "Jane Doe\nEngineering Manager\nLet's Connect Soon",
    'Acme Recruiting\nCoding Challenge Details',
    'Acme Recruiting\nPortfolio Review Request',
    'The Acme Team\nCase Study Attached',
    'Jane Doe\nWork Sample Instructions',
    'Jane Doe\nRecruiter, Acme\nTake Home Project Brief',
    'Acme Talent Acquisition\nWriting Sample Needed',
    'Acme Hiring Team\nSecond Round Details',
    'Jane Doe\nSenior Technical Recruiter\nFinal Presentation Prep',
    'Acme Recruiting\nDesign Exercise Overview',
    'Acme Recruiting\njane@acme.com\nReference Details Requested',
  ])('an action line under the signature is kept: %s', (signature) => {
    expect(classify(signed(signature))).toBe('keep');
    expect(unacknowledged_(signed(signature), false)).not.toBeNull();
  });

  test('an unsigned title line inside the closing block is kept', () => {
    const body = 'Hi Alex,\n\nThank you for applying to Acme.\n\nCoding Project Instructions\nAcme Recruiting';
    expect(classify(body)).toBe('keep');
  });

  test.each([
    'Acme',
    'Acme Recruiting',
    'The Acme Team',
    'The Acme Recruiting Team',
    'Acme Talent Acquisition Team',
    'Jane Doe\nSenior Technical Recruiter | Acme\njane@acme.com | (555) 123-4567',
    "Mary-Jane O'Neil\nTalent Acquisition Partner at Acme\nacme.com",
    'Jane Q. Doe\nHead of Talent, Acme Inc.',
    'Sam Lee\nFounder & CEO\nAcme Labs',
  ])('a realistic signature is set aside: %s', (signature) => {
    expect(classify(signed(signature))).toBe('job');
  });

  test('an unsigned name above a job title closing the body is set aside', () => {
    expect(classify('Hi Alex,\n\nThank you for applying to Acme.\n\nJane Doe\nRecruiter, Acme')).toBe('job');
  });
});

describe('only proven boilerplate is exempt from the scheduling-word check; when unsure, keep', () => {
  const sandbox: Record<string, unknown> = { Logger: { log() {} }, PropertiesService: {}, Session: {}, GmailApp: {}, Gmail: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') + '\nthis.__a = { classifyThread_ };', sandbox);
  const { classifyThread_ } = sandbox.__a as {
    classifyThread_(messages: unknown[], rules: { excludedDomains: string[] }, me: string): { action: string };
  };
  const wrapped = (paragraph: string) =>
    'Hi Alex,\n\nThank you for applying to the Backend Engineer role at Acme. We have received your application.\n\n' + paragraph + '\n\nBest regards,\nAcme Recruiting';
  const classify = (body: string, subject = 'Thank you for applying to Acme') =>
    classifyThread_([{ getFrom: () => 'Acme Recruiting <no-reply@greenhouse.io>', getSubject: () => subject, getPlainBody: () => body }], { excludedDomains: [] }, 'me@example.com').action;

  const BOILERPLATE: [string, string][] = [
    ['a "next steps" conditional', 'If your experience is a match for the role, we will contact you about next steps.'],
    ['a "next steps" conditional with the role first', 'If the role seems like a good fit, our team will reach out to discuss next steps.'],
    ['a "what\'s next" review paragraph', "What's next? Our recruiting team will review your application and will be in touch about next steps."],
    ['a talent-community invite', 'In the meantime, we invite you to join our talent community to stay connected about future opportunities.'],
    ['a "we\'ll be in touch to schedule" conditional', "If your background aligns with the role, we'll be in touch to schedule an interview."],
    ['a "move forward" conditional before scheduling', 'If we would like to move forward, we will be in touch to set up an interview.'],
    ['a process description naming interview stages', 'Our interview process typically includes a recruiter screen, a technical interview and a final onsite.'],
    ['"screen your application"', 'Our recruiting team will screen your application and reach out if there is a match.'],
    ['an applicant-pool contact promise', 'Candidates who move forward in the interview process will be contacted by a recruiter.'],
    ['an if-selected contact promise', 'If you are selected for an interview, a member of our team will contact you.'],
    ['a selected-for-interview volume notice', 'Due to the high volume of applications, we are only able to respond to candidates selected for an interview.'],
    ['a conditional promise of a phone screen', 'Should your qualifications match the requirements of the role, a recruiter will reach out to schedule a phone screen.'],
    ['a resume-on-file note', 'We will keep your resume on file for future openings.'],
    ['an active-review note', 'Our team is actively reviewing all applications and will be reaching out to candidates whose qualifications best match the requirements of the position.'],
  ];

  test.each(BOILERPLATE)('a confirmation with %s is archived as application mail', (_shape, paragraph) => {
    expect(classify(wrapped(paragraph))).toBe('job');
  });

  const INTERVIEW_SHAPES: [string, string][] = [
    ['a scheduling ask', 'Could you share a few times that work for you next week for a 30-minute call?'],
    ['an invite to interview', 'We would like to invite you to interview for the Backend Engineer role.'],
    ['a named interviewer with a date and time', 'Your interview with Jane Doe is scheduled for Tuesday, November 10 at 2pm PT.'],
    ['a Calendly link', 'Please pick a slot that suits you: https://calendly.com/acme-recruiting/30min'],
    ['a GoodTime link', 'You will receive an email from GoodTime to choose your interview time.'],
    ['a booking link', 'Use this link to book your phone screen: https://acme.example.com/book/123'],
    ['an assessment to complete', 'As a next step, please complete the online coding assessment within five days.'],
    ['a direct offer', 'We are pleased to extend you an offer for the Backend Engineer role.'],
  ];

  test.each(INTERVIEW_SHAPES)('a confirmation with %s is kept, never archived or denied', (_shape, paragraph) => {
    expect(classify(wrapped(paragraph))).toBe('keep');
  });

  test('a rejection offering a call is kept, never denied', () => {
    const body =
      "Hi Alex,\n\nUnfortunately, we will not be moving forward with your application for this role. We'd love to set up a call with you about another opening on the team.\n\nAcme Recruiting";
    expect(classify(body, 'Update on your application')).toBe('keep');
  });

  test.each([
    ['an unknown sentence', 'Our office dog says hello and the whole floor is excited about the spring offsite.'],
    ['a first-person note', 'I really enjoyed reading your portfolio and passed it to the team myself.'],
  ])('a confirmation with %s is kept', (_shape, paragraph) => {
    expect(classify(wrapped(paragraph))).toBe('keep');
  });
});
