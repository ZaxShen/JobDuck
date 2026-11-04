import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

type Part = { source: string; loose: string | null; re: RegExp | null; strict: RegExp | null };

function load() {
  const sandbox: Record<string, unknown> = { Logger: { log() {} }, PropertiesService: {}, Session: {}, GmailApp: {}, Gmail: {} };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(join(import.meta.dir, '..', 'Code.gs'), 'utf8') +
      '\nthis.__a = { classifyThread_, shapeMatch_, rejectionRegExp_, RJ_CLAUSES, RJ_NAME, RJ_NAME_GUARD, RJ_NAME_LOOSE_GUARD, RJ_NAME_STOP, REJECTION_CLAUSES, REJECTION_FRAME };',
    sandbox,
  );
  return sandbox.__a as {
    classifyThread_(messages: unknown[], rules: { excludedDomains: string[] }, me: string): { action: string };
    shapeMatch_(shape: Part[], text: string): string[] | null;
    rejectionRegExp_(pattern: string): RegExp;
    RJ_CLAUSES: string[];
    RJ_NAME: string;
    RJ_NAME_GUARD: string;
    RJ_NAME_LOOSE_GUARD: string;
    RJ_NAME_STOP: string;
    REJECTION_CLAUSES: Part[][];
    REJECTION_FRAME: Part[][];
  };
}

const ACME_REJECTION =
  'Hi Danlin,\n\nThank you for applying to the Backend Engineer role at Acme. Unfortunately, we have decided not to move forward with your application.\n\nAcme Recruiting';

describe('rejection shapes stay small enough for Apps Script (v5.5 out of memory)', () => {
  test('a typical rejection builds a few loose parts, never the guarded ones or the whole alternation', () => {
    const a = load();
    const action = a.classifyThread_(
      [{ getFrom: () => 'Acme Recruiting <no-reply@greenhouse.io>', getSubject: () => 'Update on your application', getPlainBody: () => ACME_REJECTION }],
      { excludedDomains: [] },
      'me@example.com',
    ).action;
    expect(action).toBe('deny');
    const parts = a.REJECTION_CLAUSES.concat(a.REJECTION_FRAME).flat();
    expect(parts.filter((p) => p.strict)).toHaveLength(0);
    const built = parts.filter((p) => p.re);
    expect(built.length).toBeGreaterThan(0);
    const builtChars = built.reduce((n, p) => n + (p.loose ?? p.source).length, 0);
    const wholeChars = parts.reduce((n, p) => n + p.source.length, 0);
    expect(builtChars * 2).toBeLessThan(wholeChars);
    for (const p of built.filter((p) => p.loose)) expect(p.loose!.length).toBeLessThan(p.source.length);
  });

  test('every capture group of a guarded part is a name slot', () => {
    const a = load();
    for (const p of a.REJECTION_CLAUSES.concat(a.REJECTION_FRAME).flat().filter((p) => p.loose)) {
      expect(new RegExp(p.source.split(a.RJ_NAME).join('') + '|').exec('')).toHaveLength(1);
    }
  });

  test('the loose guard only vetoes words the full guard vetoes', () => {
    const a = load();
    const allows = (guard: string, w: string) => new RegExp('^' + guard, 'i').test(w);
    const words = a.RJ_NAME_STOP.split('|').concat(['email', 'e-mail', 'Emailing', 'Contact', 'acme', 'timex', 'opening', 'yourself', 'Atlas', 'Andersen', 'Oracle', 'Mercury', 'Iso']);
    for (const w of words) if (!allows(a.RJ_NAME_LOOSE_GUARD, w)) expect(allows(a.RJ_NAME_GUARD, w)).toBe(false);
  });

  test(
    'loose-first matching gives what the one guarded expression gives',
    () => {
      const a = load();
      const sentences = [
        'Thank you for applying to the Backend Engineer role at Acme',
        'Thank you for applying to the Backend Engineer role at Massive Dynamic',
        'Thank you for applying to the Backend Engineer role at Acme and Co',
        'Thank you for applying to the Backend Engineer role at Open Systems',
        'Thank you for applying to the Backend Engineer role at Kindly Labs',
        'Thank you for applying to the Backend Engineer role at Contact Energy',
        'Thank you for applying to the Backend Engineer role at Emailify',
        'Thank you for applying to the Your Team role at Acme',
        'Thank you for applying to the Backend Engineer role at Acme please reply',
        'We have decided not to move forward with your application',
        'We are considering other candidates for this opening',
        'You have not been selected for this position',
        'We have decided to close this role right now',
      ];
      for (const i of [0, 4]) {
        const full = a.rejectionRegExp_('^(?:' + a.RJ_CLAUSES[i] + ')$');
        for (const s of sentences) expect([i, s, a.shapeMatch_(a.REJECTION_CLAUSES[i], s)]).toEqual([i, s, full.exec(s)]);
      }
    },
    120_000,
  );
});
