import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMove,
  Board,
  emptyBoard,
  hasLegalMove,
  slideBoard,
  tileSum,
  validateBoard,
} from '../src/engine.js';
import { GameError } from '../src/errors.js';

function b(rows: number[][]): Board {
  return rows.map((r) => r.slice());
}

function eq(actual: Board, expected: number[][]): void {
  assert.deepEqual(actual, expected);
}

test('左移 [2,2,2,2] -> [4,4,0,0]，本次加 8 分', () => {
  const board = b([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const r = slideBoard(board, 'left');
  eq(r.board, [[4, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(r.gained, 8);
  assert.equal(r.merges.length, 2);
});

test('左移 [2,2,4,0] -> [4,4,0,0]，不能连锁成 8', () => {
  const board = b([[2, 2, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const r = slideBoard(board, 'left');
  eq(r.board, [[4, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(r.gained, 4);
  assert.equal(r.merges.length, 1);
});

test('三块相等 [4,4,4,0] 左移 -> [8,4,0,0]，近端先合并', () => {
  const board = b([[4, 4, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const r = slideBoard(board, 'left');
  eq(r.board, [[8, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(r.gained, 8);
});

test('三块相等右移 [4,4,4,0] -> [0,0,4,8]，右端先合并', () => {
  const board = b([[4, 4, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const r = slideBoard(board, 'right');
  eq(r.board, [[0, 0, 4, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
});

test('中间空格 [2,0,0,2] 左移 -> [4,0,0,0]，来源格记录正确', () => {
  const board = b([[2, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const r = slideBoard(board, 'left');
  eq(r.board, [[4, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.deepEqual(r.merges[0]!.sources, [[0, 0], [0, 3]]);
  assert.deepEqual(r.merges[0]!.target, [0, 0]);
});

test('上移：列 [2,2,4,4] -> [4,8,0,0]', () => {
  const board = b([[2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]]);
  const r = slideBoard(board, 'up');
  eq(r.board, [[4, 0, 0, 0], [8, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(r.gained, 12);
});

test('下移：列 [2,2,4,4] -> [0,0,4,8]', () => {
  const board = b([[2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]]);
  const r = slideBoard(board, 'down');
  eq(r.board, [[0, 0, 0, 0], [0, 0, 0, 0], [4, 0, 0, 0], [8, 0, 0, 0]]);
});

test('四个方向手工预期全盘', () => {
  const start = b([
    [2, 0, 2, 4],
    [0, 0, 0, 4],
    [2, 2, 0, 0],
    [0, 0, 0, 0],
  ]);
  eq(slideBoard(start, 'left').board, [
    [4, 4, 0, 0],
    [4, 0, 0, 0],
    [4, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  eq(slideBoard(start, 'right').board, [
    [0, 0, 4, 4],
    [0, 0, 0, 4],
    [0, 0, 0, 4],
    [0, 0, 0, 0],
  ]);
  eq(slideBoard(start, 'up').board, [
    [4, 2, 2, 8],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  eq(slideBoard(start, 'down').board, [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [4, 2, 2, 8],
  ]);
});

test('无变化移动抛出 NO_EFFECT_MOVE', () => {
  const board = b([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.throws(() => applyMove(board, 'left', { rank: 0, value: 2 }), (e: unknown) => {
    return e instanceof GameError && e.code === 'NO_EFFECT_MOVE';
  });
});

test('生成排名越界 -> SPAWN_RANK_OUT_OF_RANGE', () => {
  const board = b([[0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.throws(() => applyMove(board, 'left', { rank: 15, value: 2 }), (e: unknown) => {
    return e instanceof GameError && e.code === 'SPAWN_RANK_OUT_OF_RANGE';
  });
});

test('完整移动后方块总和只增加新块数值', () => {
  const board = b([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const before = tileSum(board);
  const r = applyMove(board, 'left', { rank: 0, value: 4 });
  assert.equal(tileSum(r.board), before + 4);
  assert.equal(r.gained, 4);
});

test('满盘但可合并 -> 仍有合法移动', () => {
  const board = b([
    [2, 2, 4, 8],
    [16, 32, 64, 128],
    [2, 4, 8, 16],
    [32, 64, 128, 256],
  ]);
  assert.equal(hasLegalMove(board), true);
});

test('满盘且横纵均不能合并 -> 结束', () => {
  const board = b([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  assert.equal(hasLegalMove(board), false);
});

test('非法格子（非二次幂、错误尺寸）被拒绝', () => {
  assert.throws(() => validateBoard([[3, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
  assert.throws(() => validateBoard([[0, 0, 0], [0, 0, 0], [0, 0, 0]]));
});

test('合并超过上限抛 TILE_VALUE_OVERFLOW', () => {
  const board = b([[2097152, 2097152, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.throws(() => slideBoard(board, 'left'), (e: unknown) => {
    return e instanceof GameError && e.code === 'TILE_VALUE_OVERFLOW';
  });
});
