import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../src/storage.js';
import { GameService } from '../src/service.js';
import { GameError } from '../src/errors.js';
import { tileSum } from '../src/engine.js';

const dir = resolve(tmpdir(), `gsb2048-test-${process.pid}`);
const dbPath = resolve(dir, 'test.sqlite');
let store: Store;
let svc: GameService;

before(() => {
  store = new Store(dbPath);
  svc = new GameService(store);
});

after(() => {
  store.close();
});

test('有效移动后撤销完全还原棋盘、得分、游标，重做结果相同', () => {
  const board = [
    [2, 0, 2, 4],
    [0, 0, 0, 4],
    [2, 2, 0, 0],
    [0, 0, 0, 0],
  ];
  const spawns = [
    { rank: 0, value: 2 },
    { rank: 1, value: 4 },
  ];
  const created = svc.create('G1', board, spawns);
  assert.equal(created.cursor, 0);
  assert.equal(created.score, 0);

  const moved = svc.move('G1', 'left');
  assert.equal(moved.score, 8); // 第0行 (2+2)->4；第0列两个2合并(4)，共 8
  assert.equal(moved.cursor, 1);
  assert.equal(moved.moveCount, 1);
  const movedSnapshot = JSON.stringify(moved.board);

  const undone = svc.undo('G1');
  assert.deepEqual(undone.board, board);
  assert.equal(undone.score, 0);
  assert.equal(undone.cursor, 0);
  assert.equal(undone.moveCount, 0);

  const redone = svc.redo('G1');
  assert.equal(JSON.stringify(redone.board), movedSnapshot);
  assert.equal(redone.score, 8);
  assert.equal(redone.cursor, 1);
});

test('无效移动不消耗队列、不增加步数', () => {
  svc.create('G2', [[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [
    { rank: 0, value: 2 },
  ]);
  assert.throws(() => svc.move('G2', 'left'), (e: unknown) => e instanceof GameError && e.code === 'NO_EFFECT_MOVE');
  const state = svc.get('G2');
  assert.equal(state.cursor, 0);
  assert.equal(state.moveCount, 0);
  assert.equal(state.score, 0);
});

test('生成指令不足报 SPAWN_QUEUE_EXHAUSTED 且状态完全不变', () => {
  svc.create('G3', [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], []);
  assert.throws(() => svc.move('G3', 'left'), (e: unknown) => {
    return e instanceof GameError && e.code === 'SPAWN_QUEUE_EXHAUSTED';
  });
  const state = svc.get('G3');
  assert.equal(state.cursor, 0);
  assert.equal(state.moveCount, 0);
  assert.equal(state.history.length, 0);
});

test('指令耗尽不等于游戏结束', () => {
  const state = svc.get('G3');
  assert.equal(state.gameOver, false);
});

test('撤销后换方向丢弃旧分支，旧 redo 不可用', () => {
  svc.undo('G1');
  const changed = svc.move('G1', 'up');
  assert.equal(changed.canRedo, false);
  assert.throws(() => svc.redo('G1'), (e: unknown) => e instanceof GameError && e.code === 'NOTHING_TO_REDO');
  assert.equal(changed.history.length, 1);
  assert.equal(changed.history[0]!.direction, 'up');
});

test('合并明细得分之和等于本步得分', () => {
  const g = svc.create('G4', [[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [
    { rank: 0, value: 2 },
    { rank: 0, value: 4 },
  ]);
  const moved = svc.move('G4', 'left');
  const sumMerges = moved.history[0]!.merges.reduce((s, m) => s + m.gained, 0);
  assert.equal(sumMerges, moved.history[0]!.gained);
  assert.equal(tileSum(moved.board), 8 + 2);
});

test('达到 2048 标记达标但不结束', () => {
  const board = [
    [1024, 1024, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  svc.create('G5', board, [{ rank: 0, value: 2 }, { rank: 0, value: 2 }]);
  const moved = svc.move('G5', 'left');
  assert.equal(moved.reached2048, true);
  assert.equal(moved.gameOver, false);
});

test('超限合并事务回滚，不留下历史', () => {
  svc.create('G6', [[2097152, 2097152, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [
    { rank: 0, value: 2 },
  ]);
  assert.throws(() => svc.move('G6', 'left'), (e: unknown) => e instanceof GameError && e.code === 'TILE_VALUE_OVERFLOW');
  const state = svc.get('G6');
  assert.equal(state.history.length, 0);
  assert.equal(state.cursor, 0);
  assert.equal(state.moveCount, 0);
});

test('重复编号被拒绝', () => {
  assert.throws(() => svc.create('G1', [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], []), (e: unknown) => {
    return e instanceof GameError && e.code === 'DUPLICATE_GAME_ID';
  });
});

test('重启后历史仍可继续对局', () => {
  store.close();
  const reopened = new Store(dbPath);
  const again = new GameService(reopened);
  const game = again.get('G4');
  assert.equal(game.history.length, 1);
  const moved = again.move('G4', 'left');
  assert.equal(moved.moveCount, 2);
  reopened.close();
  store = new Store(dbPath);
  svc = new GameService(store);
});
