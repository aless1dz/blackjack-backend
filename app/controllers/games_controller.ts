import type { HttpContext } from '@adonisjs/core/http'
import GameService from '#services/game'
import Player from '#models/player'

export default class GamesController {

  public async create({ request, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const maxPlayers = request.input('maxPlayers', 4)
      const result = await GameService.createGame(user, maxPlayers)
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async join({ params, response, auth }: HttpContext) {
    try {
      const user = auth.user!
      const gameId = params.id
      const player = await GameService.joinGame(gameId, user)
      return response.ok(player)
    } catch (error) {
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

      const result = await GameService.requestCard(player.id)
      return response.ok(result)
    } catch (error) {
      return response.badRequest({ message: error.message })
    }
  }

  public async dealCard({ params, response }: HttpContext) {
    try {
      const playerId = params.playerId
      const result = await GameService.dealCard(playerId)
      return response.ok(result)
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
}