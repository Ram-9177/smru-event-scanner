/** The data layer: every server read goes through TanStack Query, keyed by its API path. */
import { QueryClient, useQuery, type Query, type UseQueryOptions } from '@tanstack/react-query';
import { api, ApiError, type ApiOptions } from './api';

export type ApiKey = readonly ['api', string];
export const apiKey = (path: string): ApiKey => ['api', path];

/** Answers that will not change by asking again. */
const FINAL = [401, 403, 404];

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failures, err) => !(err instanceof ApiError && FINAL.includes(err.status)) && failures < 1,
        staleTime: 5_000,
        // The admin console refreshes when the organiser comes back to its tab; student screens stay as they are.
        refetchOnWindowFocus: (q) => typeof q.queryKey[1] === 'string' && q.queryKey[1].startsWith('/admin/'),
      },
      mutations: { retry: false },
    },
  });
}

type ApiQueryOptions<T> = Omit<UseQueryOptions<T, Error, T, ApiKey>, 'queryKey' | 'queryFn'>;

/** Read one API path. `init` is for the few reads the server takes as a POST (the student session). */
export function useApi<T>(path: string, options: ApiQueryOptions<T> = {}, init?: ApiOptions) {
  return useQuery({ queryKey: apiKey(path), queryFn: () => api<T>(path, init), ...options });
}

/** Matches the queries for a path and everything under it: `/admin/events/1` also matches `/admin/events/1/media?...`. */
export function under(path: string) {
  return {
    predicate: (q: Query) => {
      const [scope, p] = q.queryKey;
      return scope === 'api' && typeof p === 'string' && (p === path || p.startsWith(`${path}/`) || p.startsWith(`${path}?`));
    },
  };
}
