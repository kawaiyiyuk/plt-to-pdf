import { randomUUID } from "node:crypto";

import { QueueFullError } from "./conversion-queue.js";

const DEFAULT_JOB_RETENTION_MS = 10 * 60 * 1000;

export class ConversionJobStore {
  constructor(options = {}) {
    if (!options.queue) {
      throw new TypeError("ConversionJobStore requires a queue");
    }
    this.queue = options.queue;
    this.retentionMs = Math.max(0, Number(options.retentionMs) || DEFAULT_JOB_RETENTION_MS);
    this.jobs = new Map();
    this.pendingJobIds = [];
  }

  enqueue(kind, task) {
    if (typeof task !== "function") {
      throw new TypeError("ConversionJobStore task must be a function");
    }

    this.cleanupExpiredJobs();
    const jobId = randomUUID();
    const job = {
      jobId,
      kind,
      status: "queued",
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null
    };
    this.jobs.set(jobId, job);
    this.pendingJobIds.push(jobId);

    let promise;
    try {
      promise = this.queue.enqueue(async () => {
        this.#removePendingJobId(jobId);
        job.status = "running";
        job.startedAt = Date.now();
        try {
          const result = await task();
          job.status = "done";
          job.result = serializeJobResult(result);
          return result;
        } catch (error) {
          job.status = "error";
          job.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          job.finishedAt = Date.now();
        }
      });
    } catch (error) {
      this.#removePendingJobId(jobId);
      this.jobs.delete(jobId);
      throw error;
    }

    promise.catch(() => {});
    return {
      jobId,
      promise,
      snapshot: this.get(jobId)
    };
  }

  get(jobId) {
    this.cleanupExpiredJobs();
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    return this.#snapshot(job);
  }

  cleanupExpiredJobs(now = Date.now()) {
    if (this.retentionMs <= 0) {
      return;
    }
    for (const [jobId, job] of this.jobs.entries()) {
      if (!job.finishedAt) continue;
      if (now - job.finishedAt <= this.retentionMs) continue;
      this.jobs.delete(jobId);
    }
    this.pendingJobIds = this.pendingJobIds.filter((jobId) => this.jobs.has(jobId));
  }

  #removePendingJobId(jobId) {
    const index = this.pendingJobIds.indexOf(jobId);
    if (index >= 0) {
      this.pendingJobIds.splice(index, 1);
    }
  }

  #snapshot(job) {
    const isQueued = job.status === "queued";
    const aheadCount = isQueued
      ? Math.max(this.queue.active + this.pendingJobIds.indexOf(job.jobId), 0)
      : 0;
    const snapshot = {
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      active: this.queue.active,
      pending: this.queue.pending,
      concurrency: this.queue.concurrency,
      queueLimit: this.queue.queueLimit,
      aheadCount,
      position: isQueued ? aheadCount + 1 : 0
    };
    if (job.status === "done" && job.result && typeof job.result === "object") {
      return { ...snapshot, ...job.result };
    }
    if (job.status === "error" && job.error) {
      snapshot.error = job.error;
    }
    return snapshot;
  }
}

export function isQueueFullError(error) {
  return error instanceof QueueFullError;
}

function serializeJobResult(result) {
  if (!result || typeof result !== "object") {
    return null;
  }
  const snapshot = { ...result };
  if (typeof result.pdf === "string") {
    snapshot.pdfBase64 = Buffer.from(result.pdf, "utf8").toString("base64");
    delete snapshot.pdf;
  }
  if (typeof result.svg === "string") {
    snapshot.svgBase64 = Buffer.from(result.svg, "utf8").toString("base64");
    delete snapshot.svg;
  }
  return snapshot;
}
