import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './storage.js';
import { GameService } from './service.js';
import { renderBoard, renderGame, renderMerges } from './render.js';

const demoDir = resolve(process.cwd(), 'data-demo');
const dbPath = resolve(demoDir, '2048.sqlite');

function section(title: string): void {
  console.log(`\n================ ${title} ================`);
}

function run(): void {
  rmSync(demoDir, { recursive: true, force: true });
  const store = new Store(dbPath);
  const svc = new GameService(store);

  // 固定初局与生成队列：保证重复运行结果完全一致
  const board = [
    [2, 0, 2, 4],
    [0, 0, 0, 4],
    [2, 2, 0, 0],
    [0, 0, 0, 0],
  ];
  const spawns = [
    { rank: 0, value: 2 },
    { rank: 1, value: 4 },
    { rank: 0, value: 2 },
    { rank: 3, value: 4 },
    { rank: 0, value: 2 },
    { rank: 1, value: 4 },
  ];

  section('1. 创建演示对局 DEMO（确定性初局 + 生成队列）');
  let game = svc.create('DEMO', board, spawns);
  console.log(renderGame(game, true));

  section('2. 左移（演示 [2,_,2,4] 行 -> [4,4,_,_]，不连锁成 8）');
  game = svc.move('DEMO', 'left');
  let last = game.history[game.history.length - 1]!;
  console.log(renderBoard(game.board, { merges: last.merges, moves: last.moves, spawnCell: last.spawnCell }));
  console.log(renderMerges(last.merges));
  console.log(`注入: rank=${last.spawn.rank} value=${last.spawn.value} at (${last.spawnCell[0]},${last.spawnCell[1]})，得分 ${game.score}`);

  section('3. 同一初局与队列重建对局 DEMO2，重复相同操作，结果一致');
  svc.create('DEMO2', board, spawns);
  const game2 = svc.move('DEMO2', 'left');
  console.log('两局棋盘一致:', JSON.stringify(game.board) === JSON.stringify(game2.board), '| 得分一致:', game.score === game2.score);

  section('4. 无效方向移动（右移不变化则不消耗队列）—— 改用下移一步后撤销演示');
  game = svc.move('DEMO', 'down');
  console.log('下移后:');
  console.log(renderBoard(game.board));
  section('5. 撤销一步，棋盘/得分/游标全部还原');
  game = svc.undo('DEMO');
  console.log(renderGame(game));

  section('6. 撤销后重做（结果完全相同）');
  game = svc.redo('DEMO');
  console.log(renderGame(game));
  game = svc.undo('DEMO');

  section('7. 撤销后更换方向 -> 丢弃原 down 分支（再 redo 已不可用）');
  game = svc.move('DEMO', 'up');
  console.log(renderGame(game));
  console.log('可重做（应为 false，旧分支已丢弃）:', game.canRedo);

  section('8. 重启模拟：关闭并重新打开同一个数据库文件，历史仍在');
  store.close();
  const reopened = new Store(dbPath);
  const svcAgain = new GameService(reopened);
  const reloaded = svcAgain.get('DEMO');
  console.log(renderGame(reloaded));
  console.log('历史步数（跨重启保留）:', reloaded.history.length);
  section('9. 逐步回放（跨重启读取历史）');
  const replay = svcAgain.replay('DEMO');
  for (const step of replay.steps) {
    console.log(`第 ${step.seq} 步 ${step.direction} +${step.gained} ->`, JSON.stringify(step.toBoard));
  }
  reopened.close();
  console.log(`\n演示完成，数据库位于: ${dbPath}`);
}

run();
