import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_CODE_DEFAULTS } from './mailCodeConfig';
import { mailCode, mailKind, parseMail } from './mailKinds';

const kinds = MAIL_CODE_DEFAULTS.kinds;
const eml = (subject: string, contentType: string, body: string) => [
  'From: GGPass <no-reply@ggpass.example>',
  'To: alias@icloud.com',
  `Subject: ${subject}`,
  `Content-Type: ${contentType}; charset=utf-8`,
  '',
  body,
].join('\r\n');

test('parses plain text and HTML-only messages', async () => {
  const plain = await parseMail(eml('Verify your email', 'text/plain', 'Your verification code is 048213.'));
  assert.equal(plain.subject, 'Verify your email');
  assert.match(plain.from, /no-reply@ggpass\.example/);
  assert.match(plain.text, /048213/);
  const html = await parseMail(eml('Verify your email', 'text/html', '<p>Your code: <b>731904</b></p>'));
  assert.match(html.text, /Your code: 731904/);
});

test('message kind must match exactly one rule', () => {
  const mail = (subject: string) => ({ from: '', subject, text: '' });
  assert.equal(mailKind(mail('Verify your email'), kinds), 'CODE_KIND_SIGN_UP');
  assert.equal(mailKind(mail('Your 2FA code'), kinds), 'CODE_KIND_MFA');
  assert.equal(mailKind(mail('Verify your login'), kinds), null);
  assert.equal(mailKind(mail('Welcome to GGPass'), kinds), null);
});

test('draft code pattern keeps leading zeros and ignores unrelated numbers', () => {
  const rule = kinds.CODE_KIND_SIGN_UP;
  assert.equal(mailCode({ from: '', subject: 'Verify', text: 'Your verification code is 048213. © 2026' }, rule)?.code, '048213');
  assert.equal(mailCode({ from: '', subject: 'Verify', text: '© 2026 GGPass, office 123456 Main St.' }, rule), null);
  assert.equal(mailCode({ from: '', subject: 'Verify', text: 'code 1234567' }, rule), null);
});
