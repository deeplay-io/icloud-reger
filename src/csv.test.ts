import test from 'node:test';
import assert from 'node:assert/strict';
import { csvField, toCsv } from './csv';

test('csvField quotes only fields with a comma, a quote or a line break', () => {
  assert.equal(csvField('box1'), 'box1');
  assert.equal(csvField('Почта, банк'), '"Почта, банк"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField('cr\rhere'), '"cr\rhere"');
  assert.equal(csvField(''), '');
});

test('toCsv joins fields with commas and ends every row with CRLF', () => {
  assert.equal(toCsv([['alias', 'parent'], ['a@icloud.com', 'p@icloud.com']]), 'alias,parent\r\na@icloud.com,p@icloud.com\r\n');
  assert.equal(toCsv([]), '');
});
