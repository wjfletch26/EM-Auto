/**
 * Cron scheduler for recurring background jobs.
 *
 * Phase 5 wires three jobs:
 * - Send cycle
 * - Reply cycle (placeholder for Tier 1/2 deployments)
 * - Health heartbeat
 */
import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import { executeSendCycle } from '../engine/send-engine.js';
import { processForwardedReplyQueue } from '../engine/reply-forward-processor.js';

/**
 * Returned handle so the main entrypoint can stop all jobs on shutdown.
 */
export interface SchedulerHandle {
  stop: () => void;
}

// Fixed heartbeat cadence keeps operator logs alive even when no sends happen.
const HEARTBEAT_CRON = '*/5 * * * *';

async function runSendCycleSafe(): Promise<void> {
  try {
    await executeSendCycle();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'scheduler', error: message }, 'Scheduled send cycle failed');
  }
}

async function runReplyCycleSafe(): Promise<void> {
  try {
    const result = await processForwardedReplyQueue();
    if (result.processed === 0 && result.failed === 0) {
      logger.debug({ module: 'scheduler' }, 'Reply cycle complete: no queued reply events');
      return;
    }

    logger.info(
      { module: 'scheduler', ...result },
      'Reply cycle complete',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'scheduler', error: message }, 'Scheduled reply cycle failed');
  }
}

function writeHeartbeat(): void {
  logger.info(
    {
      module: 'scheduler',
      uptimeSeconds: Math.floor(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    },
    'Scheduler heartbeat',
  );
}

/**
 * Starts all recurring cron jobs and returns a stop handle.
 */
export function startScheduler(): SchedulerHandle {
  const tasks: ScheduledTask[] = [];

  tasks.push(cron.schedule(config.schedule.sendCron, () => void runSendCycleSafe()));
  tasks.push(cron.schedule(config.schedule.replyCron, () => void runReplyCycleSafe()));
  tasks.push(cron.schedule(HEARTBEAT_CRON, writeHeartbeat));

  logger.info(
    {
      module: 'scheduler',
      sendCron: config.schedule.sendCron,
      replyCron: config.schedule.replyCron,
      heartbeatCron: HEARTBEAT_CRON,
    },
    'Scheduler started',
  );

  return {
    stop: () => {
      for (const task of tasks) {
        task.stop();
      }
      logger.info({ module: 'scheduler' }, 'Scheduler stopped');
    },
  };
}
