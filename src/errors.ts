export type ErrorCode =
  | 'GAME_NOT_FOUND'
  | 'INVALID_DIRECTION'
  | 'INVALID_BOARD_SIZE'
  | 'INVALID_CELL_VALUE'
  | 'DUPLICATE_GAME_ID'
  | 'NO_EFFECT_MOVE'
  | 'SPAWN_QUEUE_EXHAUSTED'
  | 'SPAWN_RANK_OUT_OF_RANGE'
  | 'TILE_VALUE_OVERFLOW'
  | 'NOTHING_TO_UNDO'
  | 'NOTHING_TO_REDO'
  | 'BAD_REQUEST'
  | 'INTERNAL_ERROR';

export class GameError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.status = status;
  }
}
