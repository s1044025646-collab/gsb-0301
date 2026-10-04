import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Board,
  Direction,
  MergeRecord,
  MoveRecord,
  SpawnInstruction,
  cloneBoard,
  emptyBoard,
  hasLegalMove,
  maxTile,
  validateBoard,
  validateSpawns,
  WIN_TILE,
} from './engine.js';
import { GameError } from './errors.js';

export interface HistoryEntry {
  seq: number;
  direction: Direction;
  fromBoard: Board;
  toBoard: Board;
  gained: number;
  merges: MergeRecord[];
  moves: MoveRecord[];
  spawn: SpawnInstruction;
  spawnCell: [number, number];
}

export interface GameState {
  id: string;
  board: Board;
  score: number;
  spawns: SpawnInstruction[];
  cursor: number;
  moveCount: number;
  headSeq: number;
  won: boolean;
  createdAt: string;
}

interface GameRow {
  id: string;
  board: string;
  score: number;
  spawns: string;
  cursor: number;
  move_count: number;
  head_seq: number;
  won: number;
  created_at: string;
}

export interface FullGame extends GameState {
  history: HistoryEntry[];
  canUndo: boolean;
  canRedo: boolean;
  gameOver: boolean;
  reached2048: boolean;
}

export class Store {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private withTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id         TEXT PRIMARY KEY,
        board      TEXT NOT NULL,
        score      INTEGER NOT NULL DEFAULT 0,
        spawns     TEXT NOT NULL DEFAULT '[]',
        cursor     INTEGER NOT NULL DEFAULT 0,
        move_count INTEGER NOT NULL DEFAULT 0,
        head_seq   INTEGER NOT NULL DEFAULT 0,
        won        INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        game_id    TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        direction  TEXT NOT NULL,
        from_board TEXT NOT NULL,
        to_board   TEXT NOT NULL,
        gained     INTEGER NOT NULL,
        merges     TEXT NOT NULL,
        moves      TEXT NOT NULL,
        spawn      TEXT NOT NULL,
        spawn_cell TEXT NOT NULL,
        PRIMARY KEY (game_id, seq),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
    `);
  }

  createGame(id: string, boardInput: unknown, spawnsInput: unknown): FullGame {
    if (this.db.prepare('SELECT 1 FROM games WHERE id = ?').get(id)) {
      throw new GameError('DUPLICATE_GAME_ID', `对局编号 ${id} 已存在`, 409);
    }
    const board = boardInput === undefined || boardInput === null ? emptyBoard() : validateBoard(boardInput);
    const spawns = validateSpawns(spawnsInput);
    const createdAt = new Date().toISOString();

    const insert = this.db.prepare(
      `INSERT INTO games (id, board, score, spawns, cursor, move_count, head_seq, won, created_at)
       VALUES (?, ?, 0, ?, 0, 0, 0, ?, ?)`,
    );
    insert.run(id, JSON.stringify(board), JSON.stringify(spawns), maxTile(board) >= WIN_TILE ? 1 : 0, createdAt);
    return this.getGame(id);
  }

  private loadRow(id: string): GameRow {
    const row = this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
    if (!row) throw new GameError('GAME_NOT_FOUND', `对局 ${id} 不存在`, 404);
    return row;
  }

  private toState(row: GameRow): GameState {
    return {
      id: row.id,
      board: JSON.parse(row.board) as Board,
      score: row.score,
      spawns: JSON.parse(row.spawns) as SpawnInstruction[],
      cursor: row.cursor,
      moveCount: row.move_count,
      headSeq: row.head_seq,
      won: row.won === 1,
      createdAt: row.created_at,
    };
  }

  /**
   * 原子地提交一次有效移动。
   * mutation 抛错则整个事务回滚，不留下半步记录。
   */
  commitMove(
    id: string,
    mutation: (state: GameState) => {
      toBoard: Board;
      gained: number;
      merges: MergeRecord[];
      moves: MoveRecord[];
      spawn: SpawnInstruction;
      spawnCell: [number, number];
      direction: Direction;
    },
  ): FullGame {
    this.loadRow(id); // 不存在直接 404
    const run = this.db.prepare(
      `INSERT INTO history
         (game_id, seq, direction, from_board, to_board, gained, merges, moves, spawn, spawn_cell)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = this.db.prepare(
      `UPDATE games SET board = ?, score = ?, cursor = ?, move_count = ?, head_seq = ?, won = ? WHERE id = ?`,
    );

    const result = this.withTx(() => {
      const state = this.toState(this.loadRow(id));
      const result = mutation(state); // 任何校验失败在此抛出 -> 回滚
      const seq = state.headSeq + 1;
      // 线性分支：丢弃 head 之后的旧分支
      this.db.prepare('DELETE FROM history WHERE game_id = ? AND seq > ?').run(id, state.headSeq);
      run.run(
        id,
        seq,
        result.direction,
        JSON.stringify(state.board),
        JSON.stringify(result.toBoard),
        result.gained,
        JSON.stringify(result.merges),
        JSON.stringify(result.moves),
        JSON.stringify(result.spawn),
        JSON.stringify(result.spawnCell),
      );
      const won = state.won || maxTile(result.toBoard) >= WIN_TILE ? 1 : 0;
      update.run(
        JSON.stringify(result.toBoard),
        state.score + result.gained,
        state.cursor + 1,
        state.moveCount + 1,
        seq,
        won,
        id,
      );
    });
    return this.getGame(id);
  }

  undo(id: string): FullGame {
    this.withTx(() => {
      const state = this.toState(this.loadRow(id));
      if (state.headSeq <= 0) {
        throw new GameError('NOTHING_TO_UNDO', '没有可撤销的有效移动', 409);
      }
      const entry = this.db
        .prepare('SELECT * FROM history WHERE game_id = ? AND seq = ?')
        .get(id, state.headSeq) as {
        from_board: string;
        gained: number;
      };
      this.db
        .prepare('UPDATE games SET board = ?, score = ?, cursor = ?, move_count = ?, head_seq = ? WHERE id = ?')
        .run(
          entry.from_board,
          state.score - entry.gained,
          state.cursor - 1,
          state.moveCount - 1,
          state.headSeq - 1,
          id,
        );
    });
    return this.getGame(id);
  }

  redo(id: string): FullGame {
    this.withTx(() => {
      const state = this.toState(this.loadRow(id));
      const next = this.db
        .prepare('SELECT * FROM history WHERE game_id = ? AND seq = ?')
        .get(id, state.headSeq + 1) as
        | { to_board: string; gained: number; spawn: string }
        | undefined;
      if (!next) {
        throw new GameError('NOTHING_TO_REDO', '没有可重做的移动（可能已选择新方向产生新分支）', 409);
      }
      this.db
        .prepare('UPDATE games SET board = ?, score = ?, cursor = ?, move_count = ?, head_seq = ? WHERE id = ?')
        .run(
          next.to_board,
          state.score + next.gained,
          state.cursor + 1,
          state.moveCount + 1,
          state.headSeq + 1,
          id,
        );
    });
    return this.getGame(id);
  }

  private loadHistory(id: string): HistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM history WHERE game_id = ? ORDER BY seq ASC')
      .all(id) as Array<{
      seq: number;
      direction: Direction;
      from_board: string;
      to_board: string;
      gained: number;
      merges: string;
      moves: string;
      spawn: string;
      spawn_cell: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      direction: row.direction,
      fromBoard: JSON.parse(row.from_board) as Board,
      toBoard: JSON.parse(row.to_board) as Board,
      gained: row.gained,
      merges: JSON.parse(row.merges) as MergeRecord[],
      moves: JSON.parse(row.moves) as MoveRecord[],
      spawn: JSON.parse(row.spawn) as SpawnInstruction,
      spawnCell: JSON.parse(row.spawn_cell) as [number, number],
    }));
  }

  getGame(id: string): FullGame {
    const state = this.toState(this.loadRow(id));
    const all = this.loadHistory(id);
    const history = all.filter((h) => h.seq <= state.headSeq);
    const nextExists = all.some((h) => h.seq === state.headSeq + 1);
    return {
      ...state,
      board: cloneBoard(state.board),
      history,
      canUndo: state.headSeq > 0,
      canRedo: nextExists,
      gameOver: !hasLegalMove(state.board),
      reached2048: maxTile(state.board) >= WIN_TILE,
    };
  }

  listGames(): Array<{ id: string; score: number; moveCount: number; gameOver: boolean; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT id, board, score, move_count, created_at FROM games ORDER BY created_at ASC')
      .all() as Array<{ id: string; board: string; score: number; move_count: number; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      score: row.score,
      moveCount: row.move_count,
      gameOver: !hasLegalMove(JSON.parse(row.board) as Board),
      createdAt: row.created_at,
    }));
  }
}
