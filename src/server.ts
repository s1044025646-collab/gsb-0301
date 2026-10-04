/**
 * 纯 Node.js HTTP API 服务器（无第三方框架）。
 * 默认端口 0 表示由操作系统分配空闲端口，也可用 PORT 环境变量或 --port 指定。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { GameError, type ErrorCode } from './engine.js';
import { GameService, type CreateOptions } from './service.js';
import { Store } from './store.js';

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const dbPath = process.env.DB_PATH ?? join(dataDir, 'game2048.sqlite');

export interface RunningServer {
  server: Server;
  port: number;
  close: () => void;
}

export function startServer(port = 0): Promise<RunningServer> {
  const store = new Store(dbPath);
  const service = new GameService(store);

  const server = createServer((req, res) => {
    handle(req, res, service).catch((err) => sendError(res, err));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        close: () => server.close(() => store.close()),
      });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, service: GameService): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  // 健康检查
  if (method === 'GET' && path === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  const gameMatch = path.match(/^\/api\/games\/([^/]+)(?:\/(move|undo|redo|history|replay|export))?$/);
  if (method === 'POST' && path === '/api/games') {
    const body = await readJson(req);
    if (!body || typeof body.id !== 'string' || body.id.trim() === '') {
      throw new GameError('BAD_REQUEST', '创建对局需要字符串字段 id');
    }
    const opts: CreateOptions = {
      board: body.board ? flattenBoard(body.board) : undefined,
      spawnQueue: normalizeSpawnQueue(body.spawnQueue),
      maxValue: body.maxValue,
    };
    return sendJson(res, 201, service.create(body.id, opts));
  }

  if (method === 'GET' && path === '/api/games') {
    return sendJson(res, 200, { games: service.list() });
  }

  if (gameMatch) {
    const id = decodeURIComponent(gameMatch[1]!);
    const action = gameMatch[2];
    if (!action && method === 'GET') {
      return sendJson(res, 200, service.status(id));
    }
    if (action === 'move' && method === 'POST') {
      const body = await readJson(req);
      const direction = body?.direction;
      if (typeof direction !== 'string') {
        throw new GameError('INVALID_DIRECTION', '移动需要 direction 字段（up/down/left/right）');
      }
      return sendJson(res, 200, service.move(id, normalizeDirection(direction)));
    }
    if (action === 'undo' && method === 'POST') return sendJson(res, 200, service.undo(id));
    if (action === 'redo' && method === 'POST') return sendJson(res, 200, service.redo(id));
    if (action === 'history' && method === 'GET') {
      return sendJson(res, 200, { history: service.history(id) });
    }
    if (action === 'replay' && method === 'GET') {
      return sendJson(res, 200, { steps: service.replay(id) });
    }
    if (action === 'export' && method === 'GET') {
      return sendJson(res, 200, service.exportJson(id));
    }
  }

  sendError(res, new GameError('BAD_REQUEST', `未找到路由：${method} ${path}`), 404);
}

function normalizeDirection(d: string): 'up' | 'down' | 'left' | 'right' {
  if (d === 'up' || d === 'down' || d === 'left' || d === 'right') return d;
  throw new GameError('INVALID_DIRECTION', `非法方向 ${d}，合法值为 up/down/left/right`);
}

/** 接受 4x4 二维数组，也接受长度 16 的一维数组。 */
function flattenBoard(input: unknown): number[] {
  if (Array.isArray(input) && input.length === 4 && input.every((r) => Array.isArray(r) && r.length === 4)) {
    return (input as unknown[][]).flat().map((v) => Number(v));
  }
  if (Array.isArray(input) && input.length === 16) {
    return input.map((v) => Number(v));
  }
  throw new GameError('INVALID_BOARD_SIZE', 'board 必须是 4x4 二维数组或长度 16 的一维数组');
}

function normalizeSpawnQueue(input: unknown) {
  if (!Array.isArray(input)) {
    throw new GameError('INVALID_SPAWN_ITEM', 'spawnQueue 必须是 [{rank,value},...] 形式的数组');
  }
  return input.map((item: unknown, i: number) => {
    const o = item as { rank?: unknown; value?: unknown } | null;
    const rank = Number(o?.rank);
    const value = Number(o?.value);
    if (!o || !Number.isInteger(rank) || rank < 0 || (value !== 2 && value !== 4)) {
      throw new GameError('INVALID_SPAWN_ITEM', `第 ${i} 条生成指令非法：rank 为非负整数，value 只能为 2 或 4`);
    }
    return { rank, value };
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GameError('BAD_REQUEST', '请求体不是合法 JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  INVALID_DIRECTION: 400,
  INVALID_BOARD_SIZE: 400,
  INVALID_CELL_VALUE: 400,
  INVALID_SPAWN_ITEM: 400,
  DUPLICATE_GAME_ID: 409,
  GAME_NOT_FOUND: 404,
  NO_EFFECTIVE_MOVE: 409,
  SPAWN_QUEUE_EXHAUSTED: 409,
  SPAWN_RANK_OUT_OF_RANGE: 409,
  VALUE_LIMIT_EXCEEDED: 422,
  NOTHING_TO_UNDO: 409,
  NOTHING_TO_REDO: 409,
};

function sendError(res: ServerResponse, err: unknown, statusOverride?: number): void {
  if (err instanceof GameError) {
    const status = statusOverride ?? STATUS_BY_CODE[err.code] ?? 400;
    sendJson(res, status, { error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: 'INTERNAL', message } });
}

// 直接运行时启动服务。
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const argPort = (() => {
    const i = process.argv.indexOf('--port');
    if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
    return undefined;
  })();
  const port = argPort ?? (process.env.PORT ? Number(process.env.PORT) : 0);
  startServer(port).then(({ port: actual }) => {
    console.log(`2048 后端已启动: http://127.0.0.1:${actual}`);
    console.log(`数据库: ${dbPath}`);
  });
}
