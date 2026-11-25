export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, init);
}

export function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
