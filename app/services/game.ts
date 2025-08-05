import Game from '../models/game.js'
import Player from '../models/player.js'
import PlayerCard from '../models/player_card.js'

export default class GameService {

  public static async createGame(user: any, maxPlayers: number = 4) {
    const game = await Game.create({ 
      hostName: user.fullName || user.email,
      status: 'waiting',
      maxPlayers 
    })

    const hostPlayer = await Player.create({
      gameId: game.id,
      userId: user.id,
      name: user.fullName || user.email,
      isHost: true,
      totalPoints: 0,
      isStand: false
    })

    return { game, hostPlayer }
  }

  public static async joinGame(gameId: number, user: any) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    if (game.status !== 'waiting') {
      throw new Error('La partida ya ha comenzado')
    }

    if (game.players.length >= game.maxPlayers) {
      throw new Error(`La partida está llena. Máximo ${game.maxPlayers} jugadores`)
    }

    // Verificar que el usuario no esté ya en la partida
    const existingPlayer = game.players.find(p => p.userId === user.id)
    if (existingPlayer) {
      throw new Error('Ya estás en esta partida')
    }

    const player = await Player.create({
      gameId: game.id,
      userId: user.id,
      name: user.fullName || user.email,
      isHost: false,
      totalPoints: 0,
      isStand: false
    })

    // Verificar si la sala se llenó después de agregar el jugador
    const updatedGame = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    let autoStarted = false
    if (updatedGame.players.length === updatedGame.maxPlayers) {
      // Auto-iniciar el juego cuando se llene la sala
      updatedGame.status = 'playing'
      await updatedGame.save()
      autoStarted = true
    }

    return { 
      player, 
      autoStarted,
      message: autoStarted ? 'Te uniste y la partida se inició automáticamente' : 'Te uniste exitosamente a la partida',
      gameStatus: updatedGame.status,
      currentPlayers: updatedGame.players.length,
      maxPlayers: updatedGame.maxPlayers
    }
  }

  public static async startGame(gameId: number, hostPlayerId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    // Verificar que quien inicia sea el host
    const hostPlayer = game.players.find(p => p.id === hostPlayerId && p.isHost)
    if (!hostPlayer) {
      throw new Error('Solo el anfitrión puede iniciar la partida')
    }

    if (game.status !== 'waiting') {
      throw new Error('La partida ya ha comenzado o terminado')
    }

    if (game.players.length < 2) {
      throw new Error('Se necesitan al menos 2 jugadores para iniciar')
    }

    game.status = 'playing'
    await game.save()

    return { 
      message: 'Partida iniciada manualmente por el anfitrión', 
      game,
      currentPlayers: game.players.length,
      maxPlayers: game.maxPlayers
    }
  }

  public static async leaveGame(playerId: number) {
    const player = await Player.query()
      .where('id', playerId)
      .preload('game', (query) => {
        query.preload('players')
      })
      .firstOrFail()

    const game = player.game

    if (game.status === 'finished') {
      throw new Error('No puedes abandonar una partida terminada')
    }

    // Si es el host y hay otros jugadores, transferir host al siguiente jugador
    if (player.isHost && game.players.length > 1) {
      const nextHost = game.players.find(p => p.id !== player.id)
      if (nextHost) {
        nextHost.isHost = true
        await nextHost.save()
      }
    }

    // Eliminar al jugador
    await player.delete()

    // Verificar si queda al menos un jugador
    const remainingPlayers = await Player.query().where('game_id', game.id)
    
    if (remainingPlayers.length === 0) {
      // Si no quedan jugadores, eliminar el juego
      await game.delete()
      return { message: 'Jugador eliminado y partida cerrada (no quedan jugadores)', gameDeleted: true }
    } else if (remainingPlayers.length === 1 && game.status === 'playing') {
      // Si solo queda un jugador en partida activa, terminarlo automáticamente
      const winner = remainingPlayers[0]
      game.winnerId = winner.id
      game.status = 'finished'
      await game.save()
      return { 
        message: 'Jugador eliminado y partida terminada automáticamente', 
        winner,
        autoFinished: true 
      }
    }

    return { 
      message: 'Jugador eliminado exitosamente',
      remainingPlayers: remainingPlayers.length,
      newHost: player.isHost ? remainingPlayers.find(p => p.isHost) : null
    }
  }

  public static async checkAutoFinish(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    if (game.status !== 'playing') {
      return { shouldFinish: false, reason: 'Game not in playing state' }
    }

    // Verificar si todos los jugadores están plantados o se pasaron
    const allPlayersStand = game.players.every(p => p.isStand || p.totalPoints > 21)

    if (allPlayersStand) {
      return { shouldFinish: true, reason: 'All players stand or bust' }
    }

    return { shouldFinish: false, reason: 'Game continues' }
  }

  public static async revealAndFinish(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players', (query) => {
        query.preload('cards')
      })
      .firstOrFail()

    if (game.status !== 'playing') {
      throw new Error('La partida no está en curso')
    }

    // Calcular resultados finales
    const results = game.players.map(player => {
      const isBust = player.totalPoints > 21
      const score = isBust ? 0 : player.totalPoints
      
      return {
        id: player.id,
        name: player.name,
        totalPoints: player.totalPoints,
        finalScore: score,
        isBust,
        isHost: player.isHost,
        cards: player.cards.map(card => card.serialize())
      }
    })

    // Encontrar ganador (mayor puntuación sin pasarse)
    const validPlayers = results.filter(p => !p.isBust)
    let winner = null
    
    if (validPlayers.length > 0) {
      winner = validPlayers.reduce((prev, current) => 
        (current.finalScore > prev.finalScore) ? current : prev
      )
      game.winnerId = winner.id
    }

    game.status = 'finished'
    await game.save()

    return {
      message: 'Partida finalizada - Cartas reveladas',
      results,
      winner,
      gameId: game.id
    }
  }

  public static async proposeRematch(gameId: number, hostPlayerId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    // Verificar que quien propone sea el host
    const hostPlayer = game.players.find(p => p.id === hostPlayerId && p.isHost)
    if (!hostPlayer) {
      throw new Error('Solo el anfitrión puede proponer una revancha')
    }

    if (game.status !== 'finished') {
      throw new Error('Solo se puede proponer revancha en partidas terminadas')
    }

    // Crear registro de revancha pendiente (podrías crear una tabla para esto)
    // Por simplicidad, lo manejaremos en memoria o usando un campo temporal
    
    return {
      message: 'Propuesta de revancha enviada a todos los jugadores',
      gameId: game.id,
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost
      })),
      rematchProposed: true
    }
  }

  public static async respondToRematch(gameId: number, playerId: number, accepted: boolean) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    const player = game.players.find(p => p.id === playerId)
    if (!player) {
      throw new Error('Jugador no encontrado en esta partida')
    }

    // Aquí normalmente guardarías las respuestas en una tabla
    // Por simplicidad, asumimos que todas las respuestas se procesan inmediatamente
    
    return {
      message: accepted ? 'Revancha aceptada' : 'Revancha rechazada',
      playerId,
      playerName: player.name,
      accepted
    }
  }

  public static async createRematch(originalGameId: number, acceptedPlayers: number[]) {
    const originalGame = await Game.query()
      .where('id', originalGameId)
      .preload('players')
      .firstOrFail()

    // Encontrar el host original
    const originalHost = originalGame.players.find(p => p.isHost)
    if (!originalHost) {
      throw new Error('No se encontró el anfitrión original')
    }

    // Crear nueva partida
    const newGame = await Game.create({
      hostName: originalHost.name,
      status: 'waiting',
      maxPlayers: originalGame.maxPlayers
    })

    // Agregar jugadores que aceptaron
    const newPlayers = []
    for (const playerId of acceptedPlayers) {
      const originalPlayer = originalGame.players.find(p => p.id === playerId)
      if (originalPlayer) {
        const newPlayer = await Player.create({
          gameId: newGame.id,
          name: originalPlayer.name,
          isHost: originalPlayer.isHost,
          totalPoints: 0,
          isStand: false
        })
        newPlayers.push(newPlayer)
      }
    }

    return {
      message: 'Nueva partida creada para la revancha',
      newGame,
      players: newPlayers
    }
  }

  public static async getGameInfo(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    return {
      game,
      currentPlayers: game.players.length,
      maxPlayers: game.maxPlayers,
      canStart: game.players.length >= 2 && game.status === 'waiting',
      willAutoStart: game.players.length === game.maxPlayers - 1, // Falta 1 jugador para auto-iniciar
      playersNeeded: Math.max(0, 2 - game.players.length) // Jugadores mínimos necesarios
    }
  }

  public static async listAvailableGames() {
    const games = await Game.query()
      .where('status', 'waiting')
      .preload('players')
      .orderBy('created_at', 'desc')

    return games.map(game => ({
      id: game.id,
      hostName: game.hostName,
      currentPlayers: game.players.length,
      maxPlayers: game.maxPlayers,
      status: game.status,
      createdAt: game.createdAt,
      canJoin: game.players.length < game.maxPlayers
    }))
  }

  public static async requestCard(playerId: number) {
    // Aquí puedes lanzar un evento de socket si quieres
    return { message: `Jugador ${playerId} pidió carta` }
  }

  public static async dealCard(playerId: number) {
    const card = this.getRandomCard()

    await PlayerCard.create({
      playerId,
      card
    })

    const player = await Player.query()
      .where('id', playerId)
      .preload('game')
      .firstOrFail()

    player.totalPoints += this.cardValue(card)

    if (player.totalPoints > 21) {
      player.isStand = true
    }

    await player.save()

    // Verificar si el juego debe terminar automáticamente
    const autoFinishCheck = await this.checkAutoFinish(player.game.id)
    let autoFinished = false
    let gameResults = null

    if (autoFinishCheck.shouldFinish) {
      gameResults = await this.revealAndFinish(player.game.id)
      autoFinished = true
    }

    return { 
      card, 
      totalPoints: player.totalPoints, 
      isStand: player.isStand,
      autoFinished,
      gameResults
    }
  }

  public static async stand(playerId: number) {
    const player = await Player.query()
      .where('id', playerId)
      .preload('game')
      .firstOrFail()

    player.isStand = true
    await player.save()

    // Verificar si el juego debe terminar automáticamente
    const autoFinishCheck = await this.checkAutoFinish(player.game.id)
    let autoFinished = false
    let gameResults = null

    if (autoFinishCheck.shouldFinish) {
      gameResults = await this.revealAndFinish(player.game.id)
      autoFinished = true
    }

    return { 
      message: 'Jugador se plantó',
      autoFinished,
      gameResults
    }
  }

  public static async getGameStatus(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players', (query) => {
        query.preload('cards')
      })
      .firstOrFail()

    return game
  }

  public static async finishGame(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    const activePlayers = game.players.filter(p => p.totalPoints <= 21)

    let winner = null
    if (activePlayers.length > 0) {
      winner = activePlayers.sort((a, b) => b.totalPoints - a.totalPoints)[0]
      game.winnerId = winner.id
    }

    game.status = 'finished'
    await game.save()

    return { winner }
  }

  private static getRandomCard(): string {
    const cards = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
    const suits = ['♠️', '♥️', '♦️', '♣️']
    return cards[Math.floor(Math.random() * cards.length)] + suits[Math.floor(Math.random() * suits.length)]
  }

  private static cardValue(card: string): number {
    const value = card.slice(0, -1)
    if (['J', 'Q', 'K'].includes(value)) return 10
    if (value === 'A') return 11 // Simplificado
    return parseInt(value)
  }
}