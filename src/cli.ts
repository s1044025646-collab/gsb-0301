#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { GameError } from './errors.js';
import { GameService } from './service.js';
import { Store } from './storage.js';
import { createApp, listen } from './server.js';
import { renderBoard, renderGame, renderMerges } from './render.js';

const DATA_DIR = resolve(process.cwd(), 'data');
const DB_PATH = resolve(DATA_DIR, '2048.sqlite');

interface ParsedArgs {
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

function loadBoardFlag(flags: Map<string, string>): unknown {
  const file = flags.get('board-file');
  if (file) return JSON.parse(readFileSync(resolve(file), 'utf-8'));
  const inline = flags.get('board');
  if (inline !== undefined) return JSON.parse(inline);
  return undefined;
}

function loadSpawnsFlag(flags: Map<string, string>): unknown {
  const file = flags.get('spawns-file');
  if (file) return JSON.parse(readFileSync(resolve(file), 'utf-8'));
  const inline = flags.get('spawns');
  if (inline !== undefined) return JSON.parse(inline);
  return undefined;
}

function printHelp(): void {
  console.log(`gsb2048 - 2048 棋盘后端 CLI（数据目录: ${DATA_DIR}）

用法:
  node dist-build/src/cli.js serve [--port 8080]
  node dist-build/src/cli.js create --id G1 [--board '<4x4 JSON>'] [--board-file f.json] [--spawns '[{\"rank\":0,\"value\":2}]'] [--spawns-file s.json]
  node dist-build/src/cli.js import --id G1 --board-file board.json [--spawns-file spawns.json]
  node dist-build/src/cli.js list
  node dist-build/src/cli.js show --id G1 [--verbose]
  node dist-build/src/cli.js move --id G1 --direction left|right|up|down
  node dist-build/src/cli.js undo --id G1
  node dist-build/src/cli.js redo --id G1
  node dist-build/src/cli.js replay --id G1
  node dist-build/src/cli.js export --id G1

不加 --port 时默认选择操作系统分配的空闲端口。`);
}

async function main(): Promise<void> {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const command = positionals[0];
  if (!command || command === 'help' || command === '--help' || flags.has('help')) {
    printHelp();
    return;
  }

  if (command === 'serve') {
    const store = new Store(DB_PATH);
    const server = createApp(new GameService(store));
    const port = Number(flags.get('port') ?? process.env.PORT ?? 0);
    const { port: actual } = await listen(server, Number.isFinite(port) ? port : 0);
    console.log(`2048 API 已启动: http://127.0.0.1:${actual}`);
    console.log(`数据库: ${DB_PATH}`);
    return;
  }

  const store = new Store(DB_PATH);
  try {
    const service = new GameService(store);
    switch (command) {
      case 'create':
      case 'import': {
        const id = flags.get('id');
        if (!id) throw new GameError('BAD_REQUEST', '必须提供 --id');
        const game = service.create(id, loadBoardFlag(flags), loadSpawnsFlag(flags));
        console.log(renderGame(game, true));
        break;
      }
      case 'list': {
        const games = service.list();
        if (games.length === 0) console.log('（暂无对局）');
        for (const g of games) {
          console.log(`${g.id}  得分:${g.score}  步数:${g.moveCount}  结束:${g.gameOver}  创建:${g.createdAt}`);
        }
        break;
      }
      case 'show': {
        const game = service.get(requireId(flags));
        console.log(renderGame(game, flags.has('verbose')));
        break;
      }
      case 'move': {
        const dir = flags.get('direction');
        const before = service.get(requireId(flags));
        const game = service.move(before.id, dir);
        const last = game.history[game.history.length - 1];
        console.log(renderBoard(game.board, {
          merges: last?.merges,
          moves: last?.moves,
          spawnCell: last?.spawnCell,
        }));
        if (last) {
          console.log(`方向: ${last.direction}  本步得分: +${last.gained}  累计: ${game.score}`);
          console.log(renderMerges(last.merges));
          console.log(`注入: 空格排名 ${last.spawn.rank} 放入 ${last.spawn.value} 于 (${last.spawnCell[0]},${last.spawnCell[1]})`);
        }
        console.log(`可撤销: ${game.canUndo}  可重做: ${game.canRedo}  结束: ${game.gameOver}`);
        break;
      }
      case 'undo': {
        const game = service.undo(requireId(flags));
        console.log('已撤销一步：');
        console.log(renderGame(game));
        break;
      }
      case 'redo': {
        const game = service.redo(requireId(flags));
        console.log('已重做一步：');
        console.log(renderGame(game));
        break;
      }
      case 'replay': {
        const replay = service.replay(requireId(flags));
        console.log(`对局 ${replay.id} 逐步回放（共 ${replay.steps.length} 步）`);
        console.log('初始局面:');
        console.log(renderBoard(replay.initialBoard));
        for (const step of replay.steps) {
          console.log(`\n第 ${step.seq} 步: ${step.direction}（+${step.gained}）`);
          console.log(renderBoard(step.toBoard, {
            merges: step.merges,
            moves: step.moves,
            spawnCell: step.spawnCell,
          }));
          console.log(renderMerges(step.merges));
        }
        break;
      }
      case 'export': {
        console.log(JSON.stringify(service.exportJson(requireId(flags)), null, 2));
        break;
      }
      default:
        throw new GameError('BAD_REQUEST', `未知命令: ${command}`);
    }
  } finally {
    store.close();
  }
}

function requireId(flags: Map<string, string>): string {
  const id = flags.get('id');
  if (!id) throw new GameError('BAD_REQUEST', '必须提供 --id');
  return id;
}

main().catch((err: unknown) => {
  if (err instanceof GameError) {
    console.error(`错误 [${err.code}] ${err.message}`);
  } else {
    console.error('错误 [INTERNAL_ERROR]', err);
  }
  process.exit(1);
});
