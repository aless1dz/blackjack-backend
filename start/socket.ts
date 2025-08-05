import { Server as SocketServer } from 'socket.io'

let io: SocketServer

const initializeSocket = (httpServer: any) => {
  io = new SocketServer(httpServer, {
    cors: {
      origin: '*'
    }
  })

  io.on('connection', (socket) => {
    console.log(`Socket conectado: ${socket.id}`)

    socket.on('join:game', (gameId) => {
      socket.join(`game:${gameId}`)
      console.log(`Socket ${socket.id} se unió a game:${gameId}`)
    })

    socket.on('notify:requestCard', (data) => {
      const { gameId, playerId } = data
      io.to(`game:${gameId}`).emit('chisme:requestCard', { playerId })
    })

    socket.on('notify:dealCard', (data) => {
      const { gameId, playerId, card } = data
      io.to(`game:${gameId}`).emit('chisme:dealCard', { playerId, card })
    })

    socket.on('notify:stand', (data) => {
      const { gameId, playerId } = data
      io.to(`game:${gameId}`).emit('chisme:stand', { playerId })
    })

    socket.on('notify:bust', (data) => {
      const { gameId, playerId } = data
      io.to(`game:${gameId}`).emit('chisme:bust', { playerId })
    })

    socket.on('notify:startGame', (data) => {
      const { gameId } = data
      io.to(`game:${gameId}`).emit('chisme:startGame')
    })

    socket.on('notify:gameEnd', (data) => {
      const { gameId, winnerId } = data
      io.to(`game:${gameId}`).emit('chisme:gameEnd', { winnerId })
    })

    socket.on('notify:leaveGame', (data) => {
      const { gameId, playerId } = data
      socket.leave(`game:${gameId}`)
      io.to(`game:${gameId}`).emit('chisme:playerLeft', { playerId })
    })

    socket.on('disconnect', () => {
      console.log(`Socket desconectado: ${socket.id}`)
    })
  })

  return io
}

export { io, initializeSocket }