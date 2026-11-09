import type { FindCode } from './mailCode';
import type { FindResult } from './mailboxes';
import type { MailKind } from './mailCodeConfig';
import { BrowserMailError, type BrowserFindResult } from './browserMail';

export interface ImapSource {
  find(email: string, kind: MailKind, sentAfterMs: number): Promise<FindResult>;
  healthyEmails(): string[];
}
export interface BrowserSource {
  find(email: string, kind: MailKind, sentAfterMs: number, skipParents: string[]): Promise<BrowserFindResult>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * IMAP — основной путь, браузер — запасной: для алиасов, чей родитель не читается по IMAP
 * (нет пароля в mail-code.json, отказ во входе, нет сети). Основной сервис сам пропускает
 * родителей из исправных IMAP-ящиков, поэтому браузер открывается только когда нужен.
 */
export function combineSources(imap: ImapSource | null, browser: BrowserSource | null): FindCode {
  return async (email, kind, sentAfterMs) => {
    let imapError = '';
    if (imap) {
      try {
        const found = await imap.find(email, kind, sentAfterMs);
        if (found.status !== 'none' || !browser) return found;
      } catch (error) {
        if (!browser) throw error;
        imapError = message(error);
      }
    }
    if (!browser) throw new Error('в mail-code.json не задан ни один IMAP-аккаунт, а чтение через браузер выключено (browser.enabled)');
    try {
      const found = await browser.find(email, kind, sentAfterMs, imap ? imap.healthyEmails() : []);
      return found.status === 'skipped' || found.status === 'later' ? { status: 'none' } : found;
    } catch (error) {
      // IMAP исправно просмотрел все ящики, а родителя алиаса браузер не определил (основной сервис
      // недоступен, алиаса нет в базе): письма, скорее всего, просто ещё нет — это не сбой.
      if (imap && !imapError && !(error instanceof BrowserMailError && error.parent)) return { status: 'none' };
      throw new Error((imapError ? `IMAP: ${imapError}; ` : '') + `браузер: ${message(error)}`);
    }
  };
}
