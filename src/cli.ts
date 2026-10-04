#!/usr/bin/env node
/**
 * 命令行界面：创建/导入/移动/撤销/重做/查看/回放/导出/列出。
 * 局面以 4x4 文本矩阵展示，移动时用 * 标注新块、[] 标注本步合并产生的块，
 * 矩阵下方以零基 (行,列) 坐标列出合并来源与目标。
 */

import { join } from 'node:path';
import { GameError } from './engine.js';
import { GameService, type PublicGame, type PublicMove } from './service.js';
import { Store } from './store.js';

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const dbPath = process.env.DB_PATH ?? join(dataDir, 'game2048.sqlite');

type Args = { positional: string[]; flags: Map<string, string> };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function parseBoardFlag(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw.split(/[,\s]+/).filter(Boolean).map(Number);
  }
  const arr = data as number[] | number[][];
  if (Array.isArray(arr) && arr.length === 4 && Array.isArray(arr[0])) {
    return (arr as number[][]).flat();
  }
  return arr as number[];
}

function parseSpawn(raw: string | undefined): Array<{ rank: number; value: number }> {
  if (!raw) throw new GameError('INVALID_SPAWN_ITEM', '需要 --spawn，例如 [{"rank":0,"value":2}]');
  return JSON.parse(raw) as Array<{ rank: number; value: number }>;
}

function renderBoard(
  board: number[][],
  opts: { spawn?: { row: number; col: number } | null; merges?: PublicMove['merges'] } = {},
): string {
  const spawnSet = new Set<string>();
  if (opts.spawn) spawnSet.add(`${opts.spawn.row},${opts.spawn.col}`);
  const mergeTargets = new Set<string>();
  for (const m of opts.merges ?? []) {
    mergeTargets.add(`${m.target[0]},${m.target[1]}`);
  }

  const lines: string[] = [];
  lines.push('┌──────────┬──────────┬──────────┬──────────┐');
  board.forEach((rowArr, r) => {
    const cells = rowArr.map((v, c) => {
      const key = `${r},${c}`;
      if (v === 0) return '    .     ';
      if (spawnSet.has(key)) return ` >${String(v).padStart(4, ' ')}<  `.slice(0, 10);
      if (mergeTargets.has(key)) return `[${String(v).padStart(4, ' ')}]   `.slice(0, 10);
      return ` ${String(v).padStart(4, ' ')}    `.slice(0, 10);
    });
    lines.push(`│${cells.join('│')}│`);
    if (r < 3) lines.push('├──────────┼──────────┼──────────┼──────────┤');
  });
  lines.push('└──────────┴──────────┴──────────┴──────────┘');

  for (const m of opts.merges ?? []) {
    const [tr, tc] = m.target;
    const s = m.sources.map(([r, c]) => `(${r},${c})`).join(' + ');
    lines.push(`  合并 ${s} -> (${tr},${tc}) = ${m.value}，得分 +${m.gained}`);
  }
  if (opts.spawn) {
    lines.push(`  新块 >< 位于 (${opts.spawn.row},${opts.spawn.col}) = ${board[opts.spawn.row]![opts.spawn.col]!}`);
  }
  return lines.join('\n');
}

function printGame(g: PublicGame): void {
  console.log(`对局 ${g.id}    得分 ${g.score}    步数 ${g.headSeq}/${g.moves}    生成游标 ${g.spawnCursor}（剩余 ${g.remainingInstructions} 条）`);
  console.log(renderBoard(g.board));
  const flags: string[] = [];
  if (g.reached2048) flags.push('已达标2048(可继续)');
  flags.push(g.gameOver ? '游戏结束(无合法移动)' : '仍可移动');
  flags.push(`可撤销:${g.canUndo}`, `可重做:${g.canRedo}`);
  console.log(flags.join('  |  '));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, id] = args.positional;
  const store = new Store(dbPath);
  const service = new GameService(store);

  try {
    switch (command) {
      case 'create':
      case 'import': {
        if (!id) throw new GameError('BAD_REQUEST', '用法: create <id> --spawn <json> [--board <json>] [--max-value 2048]');
        const game = service.create(id, {
          board: parseBoardFlag(args.flags.get('board')),
          spawnQueue: parseSpawn(args.flags.get('spawn')),
          maxValue: args.flags.has('max-value') ? Number(args.flags.get('max-value')) : undefined,
        });
        printGame(game);
        break;
      }
      case 'move': {
        if (!id) throw new GameError('BAD_REQUEST', '用法: move <id> --direction up|down|left|right');
        const result: PublicMove = service.move(id, mustDirection(args.flags.get('direction')));
        if (!result.moved) {
          console.log(`空移动（方向 ${result.direction}）：棋盘无变化，不加分，未消耗生成指令，步数不变`);
        } else {
          console.log(`第 ${result.seq} 步 方向 ${result.direction}  得分 ${result.score}（+${result.gained}）  游标 ${result.cursor}（剩余 ${result.remainingInstructions}）`);
        }
        console.log(renderBoard(result.board, { spawn: result.spawn, merges: result.merges }));
        console.log(result.gameOver ? '游戏结束：无空格且横纵均不能合并' : '仍有合法移动');
        break;
      }
      case 'undo':
        printGame(service.undo(id!));
        break;
      case 'redo':
        printGame(service.redo(id!));
        break;
      case 'show':
      case 'status':
        printGame(service.status(id!));
        break;
      case 'history': {
        const history = service.history(id!);
        if (history.length === 0) console.log('（暂无移动历史）');
        for (const m of history) {
          console.log(`#${m.seq} ${m.direction} 得分 ${m.scoreBefore} -> ${m.scoreAfter} (+${m.gained}) 游标 ${m.cursorBefore}->${m.cursorAfter}`);
        }
        break;
      }
      case 'replay': {
        const steps = service.replay(id!);
        if (steps.length === 0) console.log('（暂无历史可回放）');
        for (const s of steps) {
          console.log(`\n=== 回放第 ${s.seq} 步：${s.direction}（得分 ${s.score}，+${s.gained}）===`);
          console.log(renderBoard(s.board, { spawn: s.spawn, merges: s.merges }));
        }
        break;
      }
      case 'export':
        console.log(JSON.stringify(service.exportJson(id!), null, 2));
        break;
      case 'list': {
        const games = service.list();
        if (games.length === 0) console.log('（暂无对局）');
        for (const g of games) {
          console.log(`${g.id}  得分 ${g.score}  步数 ${g.headSeq}/${g.moves}  2048:${g.reached2048 ? '是' : '否'}`);
        }
        break;
      }
      default:
        usage();
        if (command) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof GameError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      process.exitCode = 1;
    } else {
      console.error('错误:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function mustDirection(raw: string | undefined): 'up' | 'down' | 'left' | 'right' {
  if (raw === 'up' || raw === 'down' || raw === 'left' || raw === 'right') return raw;
  throw new GameError('INVALID_DIRECTION', `--direction 必须为 up/down/left/right，实际为 ${String(raw)}`);
}

function usage(): void {
  console.log([
    '2048 本地后端 CLI',
    '',
    '用法:',
    '  npm run cli -- create <id> --spawn \'[{"rank":0,"value":2}]\' [--board \'<4x4或16数组>\'] [--max-value 2048]',
    '  npm run cli -- import <id> --spawn \'<json>\' --board \'<json>\'',
    '  npm run cli -- move <id> --direction up|down|left|right',
    '  npm run cli -- undo <id> | redo <id> | show <id>',
    '  npm run cli -- history <id> | replay <id> | export <id> | list',
    '',
    '矩阵标注: . 为空; [N] 为本步合并产生; >< 为本步注入新块;',
    '合并来源以零基 (行,列) 坐标列在矩阵下方。',
    '数据库默认位于项目内 data/game2048.sqlite，可用环境变量 DB_PATH 覆盖。',
  ].join('\n'));
}

void main();
