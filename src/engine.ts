import { GameError } from './errors.js';

export const SIZE = 4;
export const MAX_TILE = 2097152; // 2^21，合并成 2^22（4194304）视为超限
export const WIN_TILE = 2048;

export type Direction = 'up' | 'down' | 'left' | 'right';
export const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];

/** 一条生成指令：按行优先枚举空格后的零基排名，以及注入值（2 或 4） */
export interface SpawnInstruction {
  rank: number;
  value: 2 | 4;
}

/** 一次合并的明细：两个来源格 -> 目标格 */
export interface MergeRecord {
  sources: Array<[number, number]>;
  target: [number, number];
  value: number;
  gained: number;
}

/** 一个非零方块的移动轨迹（未合并），用于解释来源 */
export interface MoveRecord {
  from: [number, number];
  to: [number, number];
  value: number;
}

export interface MoveResult {
  board: number[][];
  gained: number;
  merges: MergeRecord[];
  moves: MoveRecord[];
  spawned: { cell: [number, number]; value: 2 | 4; index: number };
  changed: boolean;
}

export type Board = number[][];

export function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(0));
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

export function boardsEqual(a: Board, b: Board): boolean {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (a[r]![c] !== b[r]![c]) return false;
    }
  }
  return true;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

/** 校验导入局面：尺寸 4x4，格子为 0 或 2 的正整数次幂，且不超过上限 */
export function validateBoard(input: unknown): Board {
  if (!Array.isArray(input) || input.length !== SIZE) {
    throw new GameError('INVALID_BOARD_SIZE', '棋盘必须为 4 行，每行 4 个数字');
  }
  const board: Board = [];
  for (const rawRow of input) {
    if (!Array.isArray(rawRow) || rawRow.length !== SIZE) {
      throw new GameError('INVALID_BOARD_SIZE', '棋盘必须为 4 行，每行 4 个数字');
    }
    const row: number[] = [];
    for (const cell of rawRow) {
      if (typeof cell !== 'number' || !Number.isFinite(cell)) {
        throw new GameError('INVALID_CELL_VALUE', '格子必须为数字');
      }
      if (cell !== 0 && !isPowerOfTwo(cell)) {
        throw new GameError('INVALID_CELL_VALUE', `格子 ${cell} 不是 0 或 2 的正整数次幂`);
      }
      if (cell > MAX_TILE) {
        throw new GameError('TILE_VALUE_OVERFLOW', `格子 ${cell} 超过数值上限 ${MAX_TILE}`);
      }
      row.push(cell);
    }
    board.push(row);
  }
  return board;
}

export function validateDirection(dir: unknown): Direction {
  if (typeof dir === 'string' && (DIRECTIONS as readonly string[]).includes(dir)) {
    return dir as Direction;
  }
  throw new GameError('INVALID_DIRECTION', `非法方向：${String(dir)}，允许 up/down/left/right`);
}

export function validateSpawns(input: unknown): SpawnInstruction[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new GameError('BAD_REQUEST', 'spawns 必须为数组');
  }
  const list: SpawnInstruction[] = [];
  for (const item of input) {
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof (item as { rank?: unknown }).rank !== 'number' ||
      !Number.isInteger((item as { rank: number }).rank) ||
      (item as { rank: number }).rank < 0
    ) {
      throw new GameError('BAD_REQUEST', '每条生成指令必须包含非负整数 rank');
    }
    const value = (item as { value?: unknown }).value;
    if (value !== 2 && value !== 4) {
      throw new GameError('BAD_REQUEST', '每条生成指令的 value 必须为 2 或 4');
    }
    list.push({ rank: (item as { rank: number }).rank, value });
  }
  return list;
}

/** 返回某一方向上的四条线，每条线按“近端 -> 远端”排列，元素为坐标 */
function linesFor(dir: Direction): Array<Array<[number, number]>> {
  const lines: Array<Array<[number, number]>> = [];
  for (let k = 0; k < SIZE; k++) {
    const line: Array<[number, number]> = [];
    for (let i = 0; i < SIZE; i++) {
      if (dir === 'left') line.push([k, i]);
      else if (dir === 'right') line.push([k, SIZE - 1 - i]);
      else if (dir === 'up') line.push([i, k]);
      else line.push([SIZE - 1 - i, k]); // down
    }
    lines.push(line);
  }
  return lines;
}

/** 仅执行压缩与相邻合并（不注入新块） */
export function slideBoard(
  source: Board,
  dir: Direction,
): { board: Board; gained: number; merges: MergeRecord[]; moves: MoveRecord[]; changed: boolean } {
  const output = emptyBoard();
  const merges: MergeRecord[] = [];
  const moves: MoveRecord[] = [];
  let gained = 0;

  for (const line of linesFor(dir)) {
    // 取出近 -> 远 的非零方块
    const tiles: Array<{ value: number; from: [number, number] }> = [];
    for (const [r, c] of line) {
      const v = source[r]![c]!;
      if (v !== 0) tiles.push({ value: v, from: [r, c] });
    }

    const placed: Array<{ value: number; origins: Array<[number, number]> }> = [];
    let idx = 0;
    while (idx < tiles.length) {
      const current = tiles[idx]!;
      const next = tiles[idx + 1];
      if (next && next.value === current.value) {
        const merged = current.value * 2;
        if (merged > MAX_TILE) {
          throw new GameError(
            'TILE_VALUE_OVERFLOW',
            `合并结果 ${merged} 超过数值上限 ${MAX_TILE}，本次移动回滚`,
            422,
          );
        }
        placed.push({ value: merged, origins: [current.from, next.from] });
        gained += merged;
        idx += 2;
      } else {
        placed.push({ value: current.value, origins: [current.from] });
        idx += 1;
      }
    }

    placed.forEach((entry, pos) => {
      const [tr, tc] = line[pos]!;
      output[tr]![tc] = entry.value;
      if (entry.origins.length === 2) {
        merges.push({
          sources: entry.origins,
          target: [tr, tc],
          value: entry.value,
          gained: entry.value,
        });
      } else {
        const origin = entry.origins[0]!;
        if (origin[0] !== tr || origin[1] !== tc) {
          moves.push({ from: origin, to: [tr, tc], value: entry.value });
        }
      }
    });
  }

  return { board: output, gained, merges, moves, changed: !boardsEqual(source, output) };
}

/** 按行优先枚举空格 */
export function emptyCells(board: Board): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r]![c] === 0) cells.push([r, c]);
    }
  }
  return cells;
}

/**
 * 执行一次完整移动（含确定性注入）。
 * 棋盘无变化 -> NO_EFFECT_MOVE（不消耗指令）。
 * 指令不足 -> SPAWN_QUEUE_EXHAUSTED；排名越界 -> SPAWN_RANK_OUT_OF_RANGE；均不改变棋盘。
 * 超限合并 -> TILE_VALUE_OVERFLOW。
 */
export function applyMove(source: Board, dir: Direction, spawn: SpawnInstruction): MoveResult {
  const slided = slideBoard(source, dir);
  if (!slided.changed) {
    throw new GameError('NO_EFFECT_MOVE', `方向 ${dir} 未改变棋盘，不加分、不消耗生成指令`, 409);
  }

  const empties = emptyCells(slided.board);
  if (spawn.rank >= empties.length) {
    throw new GameError(
      'SPAWN_RANK_OUT_OF_RANGE',
      `生成排名 ${spawn.rank} 越界（当前仅有 ${empties.length} 个空格），本次移动失败`,
      422,
    );
  }
  const [sr, sc] = empties[spawn.rank]!;
  const board = slided.board;
  board[sr]![sc] = spawn.value;

  return {
    board,
    gained: slided.gained,
    merges: slided.merges,
    moves: slided.moves,
    spawned: { cell: [sr, sc], value: spawn.value, index: spawn.rank },
    changed: true,
  };
}

/** 预判某方向是否为有效移动（不注入、不抛 NO_EFFECT） */
export function canMoveInDirection(board: Board, dir: Direction): boolean {
  try {
    return slideBoard(board, dir).changed;
  } catch {
    return false;
  }
}

export function hasLegalMove(board: Board): boolean {
  if (emptyCells(board).length > 0) return true;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board[r]![c]!;
      if (c + 1 < SIZE && board[r]![c + 1] === v) return true;
      if (r + 1 < SIZE && board[r + 1]![c] === v) return true;
    }
  }
  return false;
}

export function maxTile(board: Board): number {
  let max = 0;
  for (const row of board) for (const v of row) if (v > max) max = v;
  return max;
}

export function tileSum(board: Board): number {
  let sum = 0;
  for (const row of board) for (const v of row) sum += v;
  return sum;
}
