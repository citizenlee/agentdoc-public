function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function readMetricValue(metricsText: string, metricName: string, filters: Array<[string, string]>): number {
  const lines = metricsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const line = lines.find((entry) => (
    entry.startsWith(`${metricName}{`)
    && filters.every(([key, value]) => entry.includes(`${key}="${value}"`))
  ));
  if (!line) return 0;
  const value = Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1));
  return Number.isFinite(value) ? value : 0;
}

async function run(): Promise<void> {
  const previousCooldown = process.env.COLLAB_WS_OVERSIZE_LOG_COOLDOWN_MS;
  process.env.COLLAB_WS_OVERSIZE_LOG_COOLDOWN_MS = '50';

  const collab = await import('../../server/collab.ts');
  const metrics = await import('../../server/metrics.ts');

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(' '));
    originalError(...args);
  };

  try {
    const statusSymbol = Symbol('status-code');
    const oversizedError = Object.assign(new Error('Max payload size exceeded'), {
      code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
      [statusSymbol]: 1009,
    });

    let errorListener: ((error: unknown) => void) | null = null;
    let closeCount = 0;
    const socket = {
      on(event: string, listener: (error: unknown) => void) {
        if (event === 'error') errorListener = listener;
      },
      close() {
        closeCount += 1;
      },
    };
    const request = {
      url: '/ws?slug=oversize-doc',
      headers: {
        'sec-websocket-key': 'oversize-session-a',
        'user-agent': 'codex-test',
        'x-share-token': 'token-present',
      },
      socket: {
        remoteAddress: '127.0.0.1',
      },
    };

    collab.__unsafeAttachCollabSocketErrorHandlerForTests(socket, request, 'ws-router');
    assert(typeof errorListener === 'function', 'Expected socket error listener to be attached');

    errorListener!(oversizedError);
    errorListener!(oversizedError);

    const oversizeLogsAfterSecond = errors.filter((entry) => entry.includes('[collab] websocket connection error'));
    assert(oversizeLogsAfterSecond.length === 1, `Expected one oversize log during cooldown, got ${oversizeLogsAfterSecond.length}`);
    assert(closeCount === 2, `Expected close() on each socket error, got ${closeCount}`);

    const metricsAfterSecond = metrics.renderMetricsText();
    const suppressedAfterSecond = readMetricValue(
      metricsAfterSecond,
      'collab_log_suppressed_total',
      [['kind', 'ws_oversize'], ['reason', 'unsupported_message_length']],
    );
    assert(suppressedAfterSecond === 1, `Expected one suppressed ws oversize log, got ${suppressedAfterSecond}`);

    await sleep(80);
    errorListener!(oversizedError);
    const oversizeLogsAfterThird = errors.filter((entry) => entry.includes('[collab] websocket connection error'));
    assert(oversizeLogsAfterThird.length === 2, `Expected oversize log after cooldown expiry, got ${oversizeLogsAfterThird.length}`);

    const nonOversizeError = Object.assign(new Error('socket hangup'), { code: 'EPIPE' });
    errorListener!(nonOversizeError);
    errorListener!(nonOversizeError);
    const finalLogs = errors.filter((entry) => entry.includes('[collab] websocket connection error'));
    assert(finalLogs.length === 4, `Expected non-oversize errors not to be suppressed, got ${finalLogs.length}`);

    console.log('✓ websocket oversized-payload storms are suppressed per doc/session/source');
  } finally {
    console.error = originalError;
    if (previousCooldown === undefined) delete process.env.COLLAB_WS_OVERSIZE_LOG_COOLDOWN_MS;
    else process.env.COLLAB_WS_OVERSIZE_LOG_COOLDOWN_MS = previousCooldown;
    await collab.stopCollabRuntime();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
