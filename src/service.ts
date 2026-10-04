/**
 * 对局服务：API 与 CLI 共用的业务编排层。
 * 负责把纯引擎计算结果原子落库，并保证失败时状态完全不变。
 */

import {
  applyMove,
  canMove,
  hasWon,
  validateBoard,
  validateSpawnQueue,
  type Direction,
  type GameState,
  type MergeRecord,
  type SpawnItem,
} from './engine.js';
import { Store, type GameRow, type MoveRow } from './store.js';

export interface CreateOptions {
  board?: number[];
  spawnQueue: SpawnItem[];
  maxValue?: number;
}

export interface PublicMove {
  seq: number;
  direction: Direction;
  board: number[][];
  score: number;
  gained: number;
  moved: boolean;
  merges: MergeRecord[];
  spawn: { row: number; col: number; value: number } | null;
  canMove: boolean;
  gameOver: boolean;
  reached2048: boolean;
  cursor: number;
  remainingInstructions: number;
}

export interface PublicGame {
  id: string;
  board: number[][];
  score: number;
  moves: number;
  headSeq: number;
  maxSeq: number;
  canUndo: boolean;
  canRedo: boolean;
  canMove: boolean;
  gameOver: boolean;
  reached2048: boolean;
  spawnCursor: number;
  remainingInstructions: number;
  maxValue: number;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_MAX_VALUE = 2048;

export class GameService {
  constructor(private readonly store: Store) {}

  create(id: string, opts: CreateOptions): PublicGame {
    validateSpawnQueue(opts.spawnQueue);
    const board = opts.board ?? new Array<number>(16).fill(0);
    validateBoard(board);
    const maxValue = opts.maxValue ?? DEFAULT_MAX_VALUE;
    if (!Number.isInteger(maxValue) || maxValue < 2) {
      throw new Error('maxValue 必须是不小于 2 的整数');
    }
    this.store.createGame({ id, board: board.slice(), spawnQueue: opts.spawnQueue, maxValue });
    return this.status(id);
  }

  status(id: string): PublicGame {
    return this.toPublic(this.store.requireGame(id));
  }

  list() {
    return this.store.listGames();
  }

  /**
   * 执行移动：先在内存里纯计算；任何引擎错误（空移动/指令不足/越界/超限）
   * 都在写库之前抛出，因此棋盘、得分、游标与历史保持原状。
   * 仅有效移动才落库并消耗一条指令。
   */
  move(id: string, direction: Direction): PublicMove {
    const game = this.store.requireGame(id);
    const state: GameState = {
      board: game.board.slice(),
      score: game.score,
      spawnCursor: game.spawnCursor,
      reached2048: game.reached2048,
      moves: game.headSeq,
    };

    const result = applyMove(state, direction, game.spawnQueue, game.maxValue);

    if (!result.moved) {
      return {
        seq: game.headSeq,
        direction,
        board: toMatrix(game.board),
        score: game.score,
        gained: 0,
        moved: false,
        merges: [],
        spawn: null,
        canMove: canMove(game.board),
        gameOver: !canMove(game.board),
        reached2048: game.reached2048,
        cursor: game.spawnCursor,
        remainingInstructions: game.spawnQueue.length - game.spawnCursor,
      };
    }

    const cursorAfter = game.spawnCursor + 1;
    const stored = this.store.appendMove(id, {
      direction,
      before: state,
      afterBoard: result.after,
      gained: result.gained,
      merges: result.merges,
      spawn: result.spawn
        ? { row: result.spawn.row, col: result.spawn.col, value: result.spawn.value }
        : null,
      cursorAfter,
      reached2048After: result.reached2048,
    });

    const fresh = this.store.requireGame(id);
    return {
      seq: stored.seq,
      direction,
      board: toMatrix(result.after),
      score: state.score + result.gained,
      gained: result.gained,
      moved: true,
      merges: result.merges,
      spawn: result.spawn
        ? { row: result.spawn.row, col: result.spawn.col, value: result.spawn.value }
        : null,
      canMove: result.canMove,
      gameOver: !result.canMove,
      reached2048: result.reached2048,
      cursor: cursorAfter,
      remainingInstructions: game.spawnQueue.length - cursorAfter,
    };
  }

  undo(id: string): PublicGame {
    this.store.undo(id);
    return this.status(id);
  }

  redo(id: string): PublicGame {
    this.store.redo(id);
    return this.status(id);
  }

  history(id: string): MoveRow[] {
    this.store.requireGame(id);
    return this.store.listMoves(id);
  }

  /**
   * 逐步回放：从空盘/导入初局开始，按历史顺序给出每一步后的局面。
   * 不改变当前对局状态（只读快照）。
   */
  replay(id: string): Array<{
    seq: number;
    direction: Direction;
    board: number[][];
    score: number;
    gained: number;
    merges: MergeRecord[];
    spawn: MoveRow['spawn'];
  }> {
    const moves = this.history(id);
    return moves.map((m) => ({
      seq: m.seq,
      direction: m.direction as Direction,
      board: toMatrix(m.afterBoard),
      score: m.scoreAfter,
      gained: m.gained,
      merges: m.merges,
      spawn: m.spawn,
    }));
  }

  exportJson(id: string) {
    const game = this.store.requireGame(id);
    const moves = this.store.listMoves(id);
    return {
      id: game.id,
      board: toMatrix(game.board),
      score: game.score,
      moves: game.headSeq,
      maxSeq: game.maxSeq,
      reached2048: game.reached2048,
      gameOver: !canMove(game.board),
      canMove: canMove(game.board),
      spawnQueue: game.spawnQueue,
      spawnCursor: game.spawnCursor,
      maxValue: game.maxValue,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
      history: moves.map((m) => ({
        seq: m.seq,
        direction: m.direction,
        before: toMatrix(m.beforeBoard),
        after: toMatrix(m.afterBoard),
        scoreBefore: m.scoreBefore,
        scoreAfter: m.scoreAfter,
        cursorBefore: m.cursorBefore,
        cursorAfter: m.cursorAfter,
        gained: m.gained,
        merges: m.merges,
        spawn: m.spawn,
      })),
    };
  }

  private toPublic(game: GameRow): PublicGame {
    const movable = canMove(game.board);
    return {
      id: game.id,
      board: toMatrix(game.board),
      score: game.score,
      moves: game.maxSeq,
      headSeq: game.headSeq,
      maxSeq: game.maxSeq,
      canUndo: game.headSeq > 0,
      canRedo: game.headSeq < game.maxSeq,
      canMove: movable,
      gameOver: !movable,
      reached2048: game.reached2048 || hasWon(game.board),
      spawnCursor: game.spawnCursor,
      remainingInstructions: game.spawnQueue.length - game.spawnCursor,
      maxValue: game.maxValue,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    };
  }
}

export function toMatrix(flat: number[]): number[][] {
  return [0, 1, 2, 3].map((r) => flat.slice(r * 4, r * 4 + 4));
}
