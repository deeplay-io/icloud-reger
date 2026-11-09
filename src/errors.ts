export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Другая операция с алиасами (создание или загрузка) ещё идёт в браузере. */
export class AliasBusyError extends ApiError {
  constructor() {
    super(409, 'Операция с алиасами уже выполняется. Дождитесь завершения.');
  }
}

export class AliasRateLimitError extends ApiError {
  constructor(public readonly retryAt: number) {
    super(429, 'Достигнут лимит 5 созданий за 60 минут. Следующее создание доступно после ' + new Date(retryAt).toLocaleTimeString('ru-RU') + '.');
  }
}
