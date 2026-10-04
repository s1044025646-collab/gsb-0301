import { Board, MergeRecord, MoveRecord, SIZE } from './engine.js';
import { FullGame } from './storage.js';

/** 文本矩阵展示局面，合并目标标 *，新移动到的格子标 + */
export function renderBoard(
  board: Board,
  opts: { merges?: MergeRecord[]; moves?: MoveRecord[]; spawnCell?: [number, number] } = {},
): string {
  const mergeTargets = new Set((opts.merges ?? []).map((m) => `${m.target[0]},${m.target[1]}`));
  const moveTargets = new Set((opts.moves ?? []).map((m) => `${m.to[0]},${m.to[1]}`));
  const spawnKey = opts.spawnCell ? `${opts.spawnCell[0]},${opts.spawnCell[1]}` : null;
  const width = 6;
  const lines: string[] = [];
  const border = '+' + `${'-'.repeat(width)}+`.repeat(SIZE);
  lines.push(border);
  for (let r = 0; r < SIZE; r++) {
    const cells: string[] = [];
    for (let c = 0; c < SIZE; c++) {
      const v = board[r]![c]!;
      const key = `${r},${c}`;
      let text = v === 0 ? '.' : String(v);
      if (mergeTargets.has(key)) text = `*${text}*`;
      else if (spawnKey === key) text = `~${text}~`;
      else if (moveTargets.has(key)) text = `+${text}+`;
      cells.push(text.padStart(Math.floor((width + text.length) / 2)).padEnd(width));
    }
    lines.push('|' + cells.map((cell) => `${cell}|`).join(''));
    lines.push(border);
  }
  const legend: string[] = [];
  if (mergeTargets.size > 0) legend.push('* 合并产生');
  if (moveTargets.size > 0) legend.push('+ 滑动入位');
  if (spawnKey) legend.push('~ 新注入方块');
  if (legend.length > 0) lines.push('图例: ' + legend.join('，'));
  return lines.join('\n');
}

export function renderMerges(merges: MergeRecord[]): string {
  if (merges.length === 0) return '本次无合并';
  return merges
    .map(
      (m, i) =>
        `  ${i + 1}. (${m.sources[0]![0]},${m.sources[0]![1]}) + (${m.sources[1]![0]},${m.sources[1]![1]}) ` +
        `-> (${m.target[0]},${m.target[1]}) = ${m.value}（+${m.gained} 分）`,
    )
    .join('\n');
}

export function renderGame(game: FullGame, verbose = false): string {
  const head: string[] = [
    `对局 ${game.id}`,
    renderBoard(game.board),
    `得分: ${game.score}  有效步数: ${game.moveCount}  生成游标: ${game.cursor}/${game.spawns.length}`,
    `可撤销: ${game.canUndo}  可重做: ${game.canRedo}  达标2048: ${game.reached2048}  结束: ${game.gameOver}`,
  ];
  if (verbose) {
    head.push(`创建时间: ${game.createdAt}`);
    head.push(`生成队列: ${JSON.stringify(game.spawns)}`);
  }
  return head.join('\n');
}
