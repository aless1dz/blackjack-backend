// controllers/games_controller.ts - Versión mejorada con eventos consistentes
import type { HttpContext } from '@adonisjs/core/http'
import GameService from '#services/game'
import Player from '#models/player'
import { io } from '#start/socket'

export default class GamesController {
  public async create({ request, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const maxPlayers = request.input('maxPlayers', 4)
      const hostName = request.input('hostName', user.fullName || user.email)
      const result = await GameService.createGame(user, maxPlayers, hostName)
      
      io.emit('chisme:newGameCreated', { 
        game: result.game,
        host: result.hostPlayer,
        message: 'Nueva partida creada'
      })
      
      console.log(`🎮 Nueva partida creada: ${result.game.id} por ${hostName}`)
      
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async join({ params, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      let gameId = params.id

      if (typeof gameId === 'object' && gameId !== null) {
        gameId = gameId.id || gameId.gameId || JSON.stringify(gameId)
      }

      const player = await GameService.joinGame(gameId, user)

      io.to(`game:${gameId}`).emit('chisme:playerJoined', { player })
      console.log(`Player ${player.player.name || JSON.stringify(player)} se unió a game:${gameId}`)
      return response.ok(player)
    } catch (error: any) {
      console.error(
        `Join failed - User: ${auth.user?.fullName || auth.user?.email}, Game ID: ${params.id}, Error: ${error.message}`
      )

      if (
        error.message.includes('Lock wait timeout') ||
        error.message.includes('Deadlock') ||
        error.message.includes('Servicio temporalmente no disponible') ||
        error.cause?.retry
      ) {
        return response.status(503).json({
          message: 'El servidor está ocupado, intenta nuevamente en unos segundos',
          retry: true,
        })
      }

      return response.badRequest({ message: error.message })
    }
  }

  public async start({ request, params, response }: HttpContext) {
    try {
      const gameId = params.id
      const hostPlayerId = request.input('hostPlayerId')
      const result = await GameService.startGame(gameId, hostPlayerId)

      io.to(`game:${gameId}`).emit('chisme:gameStarted', { game: result })

      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async requestCard({ request, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const gameId = request.input('gameId') 
      
      if (!gameId) {
        throw new Error('gameId es requerido')
      }

      const player = await Player.query()
        .where('user_id', user.id)
        .where('game_id', gameId)
        .preload('game')
        .first()

      if (!player) {
        throw new Error('No estás en esta partida')
      }

      if (player.game.status !== 'playing') {
        throw new Error('Esta partida no está en progreso')
      }

      console.log(`🃏 requestCard: Usuario ${user.id} en partida ${gameId}, turno actual: ${player.game.currentPlayerTurn}, su ID: ${player.id}`)

      if (player.game.currentPlayerTurn !== player.id) {
        throw new Error(`No es tu turno en esta partida. Tu ID: ${player.id}, Turno actual: ${player.game.currentPlayerTurn}`)
      }

      if (player.isStand) {
        throw new Error('Ya te has plantado y no puedes pedir más cartas')
      }

      player.hasCardRequest = true
      await player.save()

      console.log(`📨 Emitiendo evento chisme:playerRequestedCard para partida ${gameId}`)
      io.to(`game:${gameId}`).emit('chisme:playerRequestedCard', { 
        player,
        gameId: gameId,
        playerId: player.id
      })

      return response.ok({
        message: 'Solicitud de carta enviada al anfitrión',
        hasCardRequest: true,
        gameId: gameId,
        playerId: player.id
      })
    } catch (error) {
      console.error(`❌ requestCard error para usuario ${auth.user?.id}:`, error.message)
      return response.badRequest({ message: error.message })
    }
  }

  public async dealCard({ request, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const playerId = request.input('playerId')

      if (!playerId) {
        throw new Error('playerId es requerido')
      }

      const targetPlayer = await Player.query()
        .where('id', playerId)
        .preload('game', (query) => {
          query.preload('players')
        })
        .firstOrFail()

      const hostPlayer = targetPlayer.game.players.find((p) => p.isHost)

      if (!hostPlayer || hostPlayer.userId !== user.id) {
        throw new Error('Solo el anfitrión puede repartir cartas')
      }

      if (!targetPlayer.hasCardRequest) {
        throw new Error('El jugador no ha solicitado una carta')
      }

      targetPlayer.hasCardRequest = false
      await targetPlayer.save()

      const dealResult = await GameService.dealCard(playerId)
      const gameState = await GameService.getGameWithPlayers(targetPlayer.gameId)

      io.to(`game:${targetPlayer.gameId}`).emit('chisme:cardDealt', { game: gameState })

      return response.ok({
        ...dealResult,
        game: gameState,
      })
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async stand({ request, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const gameId = request.input('gameId')
      
      if (!gameId) {
        throw new Error('gameId es requerido')
      }

      const player = await Player.query()
        .where('user_id', user.id)
        .where('game_id', gameId)
        .preload('game')
        .first()

      if (!player) {
        throw new Error('No estás en esta partida')
      }

      if (player.game.status !== 'playing') {
        throw new Error('Esta partida no está en progreso')
      }

      const result = await GameService.stand(player.id)

      io.to(`game:${gameId}`).emit('chisme:playerStood', { 
        playerId: player.id,
        gameId: gameId
      })

      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async standPlayer({ request, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const playerId = request.input('playerId')

      if (!playerId) {
        throw new Error('playerId es requerido')
      }

      const targetPlayer = await Player.query()
        .where('id', playerId)
        .preload('game', (query) => {
          query.preload('players')
        })
        .firstOrFail()

      const hostPlayer = targetPlayer.game.players.find((p) => p.isHost)

      if (!hostPlayer || hostPlayer.userId !== user.id) {
        throw new Error('Solo el anfitrión puede plantar a otros jugadores')
      }

      const result = await GameService.stand(playerId)
      const gameState = await GameService.getGameWithPlayers(targetPlayer.gameId)

      io.to(`game:${targetPlayer.gameId}`).emit('chisme:playerStood', {
        playerId: playerId,
        game: gameState,
      })

      return response.ok({
        ...result,
        game: gameState,
      })
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async leave({ request, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const gameId = request.input('gameId') 
      
      if (!gameId) {
        throw new Error('gameId es requerido')
      }

      const player = await Player.query()
        .where('user_id', user.id)
        .where('game_id', gameId)
        .preload('game')
        .first()

      if (!player) {
        throw new Error('No estás en esta partida')
      }

      const result = await GameService.leaveGame(player.id)

      if (result.gameEnded) {
        io.to(`game:${gameId}`).emit('chisme:gameEndedByLeave', { 
          playerId: player.id,
          gameId: gameId,
          message: result.message,
          reason: result.reason || 'player_left'
        })
        console.log(`🛑 Partida ${gameId} terminada por abandono: ${result.message}`)
      } else {
        io.to(`game:${gameId}`).emit('chisme:playerLeft', { 
          playerId: player.id,
          gameId: gameId
        })
      }

      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async finish({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const result = await GameService.finishGame(gameId)

      // ✅ Evento consistente con prefijo
      console.log('🔍 DEBUG FINISH - Enviando evento chisme:gameFinished:')
      console.log('  - gameId:', gameId)
      console.log('  - result.game:', result.game ? 'presente' : 'ausente')
      console.log('  - result.winners:', result.winners)
      console.log('  - result.gameResult:', result.gameResult)
      console.log('  - result.message:', result.message)
      
      io.to(`game:${gameId}`).emit('chisme:gameFinished', { game: result })

      return response.ok({ ...result, message: 'Partida finalizada' })
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async revealAndFinish({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const result = await GameService.revealAndFinish(gameId)

      // ✅ Evento consistente con prefijo
      io.to(`game:${gameId}`).emit('chisme:gameFinished', { game: result })

      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async proposeRematch({ request, params, response }: HttpContext) {
    try {
      const gameId = params.id
      const hostPlayerId = request.input('hostPlayerId')
      const result = await GameService.proposeRematch(gameId, hostPlayerId)

      // ✅ Evento consistente con prefijo
      io.to(`game:${gameId}`).emit('chisme:rematchProposed', { rematch: result })

      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async respondToRematch({ request, params, response }: HttpContext) {
    try {
      const gameId = params.id
      const { playerId, accepted } = request.only(['playerId', 'accepted'])
      
      if (!accepted) {
        console.log(`❌ Jugador ${playerId} rechazó la revancha en partida ${gameId} - Cancelando para todos`)
        io.to(`game:${gameId}`).emit('chisme:rematchCancelled', {
          playerId,
          gameId,
          message: 'La revancha ha sido cancelada porque un jugador rechazó',
          rejectedBy: playerId
        })
        const result = await GameService.respondToRematch(gameId, playerId, accepted)
        return response.ok(result)
      }

      const result = await GameService.respondToRematch(gameId, playerId, accepted)
      
      io.to(`game:${gameId}`).emit('chisme:rematchResponse', { 
        playerId, 
        accepted, 
        playerName: result.playerName || 'Jugador',
        message: `${result.playerName || 'Un jugador'} aceptó la revancha`
      })

      if (result.newGameId) {
        console.log(`🎮 Jugador se unió a partida de revancha ${result.newGameId}`)
        
        const originalGame = await GameService.getGameWithPlayers(gameId)
        const rematchGame = await GameService.getGameWithPlayers(result.newGameId)
        
        const originalNonHostPlayers = originalGame.players.filter((p: any) => !p.isHost)
        const rematchNonHostPlayers = rematchGame.players.filter((p: any) => !p.isHost)
        
        
        if (rematchNonHostPlayers.length === originalNonHostPlayers.length) {
          console.log('🎉 ¡TODOS los jugadores aceptaron la revancha! Redirigiendo a todos.')
          console.log(`🚀 Emitiendo chisme:allPlayersAcceptedRematch a sala game:${gameId}`)
          
          const eventData = {
            newGame: rematchGame,
            newGameId: rematchGame.id,
            message: 'Todos aceptaron la revancha - Redirigiendo a la nueva partida',
            playersReady: rematchNonHostPlayers.length,
            totalPlayers: originalNonHostPlayers.length
          }
          
          io.to(`game:${gameId}`).emit('chisme:allPlayersAcceptedRematch', eventData)
          console.log(`📡 Evento emitido a sala game:${gameId}`, eventData)
        } else {
          console.log(`⏳ Esperando más jugadores: ${rematchNonHostPlayers.length}/${originalNonHostPlayers.length}`)
        }
      }

      // ✅ CAMBIO CLAVE: NO devolver newGameId en la respuesta individual para evitar redirección prematura
      return response.ok({
        message: result.message,
        gameId: result.gameId,
        playerId: result.playerId,
        accepted: result.accepted,
        // NO incluir newGameId aquí - solo se incluirá cuando TODOS hayan aceptado via evento
      })
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async createRematch({ request, params, response }: HttpContext) {
    try {
      const originalGameId = params.id
      const acceptedPlayers = request.input('acceptedPlayers')
      const result = await GameService.createRematch(originalGameId, acceptedPlayers)

      // ✅ Evento consistente con prefijo
      io.to(`game:${originalGameId}`).emit('chisme:newGameCreated', { newGame: result })

      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  // ... resto de métodos sin cambios
  public async status({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const game = await GameService.getGameStatus(gameId)
      return response.ok(game)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async info({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const gameInfo = await GameService.getGameInfo(gameId)
      return response.ok(gameInfo)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async listAvailable({ response }: HttpContext) {
    try {
      const games = await GameService.listAvailableGames()
      return response.ok(games)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async getPlayersForRematch({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const result = await GameService.getPlayersForRematch(gameId)
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async getPendingCardRequests({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const result = await GameService.getPendingCardRequests(gameId)
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }
}
