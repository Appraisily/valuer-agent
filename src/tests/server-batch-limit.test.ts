import { describe, expect, it } from 'vitest';

process.env.SCRAPER_DB_URL ||= 'postgres://user:pass@127.0.0.1:5432/valuer_test';
process.env.MESSAGE_TRANSPORT ||= 'disabled';

async function postJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

describe('Valuer Bridge batch limits', () => {
  it('rejects combined term arrays that exceed the total work cap before running searches', async () => {
    const { app } = await import('../server.js');
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');

    try {
      const terms = Array.from({ length: 10 }, (_, index) => `term ${index}`);
      const { response, body } = await postJson(`http://127.0.0.1:${address.port}`, '/v2/search/batch', {
        terms: {
          very_specific: terms,
          specific: terms,
          moderate: terms,
        },
      });

      expect(response.status).toBe(400);
      expect(body.error).toBe('too_many_terms');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
