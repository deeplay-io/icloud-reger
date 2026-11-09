import { setTimeout as sleep } from 'node:timers/promises';
import { MAIL_KINDS, type MailCodeConfig, type MailKind } from './mailCodeConfig';
import type { FindResult } from './mailboxes';

/** Поля GetCodeRequest / GetCodeResponse из mail_code.proto (proto-loader с keepCase и enums: String). */
export interface GetCodeRequest {
  email: string;
  kind: string;
  sent_after_unix_ms: number;
  wait_seconds: number;
  session_id: string;
}
export type GetCodeResult =
  | 'GET_CODE_RESULT_SUCCESS'
  | 'GET_CODE_RESULT_NOT_FOUND'
  | 'GET_CODE_RESULT_UNKNOWN_MAILBOX'
  | 'GET_CODE_RESULT_FAIL';
export interface GetCodeResponse {
  result: GetCodeResult;
  code: string;
  received_at_unix_ms: number;
  subject: string;
  error_message: string;
}

export type FindCode = (email: string, kind: MailKind, sentAfterMs: number) => Promise<FindResult>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY = { code: '', received_at_unix_ms: 0, subject: '', error_message: '' };
const fail = (error_message: string): GetCodeResponse => ({ ...EMPTY, result: 'GET_CODE_RESULT_FAIL', error_message });

/**
 * GetCode из mail_code.proto: проверяет запрос и ищет письмо, пока оно не придёт,
 * не выйдет wait_seconds или клиент не отменит вызов (signal).
 */
export async function getCode(req: GetCodeRequest, cfg: MailCodeConfig, find: FindCode, signal: AbortSignal): Promise<GetCodeResponse> {
  const email = (req.email ?? '').trim().toLowerCase();
  if (!email) return fail('email обязателен');
  if (!EMAIL_RE.test(email)) return fail(`некорректный email: ${email}`);
  const domain = email.split('@')[1];
  if (!cfg.domains.includes(domain)) {
    return { ...EMPTY, result: 'GET_CODE_RESULT_UNKNOWN_MAILBOX', error_message: `ящики @${domain} сервис не обслуживает, только @${cfg.domains.join(', @')}` };
  }
  if (!MAIL_KINDS.includes(req.kind as MailKind)) return fail(`kind обязателен: ${MAIL_KINDS.join(' или ')}`);
  const kind = req.kind as MailKind;
  const sentAfter = Math.max(0, Number(req.sent_after_unix_ms) || 0);
  const wait = Math.min(Math.max(0, Number(req.wait_seconds) || 0), cfg.grpc.maxWaitSeconds);
  const deadline = Date.now() + wait * 1000;
  let lastError = '';
  for (;;) {
    try {
      const found = await find(email, kind, sentAfter);
      lastError = '';
      if (found.status === 'found') {
        return { ...EMPTY, result: 'GET_CODE_RESULT_SUCCESS', code: found.code, received_at_unix_ms: found.receivedAt, subject: found.subject };
      }
      if (found.status === 'unparsed') {
        return fail(`письмо «${found.subject}» (${new Date(found.receivedAt).toISOString()}) найдено, но не разобрано: код не вырезан или письмо подходит под оба вида — проверьте правила kinds`);
      }
    } catch (e) {
      // Сбой IMAP может быть временным: ждём дальше, а если так и не прошло — FAIL, а не NOT_FOUND.
      lastError = e instanceof Error ? e.message : String(e);
    }
    const left = deadline - Date.now();
    if (left <= 0 || signal.aborted) break;
    try {
      await sleep(Math.min(cfg.grpc.pollIntervalMs, left), undefined, { signal });
    } catch {
      break;
    }
  }
  return lastError ? fail(lastError) : { ...EMPTY, result: 'GET_CODE_RESULT_NOT_FOUND' };
}
