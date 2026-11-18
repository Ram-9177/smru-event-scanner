/**
 * Imported first by index.ts, before anything starts work on Node's thread pool (file reads, crypto, sharp). The pool
 * has 4 threads by default, and one photo being decoded or encoded by sharp holds one for its whole run: with a few
 * full-size photos in work, every thumbnail read waited seconds. 16 keeps reads moving (UV_THREADPOOL_SIZE wins).
 */
process.env.UV_THREADPOOL_SIZE ||= '16';
export {};
