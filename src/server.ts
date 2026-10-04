import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { GameError } from './errors.js';
import { GameService } from './service.js';

interface ApiResponse {
  ok: boolean;
  error?: { code: string; message: string };
  data?: unknown;
}

function send(res: ServerResponse, status: number, body: ApiResponse): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new GameError('BAD_REQUEST', '请求体不是合法 JSON');
  }
}

export function createApp(service: GameService): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, data: { status: 'up' } });
      }

      if (method === 'GET' && path === '/api/games') {
        return send(res, 200, { ok: true, data: service.list() });
      }

      if (method === 'POST' && path === '/api/games') {
        const body = (await readJson(req)) as { id?: unknown; board?: unknown; spawns?: unknown };
        if (typeof body.id !== 'string' || body.id.trim() === '') {
          throw new GameError('BAD_REQUEST', '必须提供非空字符串 id');
        }
        const game = service.create(body.id.trim(), body.board, body.spawns);
        return send(res, 201, { ok: true, data: game });
      }

      const match = path.match(/^\/api\/games\/([^/]+)(\/(move|undo|redo|replay|export))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        const action = match[3];
        if (!action && method === 'GET') {
          return send(res, 200, { ok: true, data: service.get(id) });
        }
        if (action === 'move' && method === 'POST') {
          const body = (await readJson(req)) as { direction?: unknown };
          return send(res, 200, { ok: true, data: service.move(id, body.direction) });
        }
        if (action === 'undo' && method === 'POST') {
          return send(res, 200, { ok: true, data: service.undo(id) });
        }
        if (action === 'redo' && method === 'POST') {
          return send(res, 200, { ok: true, data: service.redo(id) });
        }
        if (action === 'replay' && method === 'GET') {
          return send(res, 200, { ok: true, data: service.replay(id) });
        }
        if (action === 'export' && method === 'GET') {
          res.setHeader('Content-Disposition', `attachment; filename="${id}-2048.json"`);
          const json = JSON.stringify(service.exportJson(id), null, 2);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(json);
        }
      }

      send(res, 404, { ok: false, error: { code: 'BAD_REQUEST', message: `未找到路由 ${method} ${path}` } });
    } catch (err) {
      if (err instanceof GameError) {
        return send(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
      }
      const message = err instanceof Error ? err.message : String(err);
      send(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message } });
    }
  });
}

/** 选择空闲端口：port=0 时由操作系统分配 */
export function listen(server: Server, port: number): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ port: address.port });
    });
  });
}
