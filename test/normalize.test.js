import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompanyName, phoneKey } from '../server/crm/normalize.js';

test('legal suffixes, prefixes, case and punctuation are ignored', () => {
  const same = [
    'ABC Engineering Pvt. Ltd.',
    'M/s. ABC Engineering Private Limited',
    'abc engineering',
    '  ABC   ENGINEERING (P) LTD ',
    'The ABC Engineering Co.',
  ];
  for (const name of same) assert.equal(normalizeCompanyName(name), 'abc engineering', name);
});

test('meaningful words and ampersands are kept', () => {
  assert.equal(normalizeCompanyName('Sri Venkateswara Steels & Alloys'), 'sri venkateswara steels and alloys');
  assert.equal(normalizeCompanyName('Café Résumé Industries'), 'cafe resume industries');
});

test('a name made only of legal words does not become empty', () => {
  assert.equal(normalizeCompanyName('The Company'), 'the company');
});

test('phone numbers compare on their last 10 digits', () => {
  assert.equal(phoneKey('+91 98765 43210'), '9876543210');
  assert.equal(phoneKey('098765-43210'), '9876543210');
  assert.equal(phoneKey('12'), null);
  assert.equal(phoneKey(null), null);
});
