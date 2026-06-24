export class InsufficientCreditsError extends Error {
  constructor(message = "积分不足，请先充值或减少提交次数") {
    super(message);
    this.name = "InsufficientCreditsError";
    this.statusCode = 402;
  }
}

export class MockCreditLedger {
  constructor(options = {}) {
    this.initialBalance = Math.max(0, Number(options.initialBalance) || 0);
    this.costPerConversion = Math.max(1, Number(options.costPerConversion) || 1);
    this.accounts = new Map();
    this.submissions = new Map();
  }

  reserveSubmission(clientId, requestId) {
    const key = this.#submissionKey(clientId, requestId);
    const existing = this.submissions.get(key);
    if (existing) {
      return this.#snapshot(existing, false);
    }

    const account = this.#getAccount(clientId);
    if (this.#availableBalance(account) < this.costPerConversion) {
      throw new InsufficientCreditsError();
    }

    const record = {
      clientId,
      requestId,
      jobId: null,
      status: "reserved",
      cost: this.costPerConversion,
      refunded: false,
      completed: false,
      chargedAt: Date.now(),
      balanceAfter: this.#availableBalance(account) - this.costPerConversion
    };
    account.reservedBalance += this.costPerConversion;
    this.submissions.set(key, record);
    return this.#snapshot(record, true);
  }

  attachJob(clientId, requestId, jobId) {
    const record = this.#requireSubmission(clientId, requestId);
    record.jobId = jobId;
    record.status = "queued";
    return this.#snapshot(record, false);
  }

  completeSubmission(clientId, requestId) {
    const record = this.#requireSubmission(clientId, requestId);
    if (record.refunded || record.completed) {
      return this.#snapshot(record, false);
    }
    const account = this.#getAccount(clientId);
    account.reservedBalance = Math.max(account.reservedBalance - record.cost, 0);
    account.totalBalance = Math.max(account.totalBalance - record.cost, 0);
    record.completed = true;
    record.status = "completed";
    record.completedAt = Date.now();
    record.balanceAfter = this.#availableBalance(account);
    return this.#snapshot(record, false);
  }

  refundSubmission(clientId, requestId) {
    const record = this.#requireSubmission(clientId, requestId);
    if (record.refunded || record.completed) {
      return this.#snapshot(record, false);
    }
    const account = this.#getAccount(clientId);
    account.reservedBalance = Math.max(account.reservedBalance - record.cost, 0);
    record.refunded = true;
    record.status = "refunded";
    record.refundedAt = Date.now();
    record.balanceAfter = this.#availableBalance(account);
    return this.#snapshot(record, false);
  }

  getBalance(clientId) {
    return this.#snapshotAccount(clientId);
  }

  #getAccount(clientId) {
    const key = this.#normalizeClientId(clientId);
    let account = this.accounts.get(key);
    if (!account) {
      account = {
        clientId: key,
        totalBalance: this.initialBalance,
        reservedBalance: 0
      };
      this.accounts.set(key, account);
    }
    return account;
  }

  #snapshotAccount(clientId) {
    const account = this.#getAccount(clientId);
    const availableBalance = this.#availableBalance(account);
    return {
      clientId: account.clientId,
      balance: availableBalance,
      availableBalance,
      reservedBalance: account.reservedBalance,
      spentBalance: Math.max(this.initialBalance - account.totalBalance, 0),
      totalBalance: account.totalBalance,
      costPerConversion: this.costPerConversion,
      initialBalance: this.initialBalance
    };
  }

  #availableBalance(account) {
    return Math.max(account.totalBalance - account.reservedBalance, 0);
  }

  #requireSubmission(clientId, requestId) {
    const key = this.#submissionKey(clientId, requestId);
    const record = this.submissions.get(key);
    if (!record) {
      throw new Error("提交记录不存在");
    }
    return record;
  }

  #submissionKey(clientId, requestId) {
    return `${this.#normalizeClientId(clientId)}:${String(requestId).trim()}`;
  }

  #normalizeClientId(clientId) {
    const value = String(clientId ?? "").trim();
    if (!value) {
      throw new Error("clientId is required");
    }
    return value;
  }

  #snapshot(record, fresh = false) {
    return {
      clientId: record.clientId,
      requestId: record.requestId,
      jobId: record.jobId,
      status: record.status,
      cost: record.cost,
      refunded: record.refunded,
      completed: record.completed,
      fresh,
      balanceAfter: record.balanceAfter
    };
  }
}
