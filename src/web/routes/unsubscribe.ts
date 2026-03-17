/**
 * GET /unsubscribe?token=...
 *
 * Validates token, updates contact in Sheets, and returns a minimal HTML page.
 */
import type { RequestHandler } from 'express';
import {
  InvalidTokenError,
  TokenExpiredError,
  processUnsubscribe,
  validateUnsubscribeToken,
} from '../../engine/unsubscribe.js';
import { logger } from '../../logging/logger.js';

const SUCCESS_PAGE = `<!DOCTYPE html>
<html>
<head><title>Unsubscribed</title></head>
<body style="font-family: sans-serif; max-width: 500px; margin: 80px auto; text-align: center;">
  <h1>Unsubscribed</h1>
  <p>You have been successfully removed from our mailing list.</p>
  <p>You will no longer receive emails from us.</p>
</body>
</html>`;

const INVALID_LINK_PAGE = `<!DOCTYPE html>
<html>
<head><title>Unsubscribe</title></head>
<body style="font-family: sans-serif; max-width: 500px; margin: 80px auto; text-align: center;">
  <h1>Link Not Valid</h1>
  <p>This unsubscribe link is no longer valid.</p>
  <p>If you'd like to unsubscribe, please reply to any of our emails with the word "unsubscribe".</p>
</body>
</html>`;

const EXPIRED_LINK_PAGE = `<!DOCTYPE html>
<html>
<head><title>Unsubscribe</title></head>
<body style="font-family: sans-serif; max-width: 500px; margin: 80px auto; text-align: center;">
  <h1>Link Expired</h1>
  <p>This unsubscribe link has expired.</p>
  <p>If you'd like to unsubscribe, please reply to any of our emails with the word "unsubscribe".</p>
</body>
</html>`;

/**
 * Handles one unsubscribe click from an email footer link.
 * Error cases intentionally return 400 to avoid exposing extra details.
 */
export const unsubscribeHandler: RequestHandler = async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';

  if (!token) {
    res.status(400).type('text/html').send(INVALID_LINK_PAGE);
    return;
  }

  try {
    const { email } = validateUnsubscribeToken(token);
    await processUnsubscribe(email, 'link');

    logger.info({ module: 'unsubscribe-web', email }, 'Contact unsubscribed via link');
    res.status(200).type('text/html').send(SUCCESS_PAGE);
    return;
  } catch (error: unknown) {
    if (error instanceof TokenExpiredError) {
      logger.warn({ module: 'unsubscribe-web' }, 'Unsubscribe token expired');
      res.status(400).type('text/html').send(EXPIRED_LINK_PAGE);
      return;
    }

    if (error instanceof InvalidTokenError) {
      logger.warn({ module: 'unsubscribe-web' }, 'Invalid unsubscribe token');
      res.status(400).type('text/html').send(INVALID_LINK_PAGE);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error({ module: 'unsubscribe-web', error: message }, 'Unsubscribe endpoint failed');
    res.status(500).type('text/plain').send('Internal server error');
  }
};
