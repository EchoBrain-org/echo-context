import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Ajv, type ValidateFunction } from 'ajv';
import { processCandidate } from '../capture/pipeline.js';
import type { Storage } from '../storage/interface.js';
import {
  getRecentWorkContext,
  type RecentWorkContextParams,
} from './internal/cluster-engine.js';
import { getAtoms, type GetAtomsParams } from './tools/get-atoms.js';
import {
  searchMemories,
  type SearchMemoriesParams,
} from './tools/search-memories.js';
import {
  waitForNewTurns,
  type WaitForNewTurnsParams,
} from './tools/wait-for-new-turns.js';

interface ServiceApiContract {
  limits: {
    request_body_bytes: number;
    response_body_bytes: number;
    request_deadline_ms: number;
    default_wait_seconds: number;
  };
  definitions: Record<string, unknown>;
  endpoints: Record<
    string,
    { request: Record<string, unknown>; response: Record<string, unknown> }
  >;
}

const API = JSON.parse(
  readFileSync(new URL('../../schemas/service-api.v1.json', import.meta.url), 'utf8'),
) as ServiceApiContract;
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map<
  string,
  { request: ValidateFunction; response: ValidateFunction }
>(
  Object.entries(API.endpoints).map(([route, contract]) => [
    route,
    {
      request: ajv.compile({ ...contract.request, $defs: API.definitions }),
      response: ajv.compile({ ...contract.response, $defs: API.definitions }),
    },
  ]),
);

class ServiceBodyTooLargeError extends Error {}
class ServiceBodyDeadlineError extends Error {}

async function readServiceBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > API.limits.request_body_bytes) {
      throw new ServiceBodyTooLargeError('request body exceeds committed limit');
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > API.limits.response_body_bytes) {
    sendJson(response, 507, { error: 'response exceeds committed result-size limit' });
    return;
  }
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', String(bytes.length));
  response.end(bytes);
}

function validationError(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors, { separator: '; ' });
}

function sendContractResponse(
  route: string,
  response: ServerResponse,
  value: unknown,
): void {
  const validate = validators.get(route)?.response;
  if (validate === undefined || !validate(value)) {
    sendJson(response, 500, {
      error: `response schema violation: ${validate === undefined ? 'missing validator' : validationError(validate)}`,
    });
    return;
  }
  sendJson(response, 200, value);
}

/** Handle the committed loopback service API on the same authority socket. */
export async function handleServiceApi(
  request: IncomingMessage,
  response: ServerResponse,
  storage: Storage,
  host: string,
): Promise<boolean> {
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = new URL(request.url ?? '/', `http://${urlHost}`);
  if (!url.pathname.startsWith('/v1/')) return false;
  const route = `${request.method ?? ''} ${url.pathname}`;
  const contract = validators.get(route);
  if (contract === undefined) {
    const knownPath = [...validators.keys()].some((candidate) =>
      candidate.endsWith(` ${url.pathname}`),
    );
    sendJson(response, knownPath ? 405 : 404, {
      error: knownPath ? 'method not allowed' : 'unknown endpoint',
    });
    return true;
  }

  const deadline = setTimeout(() => {
    sendJson(response, 408, { error: 'request deadline exceeded' });
    request.destroy(new ServiceBodyDeadlineError('request deadline exceeded'));
  }, API.limits.request_deadline_ms);
  deadline.unref();
  try {
    if (route === 'GET /v1/ping') {
      sendContractResponse(route, response, {
        pong: true,
        ts: new Date().toISOString(),
      });
      return true;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) {
      sendJson(response, 415, { error: 'content-type must be application/json' });
      return true;
    }
    let body: unknown;
    try {
      body = await readServiceBody(request);
    } catch (err) {
      if (err instanceof ServiceBodyDeadlineError) return true;
      sendJson(response, err instanceof ServiceBodyTooLargeError ? 413 : 400, {
        error:
          err instanceof ServiceBodyTooLargeError
            ? err.message
            : 'invalid JSON',
      });
      return true;
    }
    if (!contract.request(body)) {
      sendJson(response, 400, {
        error: `request schema violation: ${validationError(contract.request)}`,
      });
      return true;
    }
    const input = body as Record<string, unknown>;
    if (route === 'POST /v1/capture') {
      const result = await processCandidate(input, storage);
      if (!result.accepted) {
        sendJson(
          response,
          result.reason === 'malformed_event' || result.reason === 'invalid_timestamp'
            ? 400
            : 403,
          { error: `capture rejected: ${result.reason}` },
        );
        return true;
      }
      sendContractResponse(route, response, { id: result.id });
      return true;
    }
    if (route === 'POST /v1/search') {
      sendContractResponse(
        route,
        response,
        await searchMemories(storage, input as unknown as SearchMemoriesParams),
      );
      return true;
    }
    if (route === 'POST /v1/clusters') {
      sendContractResponse(
        route,
        response,
        await getRecentWorkContext(storage, input as unknown as RecentWorkContextParams),
      );
      return true;
    }
    if (route === 'POST /v1/atoms') {
      sendContractResponse(
        route,
        response,
        await getAtoms(storage, input as unknown as GetAtomsParams),
      );
      return true;
    }
    if (route === 'POST /v1/wait') {
      sendContractResponse(
        route,
        response,
        await waitForNewTurns(
          storage,
          {
            ...input,
            timeout: input['timeout'] ?? API.limits.default_wait_seconds,
          } as unknown as WaitForNewTurnsParams,
        ),
      );
      return true;
    }
    sendJson(response, 500, { error: `unhandled committed route: ${route}` });
    return true;
  } catch (err) {
    sendJson(response, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  } finally {
    clearTimeout(deadline);
  }
}
