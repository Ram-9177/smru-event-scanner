import type { Mail } from '../lib/mail.js';
import type { Found } from './alerts.js';

/**
 * The alert emails, as plain text (feature C, contract: bigger-contract.md). Owner: server-admin.
 * Subjects: "Event Photos: <title>", "Fixed: <title>", "Event Photos: N uploads to approve, M open requests",
 * "Event Photos: test email". Every one ends with the line that says why it came and how to stop it.
 */

export interface DigestData {
  /** Per event with uploads waiting for approval. */
  waiting: { event: string; count: number }[];
  /** Open requests: reports and removal requests. */
  reports: number;
  removals: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The last line of every alert email. */
export const signature = (to: string) => `You get this because email alerts are on for ${to}. Turn them off in the console: Settings, Alerts and storage.`;

const link = (consoleUrl: string) => `Open the console: ${consoleUrl}`;

export function alertStartedMail(to: string, a: Pick<Found, 'title' | 'detail'>, consoleUrl: string): Mail {
  const text = [a.title, '', ...(a.detail ? [a.detail, ''] : []), link(consoleUrl), '', signature(to)].join('\n');
  return { to, subject: `Event Photos: ${a.title}`, text };
}

export function alertClearedMail(to: string, a: Pick<Found, 'title'>, consoleUrl: string): Mail {
  const text = [`This is fixed now: ${a.title}.`, '', link(consoleUrl), '', signature(to)].join('\n');
  return { to, subject: `Fixed: ${a.title}`, text };
}

export function digestMail(to: string, d: DigestData, consoleUrl: string): Mail {
  const uploads = d.waiting.reduce((n, w) => n + w.count, 0);
  const requests = d.reports + d.removals;
  const lines = [
    ...d.waiting.filter((w) => w.count > 0).map((w) => `${w.event}: ${w.count} waiting for approval`),
    ...(d.reports > 0 ? [`Reports from students: ${d.reports}`] : []),
    ...(d.removals > 0 ? [`Removal requests: ${d.removals}`] : []),
  ];
  const text = [...lines, '', link(consoleUrl), '', signature(to)].join('\n');
  return { to, subject: `Event Photos: ${plural(uploads, 'upload', 'uploads')} to approve, ${plural(requests, 'open request', 'open requests')}`, text };
}

export function testMail(to: string, consoleUrl: string): Mail {
  const text = ['This is a test email from Event Photos. Alerts will reach you at this address.', '', link(consoleUrl), '', signature(to)].join('\n');
  return { to, subject: 'Event Photos: test email', text };
}
