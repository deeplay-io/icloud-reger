export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class AliasRateLimitError extends ApiError {
  constructor(public readonly retryAt: number) {
    super(429, 'Достигнут лимит 5 созданий за 60 минут. Следующее создание доступно после ' + new Date(retryAt).toLocaleTimeString('ru-RU') + '.');
  }
}
