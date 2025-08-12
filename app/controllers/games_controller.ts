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
      
      // ✅ Solo notificar que se creó un juego, sin enviar datos
      io.emit('chisme:newGameCreated')
      
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

      // ✅ Solo notificar que un jugador se unió, sin enviar datos
      io.to(`game:${gameId}`).emit('chisme:playerJoined')
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

      // ✅ Solo notificar que el juego comenzó, sin enviar datos
      io.to(`game:${gameId}`).emit('chisme:gameStarted')

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


      if (player.game.currentPlayerTurn !== player.id) {
        throw new Error(`No es tu turno en esta partida. Tu ID: ${player.id}, Turno actual: ${player.game.currentPlayerTurn}`)
      }

      if (player.isStand) {
        throw new Error('Ya te has plantado y no puedes pedir más cartas')
      }

      player.hasCardRequest = true
      await player.save()

      // ✅ Solo notificar que se solicitó una carta, sin enviar datos
      io.to(`game:${gameId}`).emit('chisme:playerRequestedCard')

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

      // ✅ Solo notificar que se repartió una carta, sin enviar datos
      io.to(`game:${targetPlayer.gameId}`).emit('chisme:cardDealt')

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

      // ✅ Solo notificar que un jugador se plantó, sin enviar datos
      io.to(`game:${gameId}`).emit('chisme:playerStood')

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

      // ✅ Solo notificar que un jugador se plantó, sin enviar datos
      io.to(`game:${targetPlayer.gameId}`).emit('chisme:playerStood')

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
        // ✅ Solo notificar que el juego terminó por abandono, sin enviar datos
        io.to(`game:${gameId}`).emit('chisme:gameEndedByLeave')
      } else {
        // ✅ Solo notificar que un jugador se fue, sin enviar datos
        io.to(`game:${gameId}`).emit('chisme:playerLeft')
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
      
      // ✅ Solo notificar que el juego terminó, sin enviar datos
      io.to(`game:${gameId}`).emit('chisme:gameFinished')

      return response.ok({ ...result, message: 'Partida finalizada' })
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async revealAndFinish({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const result = await GameService.revealAndFinish(gameId)

      // ✅ Solo notificar que el juego terminó, sin enviar datos
      io.to(`game:${gameId}`).emit('chisme:gameFinished')

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

      // ✅ Solo notificar que se propuso revancha, sin enviar datos
      io.to(`game:${gameId}`).emit('chisme:rematchProposed')

      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async respondToRematch({ request, params, response }: HttpContext) {
    try {
      const gameId = params.id
      const { playerId, accepted } = request.only(['playerId', 'accepted'])
      
      const result = await GameService.respondToRematch(gameId, playerId, accepted)
      
      console.log(`📯 Controller respondToRematch result:`, {
        accepted: result.accepted,
        allPlayersAccepted: result.allPlayersAccepted,
        gameRestarting: result.gameRestarting,
        redirectToLobby: result.redirectToLobby
      })
      
      // ✅ PRIMERO enviar respuesta HTTP
      const httpResponse = response.ok(result)
      
      // ✅ LUEGO emitir eventos socket (usando setTimeout para garantizar que la respuesta HTTP se envíe primero)
      setTimeout(() => {
        if (!accepted || result.rematchCancelled) {
          if (result.redirectToLobby && result.allPlayersGoToLobby) {
            console.log(`🚪 Emitiendo chisme:redirectToLobby para game:${gameId}`)
            io.to(`game:${gameId}`).emit('chisme:redirectToLobby', {
              reason: 'rematch_rejected',
              message: result.message,
              playerWhoRejected: result.playerName
            })
          } else {
            console.log(`❌ Emitiendo chisme:rematchCancelled para game:${gameId}`)
            io.to(`game:${gameId}`).emit('chisme:rematchCancelled')
          }
        } else if (result.allPlayersAccepted && result.gameRestarting) {
          console.log(`🎉 Emitiendo chisme:gameRestarted para game:${gameId}`)
          io.to(`game:${gameId}`).emit('chisme:gameRestarted')
        } else {
          console.log(`📧 Emitiendo chisme:rematchResponse para game:${gameId}`)
          io.to(`game:${gameId}`).emit('chisme:rematchResponse')
        }
      }, 300) // 300ms delay para asegurar que el HTTP response se envíe y procese primero
      
      return httpResponse
    } catch (error) {
      console.error(`❌ Error en respondToRematch:`, error.message)
      return response.badRequest({ message: error.message })
    }
  }
  

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
