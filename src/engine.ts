/**
 * 2048 纯规则引擎：不依赖数据库或网络，便于单元测试与复用。
 *
 * 棋盘固定 4x4，行优先存储为长度 16 的数组，0 表示空格。
 * 非空格取值为 2 的正整数次幂（2,4,8,...）。
 */

export const SIZE = 4;
export const CELLS = SIZE * SIZE;

export type Direction = 'up' | 'down' | 'left' | 'right';
export const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];

/** 单条生成指令：rank 为按行优先枚举空格的零基排名，value 为 2 或 4。 */
export interface SpawnItem {
  rank: number;
  value: number;
  // 合并阶段：把近端子配对成合并块，其余为未合并块，均保持近端到远端顺序。
  const seq: Array<{ index: number; value: number }> = tiles.map((index) => ({
    index,
    value: board[index]!,
  }));

  const merged: Array<{ value: number; isMerge: boolean }> = [];
  for (let i = 0; i < seq.length; i++) {
    const cur = seq[i]!;
    const next = seq[i + 1];
    if (next && cur.value === next.value) {
      const nv = cur.value * 2;
      if (nv > limit) {
        throw new GameError('VALUE_LIMIT_EXCEEDED', `合并结果 ${nv} 超过数值上限 ${limit}，本次移动已回滚`);
      }
      merges.push({
        sources: [rc(cur.index), rc(next.index)],
        target: [0, 0], // 落位后补齐
        value: nv,
        gained: nv,
      });
      merged.push({ value: nv, isMerge: true });
      i++; // 两个原方块均已消耗，跳过下一个
    } else {
      merged.push({ value: cur.value, isMerge: false });
    }
  }

  // 再次压缩并落位：merged 已是近端到远端顺序，依次放到线的近端。
  let mergeCursor = 0;
  for (let p = 0; p < line.length; p++) {
    const targetIndex = line[p]!;
    const item = merged[p];
    if (item) {
      out[targetIndex] = item.value;
      if (item.isMerge) {
        merges[mergeCursor]!.target = rc(targetIndex);
        mergeCursor++;
      }
    } else {
      out[targetIndex] = 0;
    }
  }
}

/** 一次合并的解释明细：来源格 -> 目标格（坐标均为零基 [行,列]）。 */
export interface MergeRecord {
  sources: Array<[number, number]>;
  target: [number, number];
  value: number;
  gained: number;
}

/** 一次移动的完整结果（在生成新块之前/之后均可表达）。 */
export interface MoveResult {
  before: number[];
  /** 压缩合并后、注入新块前的棋盘 */
  mergedBoard: number[];
  after: number[];
  direction: Direction;
  moved: boolean;
  gained: number;
  merges: MergeRecord[];
  /** 本次注入的新块；生成失败时为 null */
  spawn: { index: number; row: number; col: number; value: number } | null;
  /** 本次消耗的生成指令序号（游标旧值） */
  spawnCursor: number | null;
  /** 移动后是否仍存在合法移动 */
  canMove: boolean;
  /** 移动后是否已达到目标值 2048 */
  reached2048: boolean;
}

export interface GameState {
  board: number[];
  score: number;
  spawnCursor: number;
  reached2048: boolean;
  moves: number;
}

export const TARGET_VALUE = 2048;

/** 业务错误：携带稳定错误码，供 API/CLI 统一返回。 */
export class GameError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

export type ErrorCode =
  | 'INVALID_DIRECTION'
 | 'INVALID_BOARD_SIZE'
  | 'INVALID_CELL_VALUE'
  | 'DUPLICATE_GAME_ID'
  | 'GAME_NOT_FOUND'
  | 'NO_EFFECTIVE_MOVE'
  | 'SPAWN_QUEUE_EXHAUSTED'
  | 'SPAWN_RANK_OUT_OF_RANGE'
  | 'VALUE_LIMIT_EXCEEDED'
  | 'NOTHING_TO_UNDO'
  | 'NOTHING_TO_REDO'
  | 'INVALID_SPAWN_ITEM'
  | 'BAD_REQUEST';

/** 是否为 2 的正整数次幂（最小为 2）。 */
export function isPowerOfTwo(v: number): boolean {
  return Number.isInteger(v) && v >= 2 && (v & (v - 1)) === 0;
}

export function validateBoard(board: number[]): void {
  if (!Array.isArray(board) || board.length !== CELLS) {
    throw new GameError('INVALID_BOARD_SIZE', `棋盘必须是长度 ${CELLS} 的数组，实际长度 ${Array.isArray(board) ? board.length : typeof board}`);
  }
  for (const v of board) {
    if (!Number.isInteger(v) || v < 0 || !isPowerOfTwo(v) && v !== 0) {
      throw new GameError('INVALID_CELL_VALUE', `格子只能为 0 或 2 的正整数次幂，发现非法值 ${String(v)}`);
    }
  }
}

export function validateDirection(d: string): asserts d is Direction {
  if (!DIRECTIONS.includes(d as Direction)) {
    throw new GameError('INVALID_DIRECTION', `非法方向 ${String(d)}，合法值为 ${DIRECTIONS.join('/')}`);
  }
}

export function validateSpawnQueue(queue: SpawnItem[]): void {
  if (!Array.isArray(queue)) {
    throw new GameError('INVALID_SPAWN_ITEM', '生成指令必须是数组');
  }
  queue.forEach((item, i) => {
    if (
      item === null ||
      typeof item !== 'object' ||
      !Number.isInteger(item.rank) ||
      item.rank < 0 ||
      (item.value !== 2 && item.value !== 4)
    ) {
      throw new GameError('INVALID_SPAWN_ITEM', `第 ${i} 条生成指令非法：rank 需为非负整数，value 只能为 2 或 4`);
    }
  });
}

const rc = (index: number): [number, number] => [Math.floor(index / SIZE), index % SIZE];
const idx = (row: number, col: number): number => row * SIZE + col;

/**
 * 返回某方向上四条“移动线”对应的棋盘下标。
 * 每条线按“移动方向近端 -> 远端”排序，
 * 因此左移每行从左到右、右移从右到左、上移从上到下、下移从下到上。
 */
function linesFor(direction: Direction): number[][] {
  const lines: number[][] = [];
  if (direction === 'left' || direction === 'right') {
    for (let r = 0; r < SIZE; r++) {
      const line: number[] = [];
      for (let c = 0; c < SIZE; c++) {
        line.push(idx(r, direction === 'left' ? c : SIZE - 1 - c));
      }
      lines.push(line);
    }
  } else {
    for (let c = 0; c < SIZE; c++) {
      const line: number[] = [];
      for (let r = 0; r < SIZE; r++) {
        line.push(idx(direction === 'up' ? r : SIZE - 1 - r, c));
      }
      lines.push(line);
    }
  }
  return lines;
}

/**
 * 处理一条移动线（下标已按近端到远端排序）。
 * 规则：先压缩，再从近端开始相邻合并（每个原方块最多参与一次，
 * 新形成方块不参与本次合并），最后再次压缩。
 * 就地写入 out，并把合并明细追加到 merges。
 */
function processLine(
  line: number[],
  board: number[],
  out: number[],
  merges: MergeRecord[],
  limit: number,
): void {
  // 压缩：收集非空格的原下标（保持近端到远端顺序）。
  const tiles = line.filter((i) => board[i] !== 0);

  // 合并阶段：每个 tile 记录 {index, value}，合并后 consumed 标记。
  const seq: Array<{ index: number; value: number; dead: boolean }> = tiles.map((index) => ({
    index,
    value: board[index]!,
    dead: false,
  }));

  const merged: Array<{ src: [number, number]; value: number; mergedFrom?: [number, number] }> = [];
  for (let i = 0; i < seq.length; i++) {
    const cur = seq[i]!;
    const next = seq[i + 1];
    if (next && !cur.dead && !next.dead && cur.value === next.value) {
      const nv = cur.value * 2;
      if (nv > limit) {
        throw new GameError('VALUE_LIMIT_EXCEEDED', `合并结果 ${nv} 超过数值上限 ${limit}，本次移动已回滚`);
      }
      merges.push({
        sources: [rc(cur.index), rc(next.index)],
        target: [0, 0], // 目标坐标在压缩落位后补齐
        value: nv,
        gained: nv,
      });
      merged.push({ src: rc(cur.index), value: nv, mergedFrom: rc(next.index) });
      cur.dead = true;
      next.dead = true;
      i++; // 下一个方块已被消耗，跳过
    } else if (!cur.dead) {
      merged.push({ src: rc(cur.index), value: cur.value });
    }
  }

  // 再次压缩并落位：merged 已是近端到远端顺序，依次放到线的近端。
  for (let p = 0; p < line.length; p++) {
    const targetIndex = line[p]!;
    const item = merged[p];
    if (item) {
      out[targetIndex] = item.value;
      if (item.mergedFrom) {
        const rec = merges.find(
          (m) => m.value === item.value && m.target[0] === 0 && m.target[1] === 0 &&
            m.sources[0]?.[0] === item.src[0] && m.sources[0]?.[1] === item.src[1],
        );
        if (rec) rec.target = rc(targetIndex);
      }
    } else {
      out[targetIndex] = 0;
    }
  }
}

/** 按行优先枚举空格下标。 */
export function emptyCells(board: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) if (board[i] === 0) out.push(i);
  return out;
}

export function hasWon(board: number[]): boolean {
  return board.some((v) => v >= TARGET_VALUE);
}

/**
 * 是否存在合法移动：有空格，或横/纵存在相等相邻块。
 * 游戏结束仅当没有空格且横纵均不能合并。
 */
export function canMove(board: number[]): boolean {
  if (board.some((v) => v === 0)) return true;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board[idx(r, c)]!;
      if (c + 1 < SIZE && board[idx(r, c + 1)] === v) return true;
      if (r + 1 < SIZE && board[idx(r + 1, c)] === v) return true;
    }
  }
  return false;
}

/**
 * 执行一次移动。
 * - 空移动：返回 moved=false，不加分、不消耗生成指令。
 * - 有效移动：先压缩合并，再用 spawnCursor 指向的指令注入新块；
 *   若指令不存在或 rank 越界，抛出异常（调用方需保证整体状态不变）。
 * - 合并超限抛出 VALUE_LIMIT_EXCEEDED。
 */
export function applyMove(
  state: GameState,
  direction: Direction,
  queue: SpawnItem[],
  limit: number,
): MoveResult {
  validateDirection(direction);
  const before = state.board.slice();
  const mergedBoard = new Array<number>(CELLS).fill(0);
  const merges: MergeRecord[] = [];

  for (const line of linesFor(direction)) {
    processLine(line, state.board, mergedBoard, merges, limit);
  }

  const moved = mergedBoard.some((v, i) => v !== before[i]);
  const gained = merges.reduce((s, m) => s + m.gained, 0);

  if (!moved) {
    return {
      before,
      mergedBoard: before.slice(),
      after: before.slice(),
      direction,
      moved: false,
      gained: 0,
      merges: [],
      spawn: null,
      spawnCursor: null,
      canMove: canMove(before),
      reached2048: state.reached2048 || hasWon(before),
    };
  }

  // 有效移动：确定性注入新块。
  const empties = emptyCells(mergedBoard);
  const item = queue[state.spawnCursor];
  if (item === undefined) {
    throw new GameError(
      'SPAWN_QUEUE_EXHAUSTED',
      `生成指令不足：第 ${state.spawnCursor} 条指令不存在（与游戏结束不同，棋盘可能仍可移动）`,
    );
  }
  if (item.rank >= empties.length) {
    throw new GameError(
      'SPAWN_RANK_OUT_OF_RANGE',
      `生成排名越界：rank=${item.rank}，但移动后仅有 ${empties.length} 个空格`,
    );
  }

  const after = mergedBoard.slice();
  const targetIndex = empties[item.rank]!;
  after[targetIndex] = item.value;
  const [sr, sc] = rc(targetIndex);

  return {
    before,
    mergedBoard,
    after,
    direction,
    moved: true,
    gained,
    merges,
    spawn: { index: state.spawnCursor, row: sr, col: sc, value: item.value },
    spawnCursor: state.spawnCursor,
    canMove: canMove(after),
    reached2048: state.reached2048 || hasWon(after),
  };
}

/** 棋盘数值总和（用于守恒校验：移动后总和 = 合并后总和 + 新块值）。 */
export function sumBoard(board: number[]): number {
  return board.reduce((a, b) => a + b, 0);
}
