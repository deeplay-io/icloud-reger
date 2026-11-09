// Проверка IMAP-доступа к ящикам родителей и сбор образцов писем:
//   npm run imap:probe
//   npm run imap:probe -- --account parent@icloud.com --alias xyz@icloud.com --days 7 --save
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { MessageAddressObject } from 'imapflow';
import { loadMailCodeConfig, MAIL_KINDS, type MailCodeConfig } from './mailCodeConfig';
import { Mailboxes, type Mailbox } from './mailboxes';
import { mailCode, mailKind } from './mailKinds';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (value: Date | string | number | undefined) => value === undefined ? '?' : new Date(value).toISOString().replace('.000Z', 'Z');
const addresses = (list: MessageAddressObject[] | undefined) => (list ?? []).map(a => a.address).join(', ') || '—';
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

async function listRecent(box: Mailbox, last: number): Promise<void> {
  const { client, folders } = await box.open();
  console.log('папки:');
  for (const folder of await client.list()) {
    const status = await client.status(folder.path, { messages: true }).catch(() => false as const);
    console.log(`  ${folder.path}${folder.specialUse ? ' ' + folder.specialUse : ''}: ${status ? status.messages : '?'} писем`);
  }
  console.log(`сервис ищет в: ${folders.join(', ')}`);
  for (const folder of folders) {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const total = client.mailbox ? client.mailbox.exists : 0;
      console.log(`\n${folder}: последние ${Math.min(last, total)} из ${total} (время прихода на сервер, UTC)`);
      if (!total) continue;
      for await (const msg of client.fetch(`${Math.max(1, total - last + 1)}:*`, { uid: true, envelope: true, internalDate: true })) {
        console.log(`  ${iso(msg.internalDate)}  от ${addresses(msg.envelope?.from)}  кому ${addresses(msg.envelope?.to)}  «${msg.envelope?.subject ?? ''}»`);
      }
    } finally { lock.release(); }
  }
}

async function probeAlias(cfg: MailCodeConfig, boxes: Mailboxes, box: Mailbox, alias: string, days: number, save: boolean): Promise<void> {
  const since = Date.now() - days * DAY_MS;
  const { client, folders } = await box.open();
  const candidates = await box.candidates(alias, since);
  console.log(`\nписьма на ${alias} за ${days} дн. (фильтр сервиса по To/Cc/Delivered-To/X-Original-To): ${candidates.length}`);

  // Сверка с серверным SEARCH TO: на нём держится запрос без sent_after.
  for (const folder of folders) {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const server = (await client.search({ to: alias, since: new Date(since) }, { uid: true })) || [];
      const local = candidates.filter(c => c.folder === folder).map(c => c.uid);
      const onlyServer = server.filter(uid => !local.includes(uid));
      const onlyLocal = local.filter(uid => !server.includes(uid));
      console.log(`  ${folder}: SEARCH TO на сервере — ${server.length}, фильтр сервиса — ${local.length}` +
        (onlyServer.length || onlyLocal.length ? `; расхождение: только сервер ${onlyServer.join(',') || '—'}, только фильтр ${onlyLocal.join(',') || '—'}` : ''));
      if (!local.length) continue;
      for await (const msg of client.fetch(local, { uid: true, headers: ['to', 'cc', 'delivered-to', 'x-original-to'] }, { uid: true })) {
        console.log(`  UID ${msg.uid}:\n    ${msg.headers?.toString('utf8').trim().split(/\r?\n/).join('\n    ')}`);
      }
    } finally { lock.release(); }
  }

  const dir = path.resolve('debug', 'mail-samples', alias);
  for (const candidate of [...candidates].sort((a, b) => b.receivedAt - a.receivedAt)) {
    const mail = await box.read(candidate);
    const kind = mailKind(mail, cfg.kinds);
    const code = kind ? mailCode(mail, cfg.kinds[kind]) : null;
    console.log(`\n  ${iso(candidate.receivedAt)} ${candidate.folder}/${candidate.uid} от ${mail.from}\n  тема: «${mail.subject}»\n  вид: ${kind ?? 'не определён (подходит под оба правила или ни под одно)'}; код: ${code ? `${code.code} (паттерн ${code.pattern})` : '—'}`);
    console.log('  текст: ' + mail.text.replace(/\s+/g, ' ').trim().slice(0, 400));
    if (save) {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${iso(candidate.receivedAt).replace(/[:]/g, '-')}-${candidate.folder.replace(/\W+/g, '_')}-${candidate.uid}.eml`);
      writeFileSync(file, await box.source(candidate.folder, candidate.uid));
      console.log(`  сохранено: ${file}`);
    }
  }

  console.log(`\nчто вернёт сервис для ${alias}:`);
  for (const kind of MAIL_KINDS) {
    for (const [label, sentAfter] of [['sent_after=0', 0], [`sent_after=${days} дн. назад`, since]] as const) {
      const result = await boxes.find(alias, kind, sentAfter).catch(e => ({ status: 'error', error: message(e) }));
      console.log(`  ${kind}, ${label}: ${JSON.stringify(result)}`);
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      alias: { type: 'string' },
      days: { type: 'string', default: '7' },
      last: { type: 'string', default: '10' },
      save: { type: 'boolean', default: false },
    },
  });
  const cfg = loadMailCodeConfig();
  const boxes = new Mailboxes(cfg, () => {});
  const account = values.account?.toLowerCase();
  const selected = account ? boxes.boxes.filter(box => box.account.email === account) : boxes.boxes;
  if (!selected.length) throw new Error(account ? `аккаунта ${account} нет в imap.accounts` : 'в imap.accounts нет ни одного аккаунта');
  try {
    for (const box of selected) {
      const { email, user, proxy } = box.account;
      console.log(`\n=== ${email} (логин ${user || email}${proxy ? ', через прокси' : ''}, ${cfg.imap.host}:${cfg.imap.port})`);
      try {
        await box.open();
        console.log('вход: OK');
      } catch (e) {
        console.log(`вход: ОШИБКА — ${message(e)}`);
        console.log('  Нужен app-specific пароль (account.apple.com → Вход и безопасность → Пароли приложений), а не обычный пароль Apple ID.');
        console.log('  Если пароль верный, попробуйте в "user" только имя ящика без @icloud.com.');
        continue;
      }
      await listRecent(box, Number(values.last));
      if (values.alias) await probeAlias(cfg, boxes, box, values.alias.trim().toLowerCase(), Number(values.days), values.save!);
    }
  } finally {
    await boxes.close();
  }
}

main().catch(error => {
  console.error(message(error));
  process.exit(1);
});
