export function validAliasPrefix(prefix: string): boolean {
  return /^[\p{L}\p{N}_.-]{1,60}$/u.test(prefix);
}

export function nextAliasName(names: string[], prefix: string): string {
  if (!validAliasPrefix(prefix)) throw new Error('Имя должно содержать 1–60 букв, цифр, точек, дефисов или подчёркиваний, без @icloud.com.');
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^' + escaped + '(\\d+)(?:@icloud\\.com)?$', 'i');
  let maximum = 0;
  for (const name of names) {
    const match = name.trim().match(pattern);
    const number = match ? Number(match[1]) : 0;
    if (Number.isSafeInteger(number)) maximum = Math.max(maximum, number);
  }
  return prefix + (maximum + 1);
}
