import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';

export interface Call {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}
type Answer = { status?: number; body?: unknown };
type Reply = Answer | ((call: Call) => Answer | Promise<Answer>);

/**
 * Replaces fetch with fixed answers, keyed "METHOD /path" (the path without /api; a key without the query string
 * matches any query). Anything else gets a 404 the way the server sends it.
 */
export function mockFetch(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace(/^\/api/, '');
    const method = init.method ?? 'GET';
    const call: Call = { method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const reply = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
    const out: Answer = !reply ? { status: 404, body: { error: 'not_found', message: `No mock for ${method} ${path}` } } : typeof reply === 'function' ? await reply(call) : reply;
    return new Response(JSON.stringify(out.body ?? { ok: true }), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls, called: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key) };
}

/** Shows where the router is, so tests can check navigation. */
function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

/** Renders routes at a URL with a fresh query cache that does not retry. */
export function renderAt(url: string, routes: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>{routes}</Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, user, client };
}
