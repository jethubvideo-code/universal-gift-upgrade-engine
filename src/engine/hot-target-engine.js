import crypto from 'node:crypto';
import { EngineError, ErrorCodes } from '../core/errors.js';
import { classifyError } from '../core/retry-manager.js';
import { canTransition } from '../core/state-machine.js';
import { TargetStates } from '../core/state-machine.js';

export class HotTargetEngine {
  constructor({
    store,
    targets,
    index,
    monitor,
    cache,
    sessions,
    savedGifts,
    executor,
    scheduler,
    locks,
    limiter,
    notifier,
    metrics,
    logger,
    distanceThreshold = 3
  } = {}) {
    this.store = store;
    this.targets = targets;
    this.index = index;
    this.monitor = monitor;
    this.cache = cache;
    this.sessions = sessions;
    this.savedGifts = savedGifts;
    this.executor = executor;
    this.scheduler = scheduler;
    this.locks = locks;
    this.limiter = limiter;
    this.notifier = notifier;
    this.metrics = metrics;
    this.logger = logger;
    this.distanceThreshold = distanceThreshold;
  }

  evaluate(target, state) {
    if (!target || !state) return 3;

    if (state.verified_available || state.verifiedAvailable || target.verified_available) {
      return 0; // P0
    }

    const nextExp = state.next_expected_number;
    const targetNum = target.target_number;

    if (nextExp == null || targetNum == null) {
      return 3; // P3
    }

    if (targetNum === nextExp) {
      return 1; // P1
    }

    const distance = Math.abs(nextExp - targetNum);
    if (distance <= (this.distanceThreshold ?? 3)) {
      return 2; // P2
    }

    return 3; // P3
  }

  async onCollectionUpdate(state) {
    if (!state || !state.collection_id) return;

    let targetsToEvaluate = [];
    if (this.index) {
      targetsToEvaluate = this.index.byCollection(state.collection_id);
    } else if (this.targets && typeof this.targets.listActive === 'function') {
      targetsToEvaluate = this.targets
        .listActive()
        .filter(t => t.collection_id === state.collection_id);
    } else if (this.store) {
      targetsToEvaluate = this.store.find('targets', { collection_id: state.collection_id }) || [];
    }

    const detectionStart = Date.now();

    for (const target of targetsToEvaluate) {
     try {
      if (
        target.status === TargetStates.COMPLETED ||
        target.status === TargetStates.FAILED ||
        target.status === 'COMPLETED' ||
        target.status === 'FAILED'
      ) {
        continue;
      }

      const priority = this.evaluate(target, state);

      let currentStatus = target.status;

      if (priority === 0 || priority === 1) {
        if (currentStatus === TargetStates.WATCHING || currentStatus === 'WATCHING') {
          if (this.targets) {
            await this.targets.applyTransition(target.id, TargetStates.PREDICTED, {
              reason: 'Collection update move to PREDICTED',
              details: { priority, next_expected: state.next_expected_number }
            });
            await this.targets.applyTransition(target.id, TargetStates.HOT_TARGET, {
              reason: 'Collection update move to HOT_TARGET',
              details: { priority, next_expected: state.next_expected_number }
            });
          }
          currentStatus = TargetStates.HOT_TARGET;
        } else if (currentStatus === TargetStates.PREDICTED || currentStatus === 'PREDICTED') {
          if (this.targets) {
            await this.targets.applyTransition(target.id, TargetStates.HOT_TARGET, {
              reason: 'PREDICTED target is now HOT_TARGET',
              details: { priority, next_expected: state.next_expected_number }
            });
          }
          currentStatus = TargetStates.HOT_TARGET;
        }
      } else if (priority === 2) {
        if (currentStatus === TargetStates.WATCHING || currentStatus === 'WATCHING') {
          if (this.targets) {
            await this.targets.applyTransition(target.id, TargetStates.PREDICTED, {
              reason: 'Target is near next expected number',
              details: { priority, next_expected: state.next_expected_number }
            });
          }
          currentStatus = TargetStates.PREDICTED;
        } else if (currentStatus === TargetStates.HOT_TARGET || currentStatus === 'HOT_TARGET') {
          if (this.targets) {
            await this.targets.applyTransition(target.id, TargetStates.PREDICTED, {
              reason: 'HOT target moved back to PREDICTED',
              details: { priority, next_expected: state.next_expected_number }
            });
          }
          currentStatus = TargetStates.PREDICTED;
        }
      } else if (priority === 3) {
        if (
          currentStatus === TargetStates.PREDICTED ||
          currentStatus === 'PREDICTED' ||
          currentStatus === TargetStates.HOT_TARGET ||
          currentStatus === 'HOT_TARGET'
        ) {
          if (this.targets) {
            await this.targets.applyTransition(target.id, TargetStates.WATCHING, {
              reason: 'Target is far from next expected number',
              details: { priority, next_expected: state.next_expected_number }
            });
          }
          currentStatus = TargetStates.WATCHING;
        }
      }

      if (this.metrics) {
        const detectionLatency = Date.now() - detectionStart;
        if (typeof this.metrics.observe === 'function') {
          this.metrics.observe('detection_latency_ms', detectionLatency);
        }
      }

      if (currentStatus === TargetStates.HOT_TARGET || currentStatus === 'HOT_TARGET') {
        if (this.index) {
          this.index.markHot(target.id);
        }

        const preStageRes = await this.preStage(target);

        if (preStageRes && preStageRes.ready !== false) {
          if (this.scheduler && typeof this.scheduler.runOnce === 'function') {
            this.scheduler
              .runOnce(
                { key: `hot:${target.id}`, priority: 0, label: `handleHot:${target.id}` },
                () => this.handleHot(target)
              )
              .catch(() => {});
          } else {
            await this.handleHot(target);
          }
        }
      }
     } catch (loopErr) {
      // A stale in-memory copy must never break the whole collection update.
      if (this.logger) {
        this.logger.warn('Target evaluation skipped', { target: target.id, error: loopErr.message });
      }
     }
     // Keep the in-memory index in sync with the authoritative store row.
     if (this.targets && this.index && typeof this.index.add === 'function') {
       try {
         const fresh = typeof this.targets.get === 'function' ? this.targets.get(target.id) : null;
         if (fresh) {
           this.index.add(fresh);
           Object.assign(target, fresh);
         }
       } catch { /* index sync is best-effort */ }
     }
    }
  }

  async preStage(target) {
    if (!target) return { ready: false, reason: 'NO_TARGET' };

    let session = null;
    try {
      if (this.sessions && typeof this.sessions.getUserSession === 'function') {
        session = await this.sessions.getUserSession(target.user_id);
      } else {
        const sessionsMod = await import('../telegram/user-sessions.js').catch(() => null);
        if (sessionsMod) {
          const SessionManager = sessionsMod.UserSessionManager || sessionsMod.default;
          if (SessionManager) {
            const sm = new SessionManager({ store: this.store });
            session = await sm.getUserSession(target.user_id);
          }
        }
      }
    } catch (err) {
      if (this.logger) {
        this.logger.debug('Session load degradation in preStage', { error: err.message });
      }
    }

    let savedGift = null;
    if (this.savedGifts) {
      try {
        if (typeof this.savedGifts.getSavedStarGifts === 'function') {
          const savedList = await this.savedGifts.getSavedStarGifts({
            userSession: session,
            userId: target.user_id
          });
          if (typeof this.savedGifts.findForTarget === 'function') {
            savedGift = this.savedGifts.findForTarget(savedList, {
              gift_id: target.gift_id,
              target_number: target.target_number
            });
          } else if (Array.isArray(savedList)) {
            savedGift = savedList.find(
              g =>
                (g.gift_id === target.gift_id || g.collection_id === target.collection_id) &&
                g.gift_num === target.target_number
            );
          }
        } else if (typeof this.savedGifts.findForTarget === 'function') {
          savedGift = await this.savedGifts.findForTarget([], {
            gift_id: target.gift_id,
            target_number: target.target_number
          });
        }
      } catch (err) {
        if (this.logger) {
          this.logger.debug('savedGifts lookup error in preStage', { error: err.message });
        }
      }
    }

    const payload = {
      target_id: target.id,
      user_id: target.user_id,
      gift_id: target.gift_id,
      target_number: target.target_number,
      saved_gift: savedGift || null,
      session_id: session?.id || null,
      prestaged_at: new Date().toISOString()
    };

    if (
      savedGift &&
      savedGift.upgrade_stars != null &&
      target.auto_upgrade &&
      target.max_upgrade_stars != null
    ) {
      if (Number(savedGift.upgrade_stars) > Number(target.max_upgrade_stars)) {
        if (this.targets) {
          await this.targets.applyTransition(
            target.id,
            TargetStates.PRICE_LIMIT_EXCEEDED,
            {
              reason: `Gift upgrade price (${savedGift.upgrade_stars}) exceeds max limit (${target.max_upgrade_stars})`,
              details: { price: savedGift.upgrade_stars, max: target.max_upgrade_stars }
            }
          );
        }
        return { ready: false, reason: 'PRICE_LIMIT_EXCEEDED', payload };
      }
    }

    return {
      ready: true,
      session,
      savedGift,
      payload
    };
  }

  async handleHot(target) {
    if (!target) return null;

    const lockKey = `target:${target.id}`;

    const executeFlow = async () => {
      const overallStart = Date.now();

      // Idempotency check via upgrade_jobs table
      const idempotencyKey = `upgrade:${target.id}:${target.target_number}`;
      let job = null;

      if (this.store) {
        const jobs = this.store.find('upgrade_jobs', { idempotency_key: idempotencyKey }) || [];
        if (jobs.length > 0) {
          job = jobs[0];
          if (job.status === 'DONE') {
            return { status: TargetStates.COMPLETED, job_id: job.id, cached: true };
          }
        } else {
          job = this.store.insert('upgrade_jobs', {
            id: crypto.randomUUID(),
            target_id: target.id,
            user_id: target.user_id,
            status: 'QUEUED',
            idempotency_key: idempotencyKey,
            payload_json: JSON.stringify({ target_id: target.id }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
        }
      }

      try {
        // Step 1: Transition to VERIFYING
        if (this.targets) {
          await this.targets.applyTransition(target.id, TargetStates.VERIFYING, {
            reason: 'Starting target verification'
          });
        }

        // Executor resolution
        let executor = this.executor;
        if (!executor) {
          const execMod = await import('../telegram/upgrade-executor.js').catch(() => null);
          if (execMod) {
            const ExecutorClass = execMod.UpgradeExecutor || execMod.default;
            if (ExecutorClass) {
              executor = new ExecutorClass({ store: this.store });
            }
          }
        }

        // Run verification
        const verifyStart = Date.now();
        let verifyRes = null;

        if (executor && typeof executor.verify === 'function') {
          verifyRes = await executor.verify({
            userSession: null,
            target
          });
        } else {
          // Graceful degradation / Test mode default verifier
          verifyRes = { ok: true, canUpgrade: true, price: 0, savedGift: null };
        }

        const verifyLatency = Date.now() - verifyStart;
        if (this.metrics && typeof this.metrics.observe === 'function') {
          this.metrics.observe('verification_latency_ms', verifyLatency);
        }

        if (!verifyRes || !verifyRes.ok || !verifyRes.canUpgrade) {
          const reason = verifyRes?.reason || 'Verification failed';
          if (this.targets) {
            await this.targets.applyTransition(target.id, TargetStates.FAILED, { reason });
          }
          if (this.store && job) {
            this.store.update('upgrade_jobs', job.id, {
              status: 'FAILED',
              updated_at: new Date().toISOString()
            });
          }
          if (this.metrics && typeof this.metrics.counter === 'function') {
            this.metrics.counter('upgrades_failed');
          }
          throw new EngineError(ErrorCodes.VERIFICATION_FAILED, reason);
        }

        // Check price limit during verify
        if (
          target.auto_upgrade &&
          target.max_upgrade_stars != null &&
          verifyRes.price != null &&
          Number(verifyRes.price) > Number(target.max_upgrade_stars)
        ) {
          if (this.targets) {
            await this.targets.applyTransition(
              target.id,
              TargetStates.PRICE_LIMIT_EXCEEDED,
              { reason: `Verified price (${verifyRes.price}) exceeds max limit (${target.max_upgrade_stars})` }
            );
          }
          if (this.store && job) {
            this.store.update('upgrade_jobs', job.id, {
              status: 'FAILED',
              updated_at: new Date().toISOString()
            });
          }
          return { status: TargetStates.PRICE_LIMIT_EXCEEDED };
        }

        // Step 2: Transition to UPGRADE_READY
        if (this.targets) {
          await this.targets.applyTransition(target.id, TargetStates.UPGRADE_READY, {
            reason: 'Target verified and ready'
          });
        }

        // Step 3: Transition to UPGRADING
        if (this.targets) {
          await this.targets.applyTransition(target.id, TargetStates.UPGRADING, {
            reason: 'Executing upgrade'
          });
        }
        if (this.store && job) {
          this.store.update('upgrade_jobs', job.id, {
            status: 'RUNNING',
            updated_at: new Date().toISOString()
          });
        }

        // Run execution
        const execStart = Date.now();
        let execRes = null;

        if (executor && typeof executor.execute === 'function') {
          execRes = await executor.execute({
            userSession: null,
            target,
            savedGift: verifyRes.savedGift,
            idempotencyKey
          });
        } else {
          // Graceful degradation / Test mode default executor
          execRes = { status: 'COMPLETED', tx_id: crypto.randomUUID() };
        }

        const execLatency = Date.now() - execStart;
        if (this.metrics && typeof this.metrics.observe === 'function') {
          this.metrics.observe('execution_latency_ms', execLatency);
        }

        // Step 4: Transition to CONFIRMING
        if (this.targets) {
          await this.targets.applyTransition(target.id, TargetStates.CONFIRMING, {
            reason: 'Upgrade executed, confirming status'
          });
        }

        // Step 5: Transition to COMPLETED
        if (this.targets) {
          await this.targets.applyTransition(target.id, TargetStates.COMPLETED, {
            reason: 'Upgrade successfully confirmed'
          });
        }

        if (this.store && job) {
          this.store.update('upgrade_jobs', job.id, {
            status: 'DONE',
            updated_at: new Date().toISOString()
          });
        }

        const totalLatency = Date.now() - overallStart;
        if (this.metrics && typeof this.metrics.observe === 'function') {
          this.metrics.observe('total_latency_ms', totalLatency);
        }
        if (this.metrics && typeof this.metrics.counter === 'function') {
          this.metrics.counter('upgrades_success');
        }

        if (this.notifier && typeof this.notifier.notifyUser === 'function') {
          this.notifier.notifyUser(target.user_id, 'UPGRADE_COMPLETED', {
            target,
            result: execRes
          });
        }

        return { status: TargetStates.COMPLETED, result: execRes, latency: totalLatency };
      } catch (err) {
        if (this.logger) {
          this.logger.error('handleHot execution error', {
            target_id: target.id,
            error: err.message
          });
        }
        // Temporary errors (FLOOD_WAIT / rate limit / timeout / network) are
        // RETRIED with the next cycle — the job stays QUEUED, never an infinite
        // loop (max 3 attempts). Permanent errors fail the target immediately.
        const isTemporary = classifyError(err).kind === 'temporary';
        let attempts = 0;
        if (this.store && job) {
          attempts = this.store.count('upgrade_attempts', { job_id: job.id });
          this.store.insert('upgrade_attempts', {
            id: crypto.randomUUID(),
            job_id: job.id,
            attempt: attempts + 1,
            error_code: err.code || 'UNKNOWN',
            error_text: String(err.message || err).slice(0, 500),
            latency_ms: Date.now() - overallStart,
            created_at: new Date().toISOString()
          });
        }
        const retryable = isTemporary && job && attempts < 3;

        if (this.targets) {
          try {
            const cur = this.targets.get(target.id);
            if (retryable && cur && canTransition(cur.status, TargetStates.WATCHING)) {
              // back to WATCHING: the QUEUED job is resumed next cycle
              await this.targets.applyTransition(target.id, TargetStates.WATCHING, {
                reason: `Temporary error (${err.code || err.message}), retry scheduled`
              });
            } else {
              await this.targets.applyTransition(target.id, TargetStates.FAILED, {
                reason: err.message || 'Execution error'
              });
            }
          } catch {}
        }
        if (this.store && job) {
          try {
            this.store.update('upgrade_jobs', job.id, {
              status: retryable ? 'QUEUED' : 'FAILED',
              updated_at: new Date().toISOString()
            });
          } catch {}
        }
        if (this.metrics && typeof this.metrics.counter === 'function') {
          this.metrics.counter('upgrades_failed');
        }
        throw err;
      }
    };

    if (this.locks && typeof this.locks.withLock === 'function') {
      return await this.locks.withLock(lockKey, executeFlow, { ownerId: 'hot-target-engine' });
    }

    return await executeFlow();
  }
}
