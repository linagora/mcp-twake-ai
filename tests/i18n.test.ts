import { describe, expect, it } from 'vitest';
import { MESSAGES, t } from '../src/i18n.js';

describe('the texts of setup', () => {
  it('exist in English and in French, with the same placeholders', () => {
    expect(Object.keys(MESSAGES.fr).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    for (const key of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
      const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(holes(MESSAGES.fr[key]), key).toEqual(holes(MESSAGES.en[key]));
    }
  });

  it('fill their placeholders', () => {
    expect(t('fr', 'signedInAs', { email: 'jdoe@linagora.com' })).toBe('Connecté en tant que jdoe@linagora.com.');
    expect(t('en', 'signedInAs', { email: 'jdoe@linagora.com' })).toBe('Signed in as jdoe@linagora.com.');
  });
});
