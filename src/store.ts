/**
 * SQLite 持久化：对局状态与移动历史的原子保存。
 *
 * 线性分支历史：
 * - moves 表保存每个对局的“当前分支”有效移动，seq 从 1 递增。
 * - head_seq 为当前所在步数；撤销只减小 head_seq，重做只增大 head_seq。
 * - 撤销后若走出新方向，则删除 seq > head_seq 的旧分支，
 *   再追加新移动（旧快照与旧新块不会被复用）。
 * - 每次有效移动与其状态更新放在同一个事务里，失败不留半步记录。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CELLS,
  GameError,
  type GameState,
  type MergeRecord,
  type SpawnItem,
} from './engine.js';

export interface GameRow {
  id: string;
  board: number[];
  score: number;
  spawnQueue: SpawnItem[];
  spawnCursor: number;
  headSeq: number;
  maxSeq: number;
  reached2048: boolean;
  moves: number;
  maxValue: number;
  createdAt: string;
  updatedAt: string;
}

export interface MoveRow {
  seq: number;
  gameId: string;
  direction: string;
  beforeBoard: number[];
  afterBoard: number[];
  scoreBefore: number;
  scoreAfter: number;
  cursorBefore: number;
  cursorAfter: number;
  gained: number;
  merges: MergeRecord[];
  spawn: { row: number; col: number; value: number } | null;
  createdAt: string;
}

export interface CreateGameInput {
  id: string;
  board: number[];
  spawnQueue: SpawnItem[];
  maxValue: number;
}

export interface AppendMoveInput {
  direction: string;
  before: GameState;
  afterBoard: number[];
  gained: number;
  merges: MergeRecord[];
  spawn: { row: number; col: number; value: number } | null;
  cursorAfter: number;
  reached2048After: boolean;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id           TEXT PRIMARY KEY,
        board        TEXT NOT NULL,
        score        INTEGER NOT NULL,
        spawn_queue  TEXT NOT NULL,
        spawn_cursor INTEGER NOT NULL,
        head_seq     INTEGER NOT NULL,
        max_seq      INTEGER NOT NULL,
        reached2048  INTEGER NOT NULL,
        moves        INTEGER NOT NULL,
        max_value    INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS moves (
        game_id      TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        direction    TEXT NOT NULL,
        before_board TEXT NOT NULL,
        after_board  TEXT NOT NULL,
        score_before INTEGER NOT NULL,
        score_after  INTEGER NOT NULL,
        cursor_before INTEGER NOT NULL,
        cursor_after  INTEGER NOT NULL,
        gained       INTEGER NOT NULL,
        merges       TEXT NOT NULL,
        spawn        TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (game_id, seq),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
    `);
  }

  createGame(input: CreateGameInput): GameRow {
    const exists = this.db.prepare('SELECT id FROM games WHERE id = ?').get(input.id);
    if (exists) {
      throw new GameError('DUPLICATE_GAME_ID', `对局编号已存在：${input.id}`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO games
         (id, board, score, spawn_queue, spawn_cursor, head_seq, max_seq, reached2048, moves, max_value, created_at, updated_at)
         VALUES (?, ?, 0, ?, 0, 0, 0, 0, 0, ?, ?, ?)`,
      )
      .run(
        input.id,
        JSON.stringify(input.board),
        JSON.stringify(input.spawnQueue),
        input.maxValue,
        now,
        now,
      );
    return this.getGame(input.id)!;
  }

  getGame(id: string): GameRow | null {
    const row = this.db
      .prepare('SELECT * FROM games WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.hydrateGame(row);
  }

  requireGame(id: string): GameRow {
    const g = this.getGame(id);
    if (!g) throw new GameError('GAME_NOT_FOUND', `对局不存在：${id}`);
    return g;
  }

  listGames(): Array<Pick<GameRow, 'id' | 'score' | 'headSeq' | 'moves' | 'reached2048'>> {
    const rows = this.db
      .prepare('SELECT id, score, head_seq, max_seq, reached2048, moves FROM games ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      score: Number(r.score),
      headSeq: Number(r.head_seq),
      moves: Number(r.max_seq),
      reached2048: Number(r.reached2048) === 1,
    }));
  }

  private hydrateGame(row: Record<string, unknown>): GameRow {
    return {
      id: String(row.id),
      board: parseBoard(row.board),
      score: Number(row.score),
      spawnQueue: JSON.parse(String(row.spawn_queue)) as SpawnItem[],
      spawnCursor: Number(row.spawn_cursor),
      headSeq: Number(row.head_seq),
      maxSeq: Number(row.max_seq),
      reached2048: Number(row.reached2048) === 1,
      moves: Number(row.moves),
      maxValue: Number(row.max_value),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** 追加一次有效移动；若处于撤销后的分叉点，先丢弃旧的后续分支。 */
  appendMove(gameId: string, input: AppendMoveInput): MoveRow {
    const game = this.requireGame(gameId);
    const now = new Date().toISOString();
    try {
      this.db.exec('BEGIN IMMEDIATE');

      // 丢弃被撤销掉的旧分支（seq > head_seq）。
      if (game.maxSeq > game.headSeq) {
        this.db.prepare('DELETE FROM moves WHERE game_id = ? AND seq > ?').run(gameId, game.headSeq);
      }
      const seq = game.headSeq + 1;
      this.db
        .prepare(
          `INSERT INTO moves
           (game_id, seq, direction, before_board, after_board, score_before, score_after,
            cursor_before, cursor_after, gained, merges, spawn, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          gameId,
          seq,
          input.direction,
          JSON.stringify(input.before.board),
          JSON.stringify(input.afterBoard),
          input.scoreBefore,
          input.scoreBefore + input.gained,
          input.before.spawnCursor,
          input.cursorAfter,
          input.gained,
          JSON.stringify(input.merges),
          JSON.stringify(input.spawn),
          now,
        );

      this.db
        .prepare(
          `UPDATE games SET board = ?, score = ?, spawn_cursor = ?, head_seq = ?, max_seq = ?,
             reached2048 = ?, moves = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(input.afterBoard),
          input.scoreBefore + input.gained,
          input.cursorAfter,
          seq,
          seq,
          input.reached2048After ? 1 : 0,
          seq,
          now,
          gameId,
        );
      this.db.exec('COMMIT');
      return this.getMove(gameId, seq)!;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMove(gameId: string, seq: number): MoveRow | null {
    const row = this.db
      .prepare('SELECT * FROM moves WHERE game_id = ? AND seq = ?')
      .get(gameId, seq) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.hydrateMove(row);
  }

  listMoves(gameId: string): MoveRow[] {
    const rows = this.db
      .prepare('SELECT * FROM moves WHERE game_id = ? ORDER BY seq')
      .all(gameId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.hydrateMove(r));
  }

  private hydrateMove(row: Record<string, unknown>): MoveRow {
    return {
      seq: Number(row.seq),
      gameId: String(row.game_id),
      direction: String(row.direction),
      beforeBoard: parseBoard(row.before_board),
      afterBoard: parseBoard(row.after_board),
      scoreBefore: Number(row.score_before),
      scoreAfter: Number(row.score_after),
      cursorBefore: Number(row.cursor_before),
      cursorAfter: Number(row.cursor_after),
      gained: Number(row.gained),
      merges: JSON.parse(String(row.merges)) as MergeRecord[],
      spawn: JSON.parse(String(row.spawn)) as MoveRow['spawn'],
      createdAt: String(row.created_at),
    };
  }

  /** 撤销一步：用该步的前快照还原棋盘/得分/游标，head_seq 减一。 */
  undo(gameId: string): MoveRow {
    const game = this.requireGame(gameId);
    if (game.headSeq <= 0) {
      throw new GameError('NOTHING_TO_UNDO', '没有可撤销的移动');
    }
    const move = this.getMove(gameId, game.headSeq)!;
    const now = new Date().toISOString();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db
        .prepare(
          'UPDATE games SET board = ?, score = ?, spawn_cursor = ?, head_seq = ?, reached2048 = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          JSON.stringify(move.beforeBoard),
          move.scoreBefore,
          move.cursorBefore,
          move.seq - 1,
          move.beforeBoard.some((v) => v >= 2048) ? 1 : 0,
          now,
          gameId,
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return move;
  }

  /** 重做一步：直接复用历史记录里的后快照（同一步结果完全一致）。 */
  redo(gameId: string): MoveRow {
    const game = this.requireGame(gameId);
    if (game.headSeq >= game.maxSeq) {
      throw new GameError('NOTHING_TO_REDO', '没有可重做的移动');
    }
    const seq = game.headSeq + 1;
    const move = this.getMove(gameId, seq)!;
    const now = new Date().toISOString();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db
        .prepare(
          'UPDATE games SET board = ?, score = ?, spawn_cursor = ?, head_seq = ?, reached2048 = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          JSON.stringify(move.afterBoard),
          move.scoreAfter,
          move.cursorAfter,
          move.seq,
          move.afterBoard.some((v) => v >= 2048) ? 1 : 0,
          now,
          gameId,
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return move;
  }
}

function parseBoard(value: unknown): number[] {
  const arr = JSON.parse(String(value)) as unknown;
  if (!Array.isArray(arr) || arr.length !== CELLS) {
    throw new GameError('INVALID_BOARD_SIZE', '数据库中的棋盘数据长度非法');
  }
  return arr.map((v) => Number(v));
}
