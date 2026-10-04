/**
 * 端到端演示（使用独立数据库 data/demo.sqlite，避免影响真实对局）：
 * 1. 用同一初局与同一生成队列创建两个对局，各自完整跑一遍，结果应完全一致；
 * 2. 撤销一步后更换方向，展示线性分支（旧的后续被丢弃，重做消失）；
 * 3. 关闭并重新打开数据库（模拟重启），读取历史并逐步回放，状态依旧。
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { GameService, toMatrix } from './service.js';
import { Store } from './store.js';

const demoDb = join(process.cwd(), 'data', 'demo.sqlite');

const INITIAL: number[] = [
  2, 0, 0, 2,
  4, 0, 4, 0,
  2, 2, 2, 2,
  0, 0, 0, 0,
];

// 足够多的确定性生成指令。
const QUEUE = [
  { rank: 0, value: 2 }, { rank: 1, value: 4 }, { rank: 0, value: 2 },
  { rank: 2, value: 4 }, { rank: 0, value: 2 }, { rank: 1, value: 2 },
  { rank: 0, value: 4 }, { rank: 3, value: 2 }, { rank: 0, value: 2 },
  { rank: 1, value: 4 }, { rank: 0, value: 2 }, { rank: 2, value: 4 },
];

const MOVES: Array<'left' | 'right' | 'up' | 'down'> = ['left', 'down', 'right', 'up', 'left'];

function line(t: string): void {
  console.log('\n' + '='.repeat(8) + ` ${t} ` + '=' .repeat(8));
}

function showBoard(label: string, board: number[][], score?: number): void {
  console.log(`-- ${label}${score !== undefined ? `（得分 ${score}）` : ''}`);
  for (const row of board) {
    console.log('  ' + row.map((v) => String(v).padStart(5)).join(' '));
  }
}

function runOne(id: string): { board: number[][]; score: number } {
  const store = new Store(demoDb);
  const svc = new GameService(store);
  svc.create(id, { board: INITIAL, spawnQueue: QUEUE });
  let last = svc.status(id);
  for (const d of MOVES) {
    const r = svc.move(id, d);
    console.log(`  [${id}] ${d}: moved=${r.moved} +${r.gained} 分，总分 ${r.score}`);
    last = svc.status(id);
  }
  store.close();
  return { board: last.board, score: last.score };
}

function main(): void {
  rmSync(demoDb, { force: true });
  for (const ext of ['-wal', '-shm']) rmSync(demoDb + ext, { force: true });

  line('一、同一初局与队列重复运行，结果一致');
  const a = runOne('repeat-A');
  const b = runOne('repeat-B');
  showBoard('对局 A 终局', a.board, a.score);
  showBoard('对局 B 终局', b.board, b.score);
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(same ? '✔ 两次运行终局与得分完全一致（确定性）' : '✘ 两次运行不一致！');

  line('二、撤销后更换方向（线性分支）');
  const store = new Store(demoDb);
  const svc = new GameService(store);
  console.log(`撤销前 headSeq=${svc.status('repeat-A').headSeq}，canRedo=${svc.status('repeat-A').canRedo}`);
  const undone = svc.undo('repeat-A');
  showBoard('撤销一步后', undone.board, undone.score);
  console.log(`撤销后 canUndo=${undone.canUndo} canRedo=${undone.canRedo}（应可重做最后一步）`);

  // 先重做一次，确认同一步完全相同。
  const redone = svc.redo('repeat-A');
  console.log(`重做后得分 ${redone.score}，与 A 终局一致: ${redone.score === a.score}`);
  svc.undo('repeat-A'); // 再退回分叉点

  const branched = svc.move('repeat-A', 'right');
  console.log(`在分叉点改走 right: moved=${branched.moved}，新步数 seq=${branched.seq}，总分 ${branched.score}`);
  showBoard('更换方向后', branched.board, branched.score);
  const now = svc.status('repeat-A');
  console.log(`旧分支已丢弃: headSeq=${now.headSeq} maxSeq=${now.maxSeq} canRedo=${now.canRedo}（应=false）`);

  line('三、重启后读取历史并回放');
  store.close();
  const store2 = new Store(demoDb); // 重新打开即模拟进程重启
  const svc2 = new GameService(store2);
  const restored = svc2.status('repeat-A');
  showBoard('重启后读到的当前局面', restored.board, restored.score);
  console.log(`重启后 headSeq=${restored.headSeq} 得分=${restored.score} 游标=${restored.spawnCursor}`);
  const steps = svc2.replay('repeat-A');
  console.log(`历史共 ${steps.length} 步，逐步回放末步如下：`);
  const lastStep = steps[steps.length - 1]!;
  showBoard(`回放末步（${lastStep.direction}）`, lastStep.board, lastStep.score);

  console.log('\n另外：对局 repeat-B 未受分支操作影响（独立队列与历史）。');
  const bStill = svc2.status('repeat-B');
  console.log(`repeat-B 得分仍为 ${bStill.score}（=${b.score}），headSeq=${bStill.headSeq}`);
  store2.close();

  console.log('\n演示完成。');
}

main();
