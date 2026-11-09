import { simpleParser } from 'mailparser';
import { MAIL_KINDS, type MailKind, type MailKindRule } from './mailCodeConfig';
import { extractCode, type Extraction } from './patterns';

export interface ParsedMail {
  from: string;
  subject: string;
  /** Текст письма; для HTML-писем mailparser сам переводит HTML в текст. */
  text: string;
}

export async function parseMail(source: Buffer | string): Promise<ParsedMail> {
  const mail = await simpleParser(source, { skipImageLinks: true });
  return { from: mail.from?.text ?? '', subject: mail.subject ?? '', text: mail.text ?? '' };
}

export function matchesRule(mail: ParsedMail, rule: MailKindRule): boolean {
  const test = (pattern: string | undefined, value: string) => !pattern || new RegExp(pattern, 'i').test(value);
  return test(rule.from, mail.from) && test(rule.subject, mail.subject) && test(rule.mustContain, mail.subject + '\n' + mail.text);
}

/** Вид письма, если оно подходит под правило ровно одного вида; иначе null — такое письмо не отдаём. */
export function mailKind(mail: ParsedMail, kinds: Record<MailKind, MailKindRule>): MailKind | null {
  const matched = MAIL_KINDS.filter(kind => matchesRule(mail, kinds[kind]));
  return matched.length === 1 ? matched[0] : null;
}

/** Код ищется и в теме: некоторые сервисы пишут его прямо туда. */
export function mailCode(mail: ParsedMail, rule: MailKindRule): Extraction | null {
  return extractCode(mail.subject + '\n' + mail.text, rule.patterns);
}

/**
 * Код из письма запрошенного вида. undefined — письмо не этого вида; null — этого, но код не вырезан
 * или письмо подходит и под другой вид (не угадываем).
 */
export function kindCode(mail: ParsedMail, kind: MailKind, kinds: Record<MailKind, MailKindRule>): Extraction | null | undefined {
  if (!matchesRule(mail, kinds[kind])) return undefined;
  return mailKind(mail, kinds) === kind ? mailCode(mail, kinds[kind]) : null;
}
