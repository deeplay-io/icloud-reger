import type { MailCodeConfig, MailKind } from './mailCodeConfig';
import type { FindResult } from './mailboxes';
import { kindCode } from './mailKinds';

/** skipped — ящик родителя читает IMAP; later — в этот раз не смотрели (недавно смотрели или браузер занят). */
export type BrowserFindResult = FindResult | { status: 'skipped' } | { status: 'later' };

interface MailMessage {
  from: string;
  subject: string;
  text: string;
  receivedAt: number;
}

/** Ошибка браузерного пути; parent известен, если основной сервис нашёл алиас в базе. */
export class BrowserMailError extends Error {
  constructor(message: string, readonly parent = '') {
    super(message);
  }
}

// Проход по письмам кликает до code.maxMessagesToScan писем, каждое ждёт загрузки.
const REQUEST_TIMEOUT_MS = 90 * 1000;

/** Запасной путь: письма из iCloud Mail через браузер основного сервиса (POST /mail/messages). */
export class BrowserMail {
  private lastPass = new Map<string, number>();
  /** Ошибка последнего прохода по алиасу: до следующего прохода повторяется, а не превращается в «писем нет». */
  private lastFailure = new Map<string, BrowserMailError>();

  constructor(
    private cfg: MailCodeConfig,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async find(email: string, kind: MailKind, sentAfterMs: number, skipParents: string[]): Promise<BrowserFindResult> {
    const last = this.lastPass.get(email);
    if (last !== undefined && this.now() - last < this.cfg.browser.pollIntervalMs) {
      const failure = this.lastFailure.get(email);
      if (failure) throw failure;
      return { status: 'later' };
    }
    this.lastPass.set(email, this.now());
    try {
      const result = await this.pass(email, kind, sentAfterMs, skipParents);
      if (result.status !== 'later') this.lastFailure.delete(email);
      return result;
    } catch (error) {
      if (error instanceof BrowserMailError) {
        if (this.lastFailure.size >= 1000) this.lastFailure.clear();
        this.lastFailure.set(email, error);
      }
      throw error;
    }
  }

  private async pass(email: string, kind: MailKind, sentAfterMs: number, skipParents: string[]): Promise<BrowserFindResult> {
    const url = this.cfg.browser.apiUrl + '/mail/messages';
    // Правило вида без вырезания кода: основной сервис остановится на самом новом подходящем письме.
    const { from, subject, mustContain } = this.cfg.kinds[kind];
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, sentAfterMs, skipParents, match: { from, subject, mustContain } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new BrowserMailError(`основной сервис ${this.cfg.browser.apiUrl} недоступен (запущен ли «Запустить сервис»?): ${error instanceof Error ? error.message : error}`);
    }
    const body = await res.json().catch(() => ({})) as { error?: string; parent?: string; skipped?: boolean; messages?: MailMessage[] };
    // В браузере идёт создание алиаса или другое чтение: посмотрим в следующий раз.
    if (res.status === 409) return { status: 'later' };
    if (!res.ok) throw new BrowserMailError(body.error || `HTTP ${res.status}`, body.parent);
    if (body.skipped) {
      this.lastPass.delete(email);
      return { status: 'skipped' };
    }
    for (const message of body.messages ?? []) {
      const extracted = kindCode(message, kind, this.cfg.kinds);
      if (extracted === undefined) continue;
      return extracted
        ? { status: 'found', code: extracted.code, receivedAt: message.receivedAt, subject: message.subject }
        : { status: 'unparsed', receivedAt: message.receivedAt, subject: message.subject };
    }
    return { status: 'none' };
  }
}
