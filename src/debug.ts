import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';

/** Снимает html + видимый текст + скриншот страницы в debug/. Возвращает список файлов. */
export async function dumpDebug(dir: string, label: string, page: Page): Promise<string[]> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(dir, `${ts}-${label}`);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  try {
    writeFileSync(`${base}.html`, await page.content());
    files.push(`${base}.html`);
  } catch { /* ignore */ }
  try {
    writeFileSync(`${base}.txt`, await page.evaluate(() => document.body?.innerText ?? ''));
    files.push(`${base}.txt`);
  } catch { /* ignore */ }
  try {
    await page.screenshot({ path: `${base}.png` });
    files.push(`${base}.png`);
  } catch { /* ignore */ }
  return files;
}
