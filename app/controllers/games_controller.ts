import type { HttpContext } from '@adonisjs/core/http'
import GameService from '#services/game'
import Player from '#models/player'

export default class GamesController {

  public async create({ request, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const maxPlayers = request.input('maxPlayers', 4)
      const hostName = request.input('hostName', user.fullName || user.email)
      const result = await GameService.createGame(user, maxPlayers, hostName)
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async join({ params, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const gameId = params.id
      console.log(`Join request - User: ${user.fullName || user.email}, Game ID: ${gameId}`)
      const player = await GameService.joinGame(gameId, user)
      console.log(`Join successful - User: ${user.fullName || user.email}, Game ID: ${gameId}`)
      return response.ok(player)
    } catch (error: any) {
      console.error(`Join failed - User: ${auth.user?.fullName || auth.user?.email}, Game ID: ${params.id}, Error: ${error.message}`)
      
      if (error.message.includes('Lock wait timeout') || 
          error.message.includes('Deadlock') || 
          error.message.includes('Servicio temporalmente no disponible') ||
          error.cause?.retry) {
        return response.status(503).json({ 
          message: 'El servidor está ocupado, intenta nuevamente en unos segundos',
          retry: true
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
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async requestCard({ response, auth }: HttpContext) {
    try {
      const user = auth.user!
      // Encontrar el jugador activo del usuario
      const player = await Player.query()
        .where('user_id', user.id)
        .preload('game')
        .whereHas('game', (query: any) => {
          query.where('status', 'playing')
        })
        .first()

      if (!player) {
        throw new Error('No tienes una partida activa')
      }

      // Verificar que sea el turno del jugador
      if (player.game.currentPlayerTurn !== player.id) {
        throw new Error('No es tu turno')
      }

      // Marcar que el jugador ha solicitado una carta
      player.hasCardRequest = true
      await player.save()

      console.log(`Player ${player.name} requested a card in game ${player.game.id}`)

      return response.ok({ 
        message: 'Solicitud de carta enviada al anfitrión',
        hasCardRequest: true
      })
    } catch (error) {
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

      // Verificar que quien reparte sea el host del juego
      const targetPlayer = await Player.query()
        .where('id', playerId)
        .preload('game', (query) => {
          query.preload('players')
        })
        .firstOrFail()

      const hostPlayer = targetPlayer.game.players.find(p => p.isHost)
      
      if (!hostPlayer || hostPlayer.userId !== user.id) {
        throw new Error('Solo el anfitrión puede repartir cartas')
      }

      // Verificar que el jugador objetivo tenga una solicitud de carta pendiente
      if (!targetPlayer.hasCardRequest) {
        throw new Error('El jugador no ha solicitado una carta')
      }

      // Limpiar la solicitud de carta
      targetPlayer.hasCardRequest = false
      await targetPlayer.save()

      const dealResult = await GameService.dealCard(playerId)
      console.log(`Card dealt to player ${playerId} by host ${user.fullName || user.email}`)
      
      // Obtener el estado completo del juego después de repartir la carta
      const gameState = await GameService.getGameWithPlayers(targetPlayer.gameId)
      
      return response.ok({
        ...dealResult,
        game: gameState
      })
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async stand({ response, auth }: HttpContext) {
    try {
      const user = auth.user!
      // Encontrar el jugador activo del usuario
      const player = await Player.query()
        .where('user_id', user.id)
        .preload('game')
        .whereHas('game', (query: any) => {
          query.where('status', 'playing')
        })
        .first()

      if (!player) {
        throw new Error('No tienes una partida activa')
      }

      const result = await GameService.stand(player.id)
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

      // Verificar que quien planta sea el host del juego
      const targetPlayer = await Player.query()
        .where('id', playerId)
        .preload('game', (query) => {
          query.preload('players')
        })
        .firstOrFail()

      const hostPlayer = targetPlayer.game.players.find(p => p.isHost)
      
      if (!hostPlayer || hostPlayer.userId !== user.id) {
        throw new Error('Solo el anfitrión puede plantar a otros jugadores')
      }

      const result = await GameService.stand(playerId)
      
      // Obtener el estado completo del juego después de plantar al jugador
      const gameState = await GameService.getGameWithPlayers(targetPlayer.gameId)
      
      return response.ok({
        ...result,
        game: gameState
      })
    } catch (error) {
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
      
      // 🔍 Log para debug - ver qué está retornando el servicio
      console.log('📋 gameInfo completo:', JSON.stringify(gameInfo, null, 2))
      
      // Verificar si hay formattedCards en los jugadores
      if (gameInfo.players) {
        for (const player of gameInfo.players) {
          console.log(`🎮 Jugador ${player.id} formattedCards:`, (player as any).formattedCards)
        }
      }
      
      return response.ok(gameInfo)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async finish({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const result = await GameService.finishGame(gameId)
      return response.ok({ message: 'Partida finalizada', ...result })
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async leave({ response, auth }: HttpContext) {
    try {
      const user = auth.user!
      // Encontrar el jugador activo del usuario
      const player = await Player.query()
        .where('user_id', user.id)
        .preload('game')
        .whereHas('game', (query: any) => {
          query.whereIn('status', ['waiting', 'playing'])
        })
        .first()

      if (!player) {
        throw new Error('No tienes una partida activa')
      }

      const result = await GameService.leaveGame(player.id)
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async revealAndFinish({ params, response }: HttpContext) {
    try {
      const gameId = params.id
      const result = await GameService.revealAndFinish(gameId)
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
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async createRematch({ request, params, response }: HttpContext) {
    try {
      const originalGameId = params.id
      const acceptedPlayers = request.input('acceptedPlayers')
      const result = await GameService.createRematch(originalGameId, acceptedPlayers)
      return response.ok(result)
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