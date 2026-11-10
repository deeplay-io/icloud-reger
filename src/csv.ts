/** Поле CSV по RFC 4180: в кавычках, если в нём запятая, кавычка или перевод строки (метки из iCloud задаёт человек). */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Таблица в CSV: разделитель — запятая, строки через CRLF, последняя строка тоже завершена. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row.map(csvField).join(',') + '\r\n').join('');
}
