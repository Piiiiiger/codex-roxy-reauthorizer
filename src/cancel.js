class TaskCancelledError extends Error {
  constructor(message = '任务已停止') {
    super(message);
    this.name = 'TaskCancelledError';
    this.code = 'TASK_CANCELLED';
  }
}

function isCancelError(error) {
  return (
    error instanceof TaskCancelledError
    || error?.code === 'TASK_CANCELLED'
    || error?.code === 'ERR_CANCELED'
    || error?.name === 'AbortError'
    || error?.name === 'CanceledError'
  );
}

function throwIfAborted(signal, message = '任务已停止') {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new TaskCancelledError(reason || message);
}

function addAbortListener(signal, listener) {
  if (!signal) return () => {};
  if (signal.aborted) {
    listener();
    return () => {};
  }
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

function abortableSleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let cleanup = () => {};
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    cleanup = addAbortListener(signal, () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new TaskCancelledError());
    });
  });
}

module.exports = {
  TaskCancelledError,
  isCancelError,
  throwIfAborted,
  addAbortListener,
  abortableSleep,
};
