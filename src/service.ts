import {
  applyMove,
  Board,
  cloneBoard,
  Direction,
  tileSum,
  validateDirection,
} from './engine.js';
import { GameError } from './errors.js';
import { FullGame, Store } from './storage.js';

export class GameService {
  constructor(private readonly store: Store) {}

  create(id: string, board: unknown, spawns: unknown): FullGame {
    return this.store.createGame(id, board, spawns);
  }

  get(id: string): FullGame {
    return this.store.getGame(id);
  }

  list() {
    return this.store.listGames();
  }

  move(id: string, rawDirection: unknown): FullGame {
    const direction = validateDirection(rawDirection);
    return this.store.commitMove(id, (state) => {
      if (state.cursor >= state.spawns.length) {
        throw new GameError(
          'SPAWN_QUEUE_EXHAUSTED',
          `第 ${state.cursor + 1} 条生成指令不存在（队列仅 ${state.spawns.length} 条），本次移动失败，状态不变`,
          422,
        );
      }
      const spawn = state.spawns[state.cursor]!;
      const before: Board = cloneBoard(state.board);
      const beforeSum = tileSum(before);
      const result = applyMove(state.board, direction, spawn);
      // 不变式：移动后总和 = 移动前总和 + 新块数值（合并不改变总和）
      if (tileSum(result.board) !== beforeSum + spawn.value) {
        throw new GameError('INTERNAL_ERROR', '棋盘总和不变式校验失败，已回滚', 500);
      }
      return {
        toBoard: result.board,
        gained: result.gained,
        merges: result.merges,
        moves: result.moves,
        spawn,
        spawnCell: result.spawned.cell,
        direction,
      };
    });
  }

  undo(id: string): FullGame {
    return this.store.undo(id);
  }

  redo(id: string): FullGame {
    return this.store.redo(id);
  }

  /** 逐步回放：返回从初始局面到当前 head 的每一步 */
  replay(id: string) {
    const game = this.store.getGame(id);
    return {
      id: game.id,
      initialBoard: game.history.length > 0 ? game.history[0]!.fromBoard : game.board,
      steps: game.history.map((h) => ({
        seq: h.seq,
        direction: h.direction,
        fromBoard: h.fromBoard,
        toBoard: h.toBoard,
        gained: h.gained,
        merges: h.merges,
        moves: h.moves,
        spawn: h.spawn,
        spawnCell: h.spawnCell,
      })),
      finalBoard: game.board,
      score: game.score,
    };
  }

  exportJson(id: string) {
    return this.store.getGame(id);
  }
}
