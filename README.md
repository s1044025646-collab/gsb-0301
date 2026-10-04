# 2048 棋盘合并与撤销回放后端

仅包含规则引擎、本地对局记录与 HTTP API / CLI，**不包含**网页、电脑策略、排行榜或多人服务。
技术栈：TypeScript + Node.js（内置 `node:sqlite` / `node:http`，**无任何第三方运行时依赖**，无需 Docker、WSL 或联网服务）。

## 环境要求

- Windows 本地 PowerShell
- Node.js **>= 22.5**（开发与实测版本：Node v25.5.0，npm 11.8.0；`node:sqlite` 在 22.5+ 可用）

## 安装与构建

```powershell
npm install
npm run build
```

编译产物输出到 `dist-build/`。SQLite 数据库固定在项目内 `data/2048.sqlite`（演示用库在 `data-demo/`）。

## 规则要点

- 棋盘固定 4×4；格子只能是 `0` 或 2 的正整数次幂，最大允许 `2097152`（2^21），合并结果超过上限则整次移动回滚（`TILE_VALUE_OVERFLOW`）。
- 一次移动 = 按方向取四条线（近端→远端）→ 压缩 → 相邻相等合并（每个原方块每次最多参与一次，新方块不再连锁）→ 再次压缩。
  - `[2,2,2,2]` 左移 → `[4,4,0,0]`，加 **8** 分；
  - `[2,2,4,0]` 左移 → `[4,4,0,0]`，加 **4** 分，不会连锁成 8；
  - 三个相等 `[4,4,4,0]`：左移 `[8,4]`、右移 `[4,8]`，均从近端开始合并。
- 每次**有效移动**后按行优先枚举空格，用生成队列下一条指令（零基 `rank` + `value` 2/4）注入新块。
- 无效移动（棋盘无变化）：不加分、不消耗指令、不增加有效步数（`NO_EFFECT_MOVE`）。
- 指令不足：`SPAWN_QUEUE_EXHAUSTED`；`rank` 超过当前空格数：`SPAWN_RANK_OUT_OF_RANGE`。两者都使整次移动失败，棋盘、得分、游标全部不变，且**不等于游戏结束**。
- 结束仅由“无空格且横纵相邻均不能合并”决定；达到 2048 仅标记 `reached2048`，仍可继续。
- 历史为线性分支：撤销还原移动前棋盘、得分与生成游标；重做重放同一步；撤销后改走其他方向会丢弃旧分支。
- 每次移动、撤销、重做均在 SQLite 事务内完成，失败回滚，不留半步记录。

## HTTP API

启动（默认端口 `0` = 操作系统分配空闲端口；可用 `--port` 或环境变量 `PORT` 指定）：

```powershell
npm run serve
# 或
node dist-build/src/cli.js serve --port 8080
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/games` | 创建对局，body：`{"id","board"?, "spawns"?}`；不传 board 为空盘 |
| GET | `/api/games` | 对局列表 |
| GET | `/api/games/:id` | 查看局面（含状态、历史、可撤销/重做、结束标记） |
| POST | `/api/games/:id/move` | body：`{"direction":"up|down|left|right"}` |
| POST | `/api/games/:id/undo` | 撤销一步 |
| POST | `/api/games/:id/redo` | 重做一步 |
| GET | `/api/games/:id/replay` | 逐步回放（初始局面 + 每步前后快照/合并/注入） |
| GET | `/api/games/:id/export` | JSON 导出（带下载头） |

统一响应：`{"ok":true,"data":...}`；失败：`{"ok":false,"error":{"code","message"}}`。

### curl 示例

```powershell
curl.exe -X POST http://127.0.0.1:8080/api/games -H "Content-Type: application/json" `
  -d '{\"id\":\"G1\",\"board\":[[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],\"spawns\":[{\"rank\":0,\"value\":2}]}'
curl.exe -X POST http://127.0.0.1:8080/api/games/G1/move -H "Content-Type: application/json" -d '{\"direction\":\"left\"}'
curl.exe -X POST http://127.0.0.1:8080/api/games/G1/undo
curl.exe http://127.0.0.1:8080/api/games/G1/replay
```

### 稳定错误码

| code | 含义 |
| --- | --- |
| `INVALID_DIRECTION` | 方向不是 up/down/left/right |
| `INVALID_BOARD_SIZE` | 不是 4×4 |
| `INVALID_CELL_VALUE` | 格子不是 0 或 2 的正整数次幂 |
| `DUPLICATE_GAME_ID` | 对局编号重复 |
| `NO_EFFECT_MOVE` | 移动未改变棋盘 |
| `SPAWN_QUEUE_EXHAUSTED` | 生成指令已用完（非游戏结束） |
| `SPAWN_RANK_OUT_OF_RANGE` | rank 超过本步空格数 |
| `TILE_VALUE_OVERFLOW` | 合并结果超过 2^21 |
| `NOTHING_TO_UNDO` / `NOTHING_TO_REDO` | 无可撤销/重做 |
| `GAME_NOT_FOUND` / `BAD_REQUEST` / `INTERNAL_ERROR` | 不存在、请求格式错、内部错误 |

## CLI

```powershell
# 创建（空盘或导入），生成队列可用内联 JSON 或文件
node dist-build/src/cli.js create --id G1
node dist-build/src/cli.js import --id G2 --board-file examples/board.json --spawns-file examples/spawns.json

node dist-build/src/cli.js list
node dist-build/src/cli.js show --id G2 --verbose
node dist-build/src/cli.js move --id G2 --direction left
node dist-build/src/cli.js undo --id G2
node dist-build/src/cli.js redo --id G2
node dist-build/src/cli.js replay --id G2
node dist-build/src/cli.js export --id G2
```

移动后终端以文本矩阵展示：`*` 合并产生、`+` 滑动入位、`~` 新注入方块，并打印合并的来源格/目标格与注入位置。

## 测试与演示

```powershell
npm test     # tsc 构建 + node:test 运行 dist-build/test
npm run demo # 确定性复现：相同初局与队列结果一致、撤销后换方向、重启读取历史
```

测试覆盖：四个方向手工预期棋盘、三块/四块相等、中间空格、满盘可合并与满盘结束、移动前后总和只增加新块值、合并得分与明细一致、无效移动不消耗队列、指令不足/越界/超限回滚、撤销恢复全部状态、重启后继续对局。

## 项目结构

```
src/engine.ts    规则引擎：校验、取线、压缩合并、注入、结束/不变式
src/storage.ts   node:sqlite 存储，事务化状态与线性分支历史
src/service.ts   对局服务（队列校验 + 总和不变式 + 回放/导出）
src/server.ts    纯 node:http API 与空闲端口监听
src/cli.ts       命令行入口
src/render.ts    文本矩阵与合并来源渲染
src/demo.ts      可复现演示脚本
test/            node:test 测试
```

## 合理假设

- 初始导入的局面不消耗生成指令；指令只在有效移动后消耗。
- 胜利只标记不阻止继续；只有“满盘且无法合并”才是结束。
- 多个对局各自维护独立生成队列与历史，互不影响；数据持久化在项目内 `data/`。
