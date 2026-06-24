export class QueueFullError extends Error {
  constructor(message = "转换任务较多，请稍后再试") {
    super(message);
    this.name = "QueueFullError";
    this.statusCode = 429;
  }
}

export class ConversionQueue {
  constructor(options = {}) {
    this.concurrency = Math.max(1, Number(options.concurrency) || 1);
    this.queueLimit = Math.max(0, Number(options.queueLimit) || 0);
    this.activeCount = 0;
    this.queue = [];
  }

  get active() {
    return this.activeCount;
  }

  get pending() {
    return this.queue.length;
  }

  enqueue(task) {
    if (typeof task !== "function") {
      throw new TypeError("ConversionQueue task must be a function");
    }

    if (this.activeCount >= this.concurrency && this.queue.length >= this.queueLimit) {
      throw new QueueFullError();
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#drain();
    });
  }

  run(task) {
    try {
      return this.enqueue(task);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #drain() {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.activeCount += 1;
      Promise.resolve()
        .then(item.task)
        .then((result) => {
          this.activeCount -= 1;
          this.#drain();
          item.resolve(result);
        }, (error) => {
          this.activeCount -= 1;
          this.#drain();
          item.reject(error);
        });
    }
  }
}
