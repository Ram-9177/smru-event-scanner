import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** True when an SMTP server is set, so messages really leave. */
  configured: boolean;
  /** Send one message. Resolves true when it was handed to the SMTP server. Never throws: a failed email is logged. */
  send(mail: Mail): Promise<boolean>;
}

/**
 * Outgoing email through Nodemailer. With SMTP_URL set (smtp://user:pass@host:587 or smtps://...:465) messages
 * are sent. Without it they are written as .eml files to <data>/outbox and the console says so, so nothing is
 * lost on a computer with no mail server.
 */
export function createMailer(cfg: Pick<Config, 'smtpUrl' | 'mailFrom' | 'dataDir'>, log: (msg: string) => void): Mailer {
  if (cfg.smtpUrl) {
    const transport = nodemailer.createTransport(cfg.smtpUrl);
    return {
      configured: true,
      async send(m) {
        try {
          await transport.sendMail({ from: cfg.mailFrom, to: m.to, subject: m.subject, text: m.text });
          return true;
        } catch (e) {
          log(`email to ${m.to} could not be sent: ${(e as Error).message}`);
          return false;
        }
      },
    };
  }
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const outbox = path.join(cfg.dataDir, 'outbox');
  return {
    configured: false,
    async send(m) {
      try {
        const info = await transport.sendMail({ from: cfg.mailFrom, to: m.to, subject: m.subject, text: m.text });
        fs.mkdirSync(outbox, { recursive: true });
        const file = path.join(outbox, `${new Date().toISOString().replace(/[:.]/g, '-')}-${m.to.replace(/[^a-z0-9@._-]/gi, '_')}.eml`);
        fs.writeFileSync(file, info.message as Buffer, { mode: 0o600 });
        log(`no SMTP_URL set: the email "${m.subject}" to ${m.to} was saved to ${file} instead of sent`);
      } catch (e) {
        log(`email to ${m.to} could not be saved: ${(e as Error).message}`);
      }
      return false;
    },
  };
}
