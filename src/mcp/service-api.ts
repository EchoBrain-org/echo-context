import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Ajv, type ValidateFunction } from 'ajv';
import { processCandidate } from '../capture/pipeline.js';
import type { NormalizedContextEvent } from '../normalize/types.js';
import type { Storage } from '../storage/interface.js';
import type { RecentWorkContextResponse } from '../trace/types.js';
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

/** The service-v1 atom schema is frozen independently of the internal
 * normalization model. Keep this as an explicit allowlist projection so new
 * internal context fields cannot accidentally break the committed HTTP API. */
function projectServiceV1Atom(atom: NormalizedContextEvent): NormalizedContextEvent {
  const projected: NormalizedContextEvent = {
    schema_version: atom.schema_version,
    id: atom.id,
    time: {
      occurred_at: atom.time.occurred_at,
      ...(atom.time.observed_at !== undefined ? { observed_at: atom.time.observed_at } : {}),
      ...(atom.time.duration_ms !== undefined ? { duration_ms: atom.time.duration_ms } : {}),
    },
    source: {
      app: atom.source.app,
      ...(atom.source.surface !== undefined ? { surface: atom.source.surface } : {}),
      ...(atom.source.account !== undefined ? { account: atom.source.account } : {}),
      raw_pointer: atom.source.raw_pointer,
    },
    actors: atom.actors.map((actor) => ({
      role: actor.role,
      ...(actor.name !== undefined ? { name: actor.name } : {}),
      ...(actor.model !== undefined ? { model: actor.model } : {}),
      ...(actor.provider !== undefined ? { provider: actor.provider } : {}),
    })),
    action: {
      kind: atom.action.kind,
      ...(atom.action.verb !== undefined ? { verb: atom.action.verb } : {}),
      ...(atom.action.input !== undefined ? { input: atom.action.input } : {}),
      ...(atom.action.output !== undefined ? { output: atom.action.output } : {}),
      ...(atom.action.status !== undefined ? { status: atom.action.status } : {}),
    },
    artifacts: atom.artifacts.map((artifact) => ({
      type: artifact.type,
      provider: artifact.provider,
      id: artifact.id,
      ...(artifact.label !== undefined ? { label: artifact.label } : {}),
      ...(artifact.locator !== undefined ? { locator: artifact.locator } : {}),
    })),
    provenance: {
      source_event_id: atom.provenance.source_event_id,
      raw_payload_hash: atom.provenance.raw_payload_hash,
      extractor_version: atom.provenance.extractor_version,
      ...(atom.provenance.redacted_fields !== undefined
        ? { redacted_fields: atom.provenance.redacted_fields }
        : {}),
      ...(atom.provenance.parse_warnings !== undefined
        ? { parse_warnings: atom.provenance.parse_warnings }
        : {}),
    },
  };

  if (atom.context !== undefined) {
    projected.context = {
      ...(atom.context.visible !== undefined ? { visible: atom.context.visible } : {}),
      ...(atom.context.selected !== undefined ? { selected: atom.context.selected } : {}),
      ...(atom.context.ambient !== undefined ? { ambient: atom.context.ambient } : {}),
    };
  }
  if (atom.state?.snapshot !== undefined) {
    projected.state = {
      snapshot: {
        artifact_id: atom.state.snapshot.artifact_id,
        ...(atom.state.snapshot.hash !== undefined ? { hash: atom.state.snapshot.hash } : {}),
        ...(atom.state.snapshot.summary !== undefined
          ? { summary: atom.state.snapshot.summary }
          : {}),
      },
    };
  } else if (atom.state?.delta !== undefined) {
    projected.state = {
      delta: {
        artifact_id: atom.state.delta.artifact_id,
        kind: atom.state.delta.kind,
        ...(atom.state.delta.detail !== undefined ? { detail: atom.state.delta.detail } : {}),
      },
    };
  }
  if (atom.conversation !== undefined) {
    projected.conversation = {
      provider: atom.conversation.provider,
      session_id: atom.conversation.session_id,
      ...(atom.conversation.turn_index !== undefined
        ? { turn_index: atom.conversation.turn_index }
        : {}),
      ...(atom.conversation.parent_event_id !== undefined
        ? { parent_event_id: atom.conversation.parent_event_id }
        : {}),
    };
  }
  if (atom.open_loop_hints !== undefined) {
    projected.open_loop_hints = atom.open_loop_hints;
  }
  if (atom.warnings !== undefined) projected.warnings = atom.warnings;

  return projected;
}

function projectServiceV1Clusters(
  response: RecentWorkContextResponse,
): RecentWorkContextResponse {
  const atoms: Record<string, NormalizedContextEvent> = {};
  for (const [id, atom] of Object.entries(response.atoms)) {
    atoms[id] = projectServiceV1Atom(atom);
  }
  return { ...response, atoms };
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
        projectServiceV1Clusters(
          await getRecentWorkContext(storage, input as unknown as RecentWorkContextParams),
        ),
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
