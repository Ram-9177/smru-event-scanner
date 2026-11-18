import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * express.Router for Express 4 with async handlers: a handler that returns a rejected promise passes the error
 * to the error handler (Express 4 itself would leave the request hanging). Error handlers (4 arguments) are
 * left as they are.
 */
export type Router = express.Router;
export function Router(): express.Router {
  const r = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'] as const) {
    const original = (r as any)[method].bind(r);
    (r as any)[method] = (...args: unknown[]) => original(...args.map((a) => (typeof a === 'function' ? wrap(a as Handler) : a)));
  }
  return r;
}

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

function wrap(fn: Handler): Handler {
  if (fn.length === 4 || (fn as any).stack /* a router */) return fn;
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out && typeof (out as Promise<unknown>).then === 'function') (out as Promise<unknown>).catch(next);
    } catch (e) {
      next(e);
    }
  };
}
