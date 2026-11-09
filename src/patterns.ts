import type { CodePattern } from './config';

export interface Extraction {
  code: string;
  pattern: string;
}

/**
 * Пробует паттерны по порядку; возвращает первый, который вырезает код
 * из 4–6 цифр. mustContain — фильтр «а вообще письмо про код?».
 */
export function extractCode(body: string, patterns: CodePattern[]): Extraction | null {
  for (const p of patterns) {
    try {
      if (p.mustContain && !new RegExp(p.mustContain, 'i').test(body)) continue;
      const m = body.match(new RegExp(p.regex, 'i'));
      const code = m?.[1] ?? m?.[0];
      if (code && /^\d{4,6}$/.test(code)) return { code, pattern: p.name };
    } catch {
      // кривой regex в конфиге — пропускаем
    }
  }
  return null;
}
