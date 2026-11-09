import test from 'node:test';
import assert from 'node:assert/strict';
import { pageDateToUtc, parseMailDate, readHeaderFields } from './codeReader';

test('German iCloud interface (Dolphin profile with de-DE)', () => {
  const header = readHeaderFields([
    { label: 'Von:', value: 'Sender relay_at_gmail_com_x@icloud.com' },
    { label: 'Betreff:', value: 'Verify your email' },
    { label: 'Datum:', value: '9. November 2026 um 7:59:39' },
    { label: 'An:', value: 'Hide My Email two_words_alias@icloud.com' },
    { label: 'Kopie:', value: 'copy@icloud.com' },
  ]);
  assert.deepEqual(header.recipients, ['two_words_alias@icloud.com', 'copy@icloud.com']);
  assert.equal(header.subject, 'Verify your email');
  assert.match(header.from, /relay_at_gmail/);
  assert.equal(header.date, new Date(2026, 10, 9, 7, 59, 39).getTime());
  assert.equal(parseMailDate('3. März 2026 um 10:01'), new Date(2026, 2, 3, 10, 1).getTime());
  assert.equal(parseMailDate('9 November 2026 at 07:59:39'), new Date(2026, 10, 9, 7, 59, 39).getTime());
});

test('sender is read from От кого / From', () => {
  assert.equal(readHeaderFields([{ label: 'От кого:', value: 'GGPass no-reply@ggpass.example' }]).from, 'GGPass no-reply@ggpass.example');
  assert.equal(readHeaderFields([{ label: 'From:', value: 'GGPass' }]).from, 'GGPass');
});

test('time shown in the browser time zone is converted to UTC; explicit zones are kept', () => {
  const text = '9 ноября 2026 г. в 12:05:06';
  const parsed = parseMailDate(text)!;
  // Браузер в UTC+7 (getTimezoneOffset = -420): 12:05:06 там — это 05:05:06 UTC.
  assert.equal(pageDateToUtc(text, parsed, -420), Date.UTC(2026, 10, 9, 5, 5, 6));
  const gmt = 'Mon, 09 Nov 2026 12:05:06 GMT';
  assert.equal(pageDateToUtc(gmt, parseMailDate(gmt)!, -420), Date.UTC(2026, 10, 9, 12, 5, 6));
});

test('recipient matching reads only To/Cc headers and normalizes complete addresses', () => {
  const header = readHeaderFields([
    { label: 'От кого:', value: 'target@icloud.com' },
    { label: 'Кому:', value: 'Other <not-target@icloud.com>' },
    { label: 'Копия:', value: 'Copy <COPY@icloud.com>' },
    { label: 'Тема:', value: 'target@icloud.com verification' },
    { label: 'Дата:', value: '30 октября 2026 г. в 19:05:06' },
  ]);
  assert.deepEqual(header.recipients, ['not-target@icloud.com', 'copy@icloud.com']);
  assert.equal(header.date, new Date(2026, 9, 30, 19, 5, 6).getTime());
});

test('supports English headers and rejects missing or invalid dates', () => {
  const header = readHeaderFields([
    { label: 'To:', value: 'Alias <alias@private.icloud.com>' },
    { label: 'Subject:', value: 'Verification' },
    { label: 'Date:', value: 'Fri, 30 Oct 2026 12:05:06 GMT' },
  ]);
  assert.deepEqual(header.recipients, ['alias@private.icloud.com']);
  assert.equal(header.date, Date.UTC(2026, 9, 30, 12, 5, 6));
  assert.equal(parseMailDate(''), null);
  assert.equal(parseMailDate('31 февраля 2026 г. в 19:05:06'), null);
  assert.equal(parseMailDate('30 октября 2026 г. в 27:05:06'), null);
});

test('Hide My Email display name is separate from the exact recipient address', () => {
  const header = readHeaderFields([
    { label: 'Кому:', value: 'Hide My Email quiet-river-3x@icloud.com' },
    { label: 'От кого:', value: 'Sender sender@icloud.com' },
  ]);
  assert.deepEqual(header.recipients, ['quiet-river-3x@icloud.com']);
  assert.ok(!header.recipients.includes('emailquiet-river-3x@icloud.com'));
});
