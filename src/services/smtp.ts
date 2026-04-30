/**
 * SMTP service — wraps Nodemailer for outbound email.
 *
 * Provides sendEmail(), verifyConnection(), and disconnect().
 * The Send Engine calls this; it never touches Nodemailer directly.
 *
 * Reference: specs/SEND_ENGINE.md (SMTP section)
 */

import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { config } from "../config/index.js";
import { logger } from "../logging/logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** The shape of an outbound email message. */
export interface EmailMessage {
  to: string;
  from: { name: string; address: string };
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

/** The result returned after a successful send. */
export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

/** Input payload for forwarding a reply to human review. */
export interface ForwardReplyInput {
  contactEmail: string;
  fromEmail: string;
  subject: string;
  body: string;
  forwardTo?: string;
}

// ─── Transporter (lazy singleton) ────────────────────────────────────────────

let transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | null =
  null;

/**
 * Returns the Nodemailer transporter, creating it on first call.
 * Uses STARTTLS on port 587 for Microsoft 365.
 */
function getTransporter(): nodemailer.Transporter<SMTPTransport.SentMessageInfo> {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
    tls: {
      ciphers: "SSLv3",
      rejectUnauthorized: true,
    },
    // Connection timeout: 30s, greeting timeout: 30s, socket timeout: 60s
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });

  return transporter;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Sends a single email via SMTP.
 * Throws on auth failures or connection errors — the Send Engine decides how to handle.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const t = getTransporter();

  const mailOptions: nodemailer.SendMailOptions = {
    from: { name: message.from.name, address: message.from.address },
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
  };

  logger.debug(
    { module: "smtp", to: message.to, subject: message.subject },
    "Sending email",
  );

  const info = await t.sendMail(mailOptions);

  logger.info(
    { module: "smtp", to: message.to, messageId: info.messageId },
    "Email sent successfully",
  );

  return {
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
    rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
  };
}

/**
 * Forwards an inbound reply to the human review mailbox.
 * This is used by the reply bridge before we pause the contact.
 */
export async function forwardReplyForReview(
  input: ForwardReplyInput,
): Promise<SendResult> {
  // Use explicit override if provided, otherwise use environment config.
  const forwardTo = input.forwardTo ?? config.smtp.replyForwardTo;
  const safeSubject = input.subject.trim() || "(no subject)";
  const subject = `[Reply] ${input.contactEmail} | ${safeSubject}`;
  const bodySnippet = input.body.trim().slice(0, 2000);
  const text = [
    "Inbound reply captured by Deaton Outreach.",
    "",
    `Contact: ${input.contactEmail}`,
    `From: ${input.fromEmail}`,
    `Original Subject: ${safeSubject}`,
    "",
    "Reply body snippet:",
    bodySnippet,
  ].join("\n");

  logger.info(
    { module: "smtp", contactEmail: input.contactEmail, to: forwardTo },
    "Forwarding inbound reply for manual review",
  );

  return sendEmail({
    to: forwardTo,
    from: { name: config.smtp.fromName, address: config.smtp.user },
    subject,
    text,
    html: `<pre>${text}</pre>`,
  });
}

/**
 * Verifies the SMTP connection and auth credentials.
 * Returns true if the server is reachable and accepts the login.
 */
export async function verifyConnection(): Promise<boolean> {
  try {
    const t = getTransporter();
    await t.verify();
    logger.info({ module: "smtp" }, "SMTP connection verified");
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { module: "smtp", error: message },
      "SMTP connection verification failed",
    );
    return false;
  }
}

/**
 * Closes the SMTP connection pool.
 * Called during graceful shutdown.
 */
export async function disconnect(): Promise<void> {
  if (transporter) {
    transporter.close();
    transporter = null;
    logger.info({ module: "smtp" }, "SMTP connection closed");
  }
}

/**
 * Extracts the SMTP response code from a Nodemailer error.
 * Nodemailer attaches `responseCode` on SMTP rejections.
 * Falls back to parsing the first 3-digit code from the error message.
 */
export function extractSmtpCode(
  error: Error & { responseCode?: number },
): number | null {
  if (error.responseCode) return error.responseCode;

  // Fallback: look for a 3-digit code at the start of the message
  const match = error.message.match(/^(\d{3})\s/);
  return match ? parseInt(match[1], 10) : null;
}
