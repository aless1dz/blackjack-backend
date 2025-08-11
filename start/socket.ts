import { Server as SocketServer } from 'socket.io'

let io: SocketServer

export function initializeSocket(httpServer: any) {
  io = new SocketServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  })

  io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado:', socket.id)

    socket.on('join:game', (data) => {
      // ✅ Manejar tanto número directo como objeto {gameId: number}
      const gameId = typeof data === 'object' && data !== null ? data.gameId || data : data
      console.log(`📥 Socket ${socket.id} se unió a game:${gameId}`, { originalData: data })
      socket.join(`game:${gameId}`)
      io.to(`game:${gameId}`).emit('chisme:playerJoined', {
        socketId: socket.id,
      })
    })

    socket.on('leaveGame', (data) => {
      const gameId = typeof data === 'object' && data !== null ? data.gameId || data : data
      console.log(`📤 Socket ${socket.id} salió de game:${gameId}`)
      socket.leave(`game:${gameId}`)
    })

    socket.on('disconnect', (reason) => {
      console.log('❌ Cliente desconectado:', socket.id, 'Razón:', reason)
    })

    socket.on('connect_error', (error) => {
      console.log('❌ Error de conexión:', error)
    })
  })
}

export { io }
