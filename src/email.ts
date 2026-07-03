/**
 * SMTP email — same setup as the FS AI Review backend (Hostinger SMTP, native
 * transport, best-effort admin notifications). Env-gated: does nothing unless
 * SMTP is configured, and never throws (email must never block a request).
 *
 * Env:
 *   SMTP_HOST, SMTP_PORT (465 SSL / 587 STARTTLS), SMTP_USER, SMTP_PASS,
 *   EMAIL_FROM (defaults to SMTP_USER), ADMIN_NOTIFY_EMAIL (defaults to SMTP_USER).
 */
import nodemailer from 'nodemailer';

export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transport() {
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 upgrades via STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15_000,
  });
}

/** Fire-and-forget admin notification. Silently no-ops when SMTP is unconfigured. */
export async function notifyAdmin(subject: string, body: string): Promise<void> {
  if (!emailConfigured()) return;
  const to = process.env.ADMIN_NOTIFY_EMAIL || process.env.SMTP_USER!;
  try {
    await transport().sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: body,
    });
  } catch {
    // best-effort — a mail failure must never surface to the user or block the flow
  }
}
