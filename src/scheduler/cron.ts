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
import { runPipelineCycle } from '../engine/pipeline-orchestrator.js';
import { runApprovalWatcherCycle } from '../engine/approval-watcher.js';

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

async function runPipelineCycleSafe(): Promise<void> {
  try {
    await runPipelineCycle();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'scheduler', error: message }, 'Scheduled pipeline cycle failed');
  }
}

async function runApprovalWatcherSafe(): Promise<void> {
  try {
    await runApprovalWatcherCycle();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'scheduler', error: message }, 'Scheduled approval watcher failed');
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

  // Intelligence pipeline jobs (only if enabled)
  if (config.pipeline.enabled) {
    tasks.push(cron.schedule(config.pipeline.cron, () => void runPipelineCycleSafe()));
    tasks.push(cron.schedule(config.pipeline.cron, () => void runApprovalWatcherSafe()));
    logger.info({ module: 'scheduler', pipelineCron: config.pipeline.cron }, 'Pipeline scheduler enabled');
  }

  logger.info(
    {
      module: 'scheduler',
      sendCron: config.schedule.sendCron,
      replyCron: config.schedule.replyCron,
      heartbeatCron: HEARTBEAT_CRON,
      pipelineEnabled: config.pipeline.enabled,
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
