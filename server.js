// ============================================================
//  五子棋联机服务器
//  职责：管理房间、配对玩家、透明转发落子
//  白方完全不知道黑方能多下 —— 服务器只负责传数据
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3456;

// ---- 静态文件服务 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  serveFile(res, path.join(__dirname, 'public', url));
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server });

// 房间存储
const rooms = new Map();   // roomCode -> { black, white, board, history, turn, moveInTurn }
const clients = new Map(); // ws -> { roomCode, role }

// 生成6位房间号
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? genCode() : code;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// 广播给房间内两人
function broadcast(roomCode, msg) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.black) send(room.black, msg);
  if (room.white) send(room.white, msg);
}

// 发送给房间内指定角色
function sendToRole(roomCode, role, msg) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const ws = role === 'black' ? room.black : room.white;
  if (ws) send(ws, msg);
}

wss.on('connection', (ws) => {
  console.log('🟢 新连接');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      // ---- 创建房间（用户自定房间号） ----
      case 'create': {
        const code = (msg.code || '').trim().toUpperCase();
        if (!code || code.length === 0) {
          send(ws, { type: 'error', message: '请输入房间号' });
          return;
        }
        if (rooms.has(code)) {
          send(ws, { type: 'error', message: '房间号已被占用，换一个试试' });
          return;
        }
        rooms.set(code, {
          black: ws,
          white: null,
          board: Array.from({length: 15}, () => Array(15).fill(0)),
          history: [],
          turn: 'black',
          moveInTurn: 0,
        });
        clients.set(ws, { roomCode: code, role: 'black' });
        send(ws, { type: 'room-created', code, role: 'black' });
        console.log(`🏠 房间 ${code} 已创建（黑方就位）`);
        break;
      }

      // ---- 加入房间 ----
      case 'join': {
        const code = (msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', message: '房间号不存在，请检查是否输入正确' });
          return;
        }
        if (room.white) {
          send(ws, { type: 'error', message: '该房间已满，请换一个房间号' });
          return;
        }
        room.white = ws;
        clients.set(ws, { roomCode: code, role: 'white' });
        send(ws, { type: 'joined', code, role: 'white' });

        // 通知黑方：对手已加入，游戏开始
        send(room.black, { type: 'game-start', turn: 'black' });
        send(room.white, { type: 'game-start', turn: 'black' });
        console.log(`🚪 白方加入房间 ${code}，游戏开始`);
        break;
      }

      // ---- 落子 ----
      case 'move': {
        const info = clients.get(ws);
        if (!info) return;
        const room = rooms.get(info.roomCode);
        if (!room) return;
        if (!room.black || !room.white) return;

        const { x, y } = msg;

        // 验证是不是该你下
        if (info.role !== room.turn) {
          send(ws, { type: 'error', message: '还没轮到你' });
          return;
        }

        // 验证位置是否为空
        if (room.board[y][x] !== 0) {
          send(ws, { type: 'error', message: '这里已经有子了' });
          return;
        }

        const stoneColor = info.role === 'black' ? 1 : 2;

        // 记录落子
        room.board[y][x] = stoneColor;
        room.history.push({ x, y, color: stoneColor });
        room.moveInTurn++;

        // 广播落子给双方
        broadcast(info.roomCode, {
          type: 'stone-placed',
          x, y,
          color: stoneColor,
          turn: room.turn,       // 谁下的
          byRole: info.role,
        });

        // 检查胜利
        if (checkWin(room.board, x, y, stoneColor)) {
          broadcast(info.roomCode, {
            type: 'game-over',
            winner: info.role,
            winnerColor: stoneColor,
          });
          console.log(`🏆 房间 ${info.roomCode}: ${info.role === 'black' ? '黑方' : '白方'} 获胜`);
          // 清理房间
          rooms.delete(info.roomCode);
          break;
        }

        // 黑方逻辑：黑方每次可以下 1 或 2 颗
        // moveInTurn 追踪黑方当前回合下了几颗
        if (info.role === 'black') {
          // 黑方每轮最多下 2 颗
          if (room.moveInTurn < 2) {
            // 下完第 1 颗 → 告诉黑方：你可以再下一颗
            send(room.black, {
              type: 'extra-move-available',
              message: '你可以再下一颗（仅自己可见）',
            });
            // turn 仍是 'black'，白方只看到黑方还在下
          } else {
            // 黑方已下完 2 颗 → 强制切换到白方
            room.turn = 'white';
            room.moveInTurn = 0;
            broadcast(info.roomCode, { type: 'turn-change', turn: 'white' });
          }
        } else {
          // 白方只能下 1 颗 → 自动切换到黑方
          room.turn = 'black';
          room.moveInTurn = 0;
          broadcast(info.roomCode, { type: 'turn-change', turn: 'black' });
        }

        break;
      }

      // ---- 黑方选择结束回合（不再下第 2 颗） ----
      case 'end-turn': {
        const info = clients.get(ws);
        if (!info || info.role !== 'black') return;
        const room = rooms.get(info.roomCode);
        if (!room) return;
        if (room.turn !== 'black') return;

        // 切换到白方
        room.turn = 'white';
        room.moveInTurn = 0;
        broadcast(info.roomCode, { type: 'turn-change', turn: 'white' });
        break;
      }

      // ---- 悔棋（仅黑方可悔） ----
      case 'undo': {
        const info = clients.get(ws);
        if (!info) return;
        const room = rooms.get(info.roomCode);
        if (!room) return;
        if (room.history.length === 0) return;

        // 白方不允许悔棋
        if (info.role === 'white') {
          send(ws, { type: 'error', message: '白方不能悔棋' });
          return;
        }

        // 只能悔自己的棋
        const last = room.history[room.history.length - 1];
        const lastRole = last.color === 1 ? 'black' : 'white';
        if (lastRole !== info.role) {
          send(ws, { type: 'error', message: '只能悔自己的棋' });
          return;
        }

        room.board[last.y][last.x] = 0;
        room.history.pop();
        room.moveInTurn--;

        // 恢复回合状态
        if (info.role === 'black' && room.moveInTurn < 0) {
          room.moveInTurn = 0;
          room.turn = 'white';
        }
        if (info.role === 'white') {
          room.turn = 'white';
          room.moveInTurn = 0;
        }

        broadcast(info.roomCode, {
          type: 'undo',
          x: last.x,
          y: last.y,
          turn: room.turn,
        });
        break;
      }

      // ---- 重新开始 ----
      case 'restart': {
        const info = clients.get(ws);
        if (!info) return;
        const room = rooms.get(info.roomCode);
        if (!room) return;

        room.board = Array.from({length: 15}, () => Array(15).fill(0));
        room.history = [];
        room.turn = 'black';
        room.moveInTurn = 0;
        broadcast(info.roomCode, { type: 'restart', turn: 'black' });
        break;
      }

      // ---- 重连 ----
      case 'reconnect': {
        // 处理玩家刷新页面后重连
        const { code } = msg;
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', message: '房间已失效' });
          return;
        }

        // 简单处理：尝试重新绑定
        if (!room.black || room.black.readyState !== 1) {
          room.black = ws;
          clients.set(ws, { roomCode: code, role: 'black' });
          send(ws, { type: 'reconnected', role: 'black', board: room.board, turn: room.turn });
        } else if (!room.white || room.white.readyState !== 1) {
          room.white = ws;
          clients.set(ws, { roomCode: code, role: 'white' });
          send(ws, { type: 'reconnected', role: 'white', board: room.board, turn: room.turn });
        } else {
          send(ws, { type: 'error', message: '房间已满，无法重连' });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      const room = rooms.get(info.roomCode);
      if (room) {
        const other = info.role === 'black' ? room.white : room.black;
        if (other) send(other, { type: 'opponent-disconnected' });
        // 不立即删除房间，给重连留时间
      }
      clients.delete(ws);
    }
    console.log('🔴 连接断开');
  });
});

// ==================== 胜利判断 ====================
function checkWin(board, x, y, color) {
  const dirs = [[1,0], [0,1], [1,1], [1,-1]];
  const SIZE = board.length;

  for (const [dx, dy] of dirs) {
    let count = 1;
    for (let i = 1; i < 5; i++) {
      const nx = x + dx * i, ny = y + dy * i;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) break;
      if (board[ny][nx] !== color) break;
      count++;
    }
    for (let i = 1; i < 5; i++) {
      const nx = x - dx * i, ny = y - dy * i;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) break;
      if (board[ny][nx] !== color) break;
      count++;
    }
    if (count >= 5) return true;
  }
  return false;
}

// ==================== 启动 ====================
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║   🀄  五子棋联机服务器已启动   ║
  ║       http://localhost:${PORT}       ║
  ╚══════════════════════════════════╝
  `);
});
