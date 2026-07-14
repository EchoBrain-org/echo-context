export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, payload?: Record<string, unknown>): void;
  info(message: string, payload?: Record<string, unknown>): void;
  warn(message: string, payload?: Record<string, unknown>): void;
  error(message: string, payload?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveThreshold(): LogLevel {
  const raw = process.env.ECHO_LOG_LEVEL;
  if (raw && Object.prototype.hasOwnProperty.call(LEVEL_ORDER, raw)) {
    return raw as LogLevel;
  }
  return 'info';
}

const THRESHOLD: LogLevel = resolveThreshold();

function emit(entry: LogEntry): void {
  if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[THRESHOLD]) {
    return;
  }
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createLogger(source: string): Logger {
  function log(level: LogLevel, message: string, payload?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
    };
    if (payload !== undefined) {
      entry.payload = payload;
    }
    emit(entry);
  }
  return {
    debug: (message, payload) => log('debug', message, payload),
    info: (message, payload) => log('info', message, payload),
    warn: (message, payload) => log('warn', message, payload),
    error: (message, payload) => log('error', message, payload),
  };
}
