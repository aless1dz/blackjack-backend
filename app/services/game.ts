import Game from '../models/game.js'
import Player from '../models/player.js'
import PlayerCard from '../models/player_card.js'
import db from '@adonisjs/lucid/services/db'

export default class GameService {
  // Crear una baraja completa de 52 cartas
  private static createFullDeck(): string[] {
    const suits = ['hearts', 'diamonds', 'clubs', 'spades']
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
    const deck: string[] = []
    
    for (const suit of suits) {
      for (const value of values) {
        deck.push(`${value}_${suit}`)
      }
    }
    
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[deck[i], deck[j]] = [deck[j], deck[i]]
    }
    
    return deck
  }
  
  private static async drawCardFromDeck(gameId: number, trx?: any): Promise<{ cardKey: string; formattedCard: string }> {
    const game = await Game.query(trx ? { client: trx } : {})
      .where('id', gameId)
      .firstOrFail()
    
    if (!game.deck) {
      throw new Error('No hay baraja en el juego')
    }
    
    let currentDeck: string[]
    try {
      currentDeck = JSON.parse(game.deck)
    } catch (error) {
      throw new Error('Error al leer la baraja del juego')
    }
    
    if (currentDeck.length === 0) {
      throw new Error('No hay más cartas en la baraja')
    }
    
    const cardKey = currentDeck.shift()!
    
    const updatedDeckJson = JSON.stringify(currentDeck)
    if (trx) {
      await Game.query({ client: trx }).where('id', gameId).update({ deck: updatedDeckJson })
    } else {
      game.deck = updatedDeckJson
      await game.save()
    }
    
    const [value, suit] = cardKey.split('_')
    const suitEmojis: { [key: string]: string } = {
      hearts: '♥️',
      diamonds: '♦️',
      clubs: '♣️',
      spades: '♠️',
    }
    
    const formattedCard = `${value}${suitEmojis[suit] || '❓'}`
    
    return { cardKey, formattedCard }
  }
  public static async createGame(user: any, maxPlayers: number = 6, hostName?: string) {
    if (maxPlayers < 3) {
      throw new Error('Se necesitan mínimo 3 jugadores además del host (4 jugadores total)')
    }
    if (maxPlayers > 6) {
      throw new Error('Máximo 6 jugadores además del host (7 jugadores total)')
    }
    
    const fullDeck = this.createFullDeck()
    
    const game = await Game.create({
      hostName: hostName || user.fullName || user.email,
      status: 'waiting',
      maxPlayers,
      deck: JSON.stringify(fullDeck),
    })

    const hostPlayer = await Player.create({
      gameId: game.id,
      userId: user.id,
      name: user.fullName || user.email,
      isHost: true,
      totalPoints: 0,
      isStand: false,
    })

    return { game, hostPlayer }
  }

  public static async joinGame(gameId: number, user: any) {
    try {
      const joinResult = await db.transaction(async (trx) => {
        await trx.raw('SET innodb_lock_wait_timeout = 10')

        const game = await Game.query({ client: trx })
          .where('id', gameId)
          .preload('players')
          .forUpdate()
          .firstOrFail()

        if (game.status !== 'waiting') {
          throw new Error('La partida ya ha comenzado')
        }

        const existingPlayer = game.players.find((p) => p.userId === user.id)
        if (existingPlayer) {
          throw new Error('Ya estás en esta partida')
        }

        const currentNonHostPlayers = game.players.filter((p) => !p.isHost).length
        if (currentNonHostPlayers >= game.maxPlayers) {
          throw new Error(
            `La partida está llena. Máximo ${game.maxPlayers} jugadores (sin contar el anfitrión). Actualmente hay ${currentNonHostPlayers} jugadores.`
          )
        }

        const currentPlayerCount = await Player.query({ client: trx })
          .where('gameId', gameId)
          .where('isHost', false)
          .count('* as total')

        const currentCount = Number((currentPlayerCount[0] as any).$extras.total)
        if (currentCount >= game.maxPlayers) {
          throw new Error(
            `La partida está llena. Máximo ${game.maxPlayers} jugadores (sin contar el anfitrión). Actualmente hay ${currentCount} jugadores.`
          )
        }

        const player = await Player.create(
          {
            gameId: game.id,
            userId: user.id,
            name: user.fullName || user.email,
            isHost: false,
            totalPoints: 0,
            isStand: false,
          },
          { client: trx }
        )

        // NO repartir carta aquí - se repartirá al iniciar la partida

        const updatedGame = await Game.query({ client: trx })
          .where('id', gameId)
          .preload('players')
          .firstOrFail()

        const newNonHostPlayers = updatedGame.players.filter((p) => !p.isHost).length

        let autoStarted = false
        if (newNonHostPlayers === updatedGame.maxPlayers) {
          await Game.query({ client: trx }).where('id', gameId).update({
            status: 'starting',
          })

          autoStarted = true
        }

        return {
          player,
          autoStarted,
          message: autoStarted
            ? 'Te uniste y la partida se iniciará automáticamente'
            : 'Te uniste exitosamente a la partida',
          gameStatus: autoStarted ? 'starting' : updatedGame.status,
          currentPlayers: updatedGame.players.length,
          maxPlayers: updatedGame.maxPlayers,
        }
      }) 

      if (joinResult.autoStarted) {
        setTimeout(async () => {
          try {
            await this.performAutoStart(gameId)
          } catch (error) {}
        }, 1000)
      }

      return joinResult
    } catch (error: any) {
      if (error.message?.includes('Lock wait timeout exceeded')) {
        throw new Error('Servicio temporalmente no disponible. Inténtalo de nuevo.', {
          cause: { retry: true },
        })
      }

      throw error
    }
  }

  public static async performAutoStart(gameId: number) {
    const result = await db.transaction(async (trx) => {
      await trx.raw('SET innodb_lock_wait_timeout = 3')

      const game = await Game.query({ client: trx })
        .where('id', gameId)
        .preload('players')
        .forUpdate()
        .firstOrFail()

      if (game.status !== 'starting') {
        return game
      }

      const nonHostPlayers = game.players.filter((p) => !p.isHost)

      if (nonHostPlayers.length < game.maxPlayers) {
        await Game.query({ client: trx }).where('id', gameId).update({ status: 'waiting' })
        return game
      }

      const playersOnly = game.players.filter((p) => !p.isHost)

      // Solo repartir cartas a jugadores que no tengan cartas aún
      for (const gamePlayer of playersOnly) {
        // Verificar si el jugador ya tiene cartas
        const existingCards = await PlayerCard.query(trx ? { client: trx } : {})
          .where('playerId', gamePlayer.id)
          .count('* as total')
        
        const cardCount = Number((existingCards[0] as any).$extras.total)
        
        // Solo dar carta si no tiene ninguna
        if (cardCount === 0) {
          console.log(`🃏 Repartiendo carta inicial a ${gamePlayer.name} (ID: ${gamePlayer.id})`)
          await this.dealCard(gamePlayer.id, trx, true)
        } else {
          console.log(`⚠️ ${gamePlayer.name} (ID: ${gamePlayer.id}) ya tiene ${cardCount} cartas, omitiendo reparto inicial`)
        }
      }

      const firstPlayer = game.players.find((p) => !p.isHost)
      if (!firstPlayer) {
        throw new Error('No hay jugadores válidos para iniciar el juego')
      }

      await Game.query({ client: trx }).where('id', gameId).update({
        status: 'playing',
        currentPlayerTurn: firstPlayer.id,
        updatedAt: new Date(),
      })

      const updatedGame = await Game.query({ client: trx })
        .where('id', gameId)
        .preload('players', (query) => {
          query.preload('cards')
        })
        .firstOrFail()

      return updatedGame
    })

    
    if (result && result.status === 'playing') {
      const { io } = await import('#start/socket')
      console.log(`🎮 Auto-starting game ${gameId} - emitting chisme:gameStarted`)
      // ✅ Solo notificar que el juego se inició automáticamente, sin enviar datos
      io.to(`game:${gameId}`).emit('chisme:gameStarted')
    }

    return result
  }

  public static async startGame(gameId: number, hostPlayerId: number) {
    const game = await Game.query().where('id', gameId).preload('players').firstOrFail()

    const hostPlayer = game.players.find((p) => p.id === hostPlayerId && p.isHost)
    if (!hostPlayer) {
      throw new Error('Solo el anfitrión puede iniciar la partida')
    }

    if (game.status !== 'waiting') {
      throw new Error('La partida ya ha comenzado')
    }

    // ✅ Validar que haya mínimo 3 jugadores + host (4 total)
    const nonHostPlayers = game.players.filter(p => !p.isHost).length
    if (nonHostPlayers < 3) {
      throw new Error('Se necesitan mínimo 3 jugadores además del host para iniciar la partida')
    }

    game.status = 'playing'

    const playersOnly = game.players.filter((p) => !p.isHost)
    
    // Solo repartir cartas a jugadores que no tengan cartas aún
    for (const player of playersOnly) {
      // Verificar si el jugador ya tiene cartas
      const existingCards = await PlayerCard.query()
        .where('playerId', player.id)
        .count('* as total')
      
      const cardCount = Number((existingCards[0] as any).$extras.total)
      
      // Solo dar carta si no tiene ninguna
      if (cardCount === 0) {
        console.log(`🃏 Repartiendo carta inicial a ${player.name} (ID: ${player.id}) - Inicio manual`)
        await this.dealCard(player.id, undefined, true) // skipTurnLogic = true durante inicio manual también
      } else {
        console.log(`⚠️ ${player.name} (ID: ${player.id}) ya tiene ${cardCount} cartas, omitiendo reparto inicial - Inicio manual`)
      }
    }

    const firstPlayer = game.players.find((p) => !p.isHost)
    if (!firstPlayer) {
      throw new Error('No hay jugadores válidos para iniciar el juego')
    }
    game.currentPlayerTurn = firstPlayer.id

    await game.save()

    return this.getGameWithPlayers(game.id)
  }

  public static async requestCard(playerId: number) {
    // Buscar el jugador
    const player = await Player.query()
      .where('id', playerId)
      .preload('game', (query) => {
        query.preload('players')
      })
      .firstOrFail()

    // Verificar que el juego esté en progreso
    if (player.game.status !== 'playing') {
      throw new Error('El juego no está en progreso')
    }

    // Verificar que sea el turno del jugador
    if (player.game.currentPlayerTurn !== playerId) {
      throw new Error('No es tu turno')
    }

    // Verificar que el jugador no se haya plantado
    if (player.isStand) {
      throw new Error('Ya te has plantado')
    }

    // Marcar que el jugador tiene una solicitud pendiente
    player.hasCardRequest = true
    await player.save()

    return { success: true, message: 'Solicitud de carta enviada al anfitrión' }
  }

  public static async dealCard(playerId: number, trx?: any, skipTurnLogic = false) {
    // Obtener el jugador y su juego
    const player = await Player.query(trx ? { client: trx } : {})
      .where('id', playerId)
      .preload('game')
      .preload('cards')
      .firstOrFail()

    const { cardKey, formattedCard } = await this.drawCardFromDeck(player.gameId, trx)

    // Crear la carta del jugador
    const playerCard = await PlayerCard.create(
      {
        playerId,
        card: formattedCard,
      },
      trx ? { client: trx } : {}
    )

    // Recalcular puntos totales
    let totalPoints = 0
    let aces = 0

    // Incluir la nueva carta en el cálculo
    const allCards = [...player.cards, playerCard]

    for (const cardItem of allCards) {
      const cardString = cardItem.card
      let cardValue = ''

      // Extraer el valor de la carta
      if (cardString.includes('♥️')) {
        cardValue = cardString.replace('♥️', '')
      } else if (cardString.includes('♦️')) {
        cardValue = cardString.replace('♦️', '')
      } else if (cardString.includes('♣️')) {
        cardValue = cardString.replace('♣️', '')
      } else if (cardString.includes('♠️')) {
        cardValue = cardString.replace('♠️', '')
      } else {
        // Formato alternativo: A_hearts -> A
        cardValue = cardString.split('_')[0] || cardString
      }

      let cardPoints = 0

      if (cardValue === 'A') {
        aces++
        cardPoints = 1 // ✅ AS SIEMPRE VALE 1 como solicitaste
      } else if (['J', 'Q', 'K'].includes(cardValue)) {
        cardPoints = 10
      } else {
        cardPoints = parseInt(cardValue)
        if (isNaN(cardPoints)) {
          console.error(
            `❌ Error: No se pudo parsear el valor "${cardValue}" de la carta ${cardItem.card}`
          )
          cardPoints = 0
        }
      }

      totalPoints += cardPoints
    }

    // Actualizar los puntos del jugador
    player.totalPoints = totalPoints
    player.hasCardRequest = false

    // Verificar si el jugador se planta automáticamente o gana
    if (totalPoints > 21) {
      player.isStand = true
    } else if (totalPoints === 21) {
      player.isStand = true
    }

    // Guardar el jugador
    if (trx) {
      player.useTransaction(trx)
    }
    await player.save()

    // 🎉 NUEVA LÓGICA: Si alguien llega a 21, termina el juego inmediatamente
    if (!skipTurnLogic && totalPoints === 21) {
      console.log(`🎉 ¡${player.name} llegó a 21! Terminando juego inmediatamente...`)
      
      // Terminar el juego inmediatamente
      const endResult = await this.endGameWithWinner(player.gameId, player.userId)
      
      const { io } = await import('#start/socket')
      // ✅ Notificar que el juego terminó por 21
      io.to(`game:${player.gameId}`).emit('chisme:gameFinished')
      
      return { totalPoints, card: this.formatCardToSpanish(cardKey.split('_')[0], cardKey.split('_')[1]), cardRaw: formattedCard, gameWon: true, winner: player.name }
    }

    // Lógica de turnos normal (solo si no se ganó con 21)
    if (!skipTurnLogic) {
      const remainingPlayers = await Player.query(trx ? { client: trx } : {})
        .where('game_id', player.gameId)
        .where('is_host', false) // Solo considerar jugadores, no el host
        .where('is_stand', false)
        .where('total_points', '<=', 21)

      if (remainingPlayers.length === 0) {
        const endResult = await this.endGame(player.gameId)
        const gameWithPlayers = await this.getGameWithPlayers(player.gameId)
        
        
        const { io } = await import('#start/socket')
        // ✅ Solo notificar que el juego terminó, sin enviar datos
        io.to(`game:${player.gameId}`).emit('chisme:gameFinished')
      } else {
        await this.nextTurn(player.gameId)
      }
    }

    // Formatear carta para mostrar
    const [value, suit] = cardKey.split('_')
    const cardDisplay = this.formatCardToSpanish(value, suit)

    return { totalPoints, card: cardDisplay, cardRaw: formattedCard }
  }

  private static formatCardToSpanish(
    value: string,
    suit: string
  ): { value: string; suit: string; display: string; emoji: string; card: string } {
    const valueNames: { [key: string]: string } = {
      'A': 'A',
      '2': '2',
      '3': '3',
      '4': '4',
      '5': '5',
      '6': '6',
      '7': '7',
      '8': '8',
      '9': '9',
      '10': '10',
      'J': 'J',
      'Q': 'Q',
      'K': 'K',
    }

    const suitSymbols: { [key: string]: string } = {
      hearts: '♥',
      diamonds: '♦',
      clubs: '♣',
      spades: '♠',
    }

    const suitEmojis: { [key: string]: string } = {
      hearts: '❤️',
      diamonds: '💎',
      clubs: '♣️',
      spades: '♠️',
    }

    const suitNames: { [key: string]: string } = {
      hearts: 'Corazones',
      diamonds: 'Diamantes',
      clubs: 'Tréboles',
      spades: 'Espadas',
    }

    const displayValue = valueNames[value] || value
    const symbol = suitSymbols[suit] || '?'
    const emoji = suitEmojis[suit] || '❓'
    const suitName = suitNames[suit] || suit

    const cardVisual = this.createCardVisual(displayValue, symbol)

    const display = `${displayValue}${emoji}`

    return {
      value: displayValue,
      suit: suitName,
      display,
      emoji,
      card: cardVisual,
    }
  }

  private static createCardVisual(value: string, symbol: string): string {
    const valueLength = value.length
    const topSpacing = valueLength === 1 ? ' ' : ''
    const bottomSpacing = valueLength === 1 ? ' ' : ''

    const card = `
┌─────────┐
│${value}${topSpacing}       │
│         │
│    ${symbol}    │
│         │
│       ${bottomSpacing}${value}│
└─────────┘`

    return card.trim()
  }

  public static async standPlayer(playerId: number) {
    const player = await Player.query().where('id', playerId).preload('game').firstOrFail()

    if (player.game.status !== 'playing') {
      throw new Error('El juego no está en progreso')
    }

    if (player.game.currentPlayerTurn !== playerId) {
      throw new Error('No es tu turno')
    }

    player.isStand = true
    await player.save()

    const remainingPlayers = await Player.query()
      .where('game_id', player.gameId)
      .where('is_host', false) // Solo considerar jugadores, no el host
      .where('is_stand', false)

    if (remainingPlayers.length === 0) {
      const endResult = await this.endGame(player.gameId)
      const gameWithPlayers = await this.getGameWithPlayers(player.gameId)
      
      // ✅ Solo notificar que el juego terminó por stand, sin enviar datos
      const { io } = await import('#start/socket')
      io.to(`game:${player.gameId}`).emit('chisme:gameFinished')
    } else {
      await this.nextTurn(player.gameId)
    }

    const gameState = await this.getGameWithPlayers(player.gameId)
    return { success: true, game: gameState }
  }

  private static async nextTurn(gameId: number) {
    const game = await Game.query().where('id', gameId).preload('players').firstOrFail()

    // Solo jugadores que no son host, no están plantados y no se han pasado de 21
    const activePlayers = game.players.filter((p) => 
      !p.isHost && 
      !p.isStand && 
      p.totalPoints <= 21
    )

    console.log(`🔄 nextTurn: Jugadores activos encontrados: ${activePlayers.length}`)
    console.log(`📋 Jugadores activos: ${activePlayers.map(p => `${p.name}(ID:${p.id}, Stand:${p.isStand}, Points:${p.totalPoints})`).join(', ')}`)

    if (activePlayers.length === 0) {
      console.log('🏁 No hay jugadores activos, terminando el juego')
      const endResult = await this.endGame(gameId)
      const gameWithPlayers = await this.getGameWithPlayers(gameId)
      
      const { io } = await import('#start/socket')
      io.to(`game:${gameId}`).emit('chisme:gameFinished')
      return
    }

    // Encontrar el índice del jugador actual en la lista de jugadores activos
    const currentIndex = activePlayers.findIndex((p) => p.id === game.currentPlayerTurn)
    
    // Si el jugador actual no está en la lista de activos, comenzar desde el primero
    let nextIndex = 0
    if (currentIndex !== -1) {
      // Ir al siguiente jugador activo
      nextIndex = (currentIndex + 1) % activePlayers.length
    }

    const nextPlayer = activePlayers[nextIndex]
    console.log(`🎯 Turno cambiado a: ${nextPlayer.name} (ID: ${nextPlayer.id})`)

    game.currentPlayerTurn = nextPlayer.id
    await game.save()
  }

  private static async endGame(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players', (query) => {
        query.preload('cards')
      })
      .firstOrFail()

    game.status = 'finished'

    const players = game.players.filter((p) => !p.isHost)

    for (const player of players) {
    }

    const validPlayers = players.filter((p) => p.totalPoints <= 21)

    let winners: typeof players = []
    let gameResult = ''

    if (validPlayers.length === 0) {
      winners = []
      gameResult = 'Todos los jugadores se pasaron de 21 - No hay ganador'
    } else {
      const maxPoints = Math.max(...validPlayers.map((p) => p.totalPoints))
      winners = validPlayers.filter((p) => p.totalPoints === maxPoints)

      if (winners.length === 1) {
        gameResult = `Gana ${winners[0].name} con ${maxPoints} puntos`
      } else {
        const winnerNames = winners.map((w) => w.name).join(', ')
        gameResult = `Empate entre ${winnerNames} con ${maxPoints} puntos`
      }
    }

    if (winners.length === 1 && winners[0]) {
      game.winnerId = winners[0].userId // ✅ Usar userId en lugar de player.id
    } else {
      game.winnerId = null
    }

    await game.save()

    return { winners, gameResult }
  }

  // 🎯 NUEVO MÉTODO: Terminar juego con ganador específico (para cuando alguien llega a 21)
  private static async endGameWithWinner(gameId: number, winnerUserId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players', (query) => {
        query.preload('cards')
      })
      .firstOrFail()

    game.status = 'finished'
    game.winnerId = winnerUserId

    await game.save()

    const winnerPlayer = game.players.find((p) => p.userId === winnerUserId)
    const gameResult = winnerPlayer 
      ? `🎉 ¡${winnerPlayer.name} ganó con 21 puntos exactos!`
      : 'Juego terminado'

    console.log(`🏆 Juego ${gameId} terminado - Ganador: ${winnerPlayer?.name} (21 puntos)`)

    return { 
      winners: winnerPlayer ? [winnerPlayer] : [], 
      gameResult,
      instantWin: true,
      reason: 'blackjack_21'
    }
  }

  public static async restartGame(gameId: number, hostPlayerId: number) {
    const originalGame = await Game.query().where('id', gameId).preload('players').firstOrFail()

    const hostPlayer = originalGame.players.find((p) => p.id === hostPlayerId && p.isHost)
    if (!hostPlayer) {
      throw new Error('Solo el anfitrión puede reiniciar la partida')
    }

    // Crear una nueva baraja para el juego reiniciado
    const fullDeck = this.createFullDeck()

    const newGame = await Game.create({
      hostName: originalGame.hostName,
      status: 'waiting',
      maxPlayers: originalGame.maxPlayers,
      deck: JSON.stringify(fullDeck),
    })

    for (const player of originalGame.players) {
      await Player.create({
        gameId: newGame.id,
        userId: player.userId,
        name: player.name,
        isHost: player.isHost,
        totalPoints: 0,
        isStand: false,
      })
    }

    return newGame
  }

  public static async getGameWithPlayers(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players', (query) => {
        query.preload('cards')
      })
      .firstOrFail()

    for (const player of game.players) {
      const formattedCards = player.cards.map((playerCard) => playerCard.card)

      for (const playerCard of player.cards) {
        ;(playerCard as any).formatted = playerCard.card
      }

      ;(player as any).formattedCards = formattedCards
    }

    return game
  }

  public static async getAvailableGames() {
    const games = await Game.query()
      .where('status', 'waiting')
      .preload('players')
      .orderBy('created_at', 'desc')
    const availableGames = games.filter((game) => {
      const nonHostPlayers = game.players.filter((p) => !p.isHost).length
      return nonHostPlayers < game.maxPlayers
    })

    return availableGames
  }

  public static async dealCardToPlayer(hostPlayerId: number, targetPlayerId: number) {
    const hostPlayer = await Player.query()
      .where('id', hostPlayerId)
      .preload('game', (query) => {
        query.preload('players')
      })
      .firstOrFail()

    if (!hostPlayer.isHost) {
      throw new Error('Solo el anfitrión puede dar cartas')
    }

    const targetPlayer = hostPlayer.game.players.find((p) => p.id === targetPlayerId)
    if (!targetPlayer) {
      throw new Error('Jugador no encontrado')
    }

    if (targetPlayer.isStand) {
      throw new Error('El jugador ya está plantado y no puede recibir más cartas')
    }

    if (!targetPlayer.hasCardRequest) {
      throw new Error('El jugador no ha solicitado una carta')
    }

    // Verificar que sea el turno del jugador objetivo
    if (hostPlayer.game.currentPlayerTurn !== targetPlayerId) {
      throw new Error('No es el turno del jugador solicitante')
    }

    const result = await this.dealCard(targetPlayerId)

    return result
  }

  public static async stand(playerId: number) {
    return this.standPlayer(playerId)
  }

  public static async getGameStatus(gameId: number) {
    return this.getGameWithPlayers(gameId)
  }

  public static async getGameInfo(gameId: number) {
    return this.getGameWithPlayers(gameId)
  }

  public static async finishGame(gameId: number) {
    const endResult = await this.endGame(gameId)
    const gameWithPlayers = await this.getGameWithPlayers(gameId)
    
    return {
      game: gameWithPlayers,
      winners: endResult.winners,
      gameResult: endResult.gameResult,
      message: 'Partida finalizada'
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
    const isHost = player.isHost
    const wasCurrentPlayer = game.currentPlayerTurn === playerId
    const playersLeft = game.players.filter((p) => p.id !== player.id)

    console.log(`🚪 Jugador ${player.name} (ID: ${playerId}) saliendo del juego ${game.id}`);
    console.log(`🎯 ¿Tenía el turno?: ${wasCurrentPlayer}, Turno actual: ${game.currentPlayerTurn}`);
    console.log(`📊 Estado de la partida: ${game.status}`);

    // ✅ NUEVO: Si alguien abandona durante una partida activa, terminar automáticamente
    if (game.status === 'playing') {
      console.log('🛑 Partida activa - Alguien abandonó, terminando automáticamente para todos');
      game.status = 'finished'
      await game.save()
      await player.delete()

      return {
        message: isHost 
          ? 'Partida cancelada porque el anfitrión abandonó' 
          : 'Partida cancelada porque un jugador abandonó',
        gameEnded: true,
        reason: 'player_left_during_game'
      }
    }

    // Si el anfitrión se va antes de empezar, termina la partida
    if (isHost) {
      game.status = 'finished'
      await game.save()
      await player.delete()

      return {
        message: 'Partida cancelada porque el anfitrión se fue',
        gameEnded: true,
        reason: 'host_left'
      }
    }

    // Si no hay jugadores después de que se vaya alguien (en estado waiting)
    const nonHostPlayersLeft = playersLeft.filter((p) => !p.isHost)
    if (nonHostPlayersLeft.length === 0) {
      game.status = 'finished'
      await game.save()
      await player.delete()

      return {
        message: 'La partida se terminó porque ya no hay jugadores',
        gameEnded: true,
        reason: 'no_players_left'
      }
    }

    // Solo para partidas en estado 'waiting' - permitir salir sin terminar la partida
    await player.delete()

    return {
      message: 'Has salido de la partida',
      gameEnded: false,
    }
  }

  private static async handleTurnAfterPlayerLeft(gameId: number, leftPlayerId: number) {
    const game = await Game.query().where('id', gameId).preload('players').firstOrFail()
    
    const activePlayers = game.players.filter((p) => 
      !p.isHost && 
      !p.isStand && 
      p.totalPoints <= 21
    )

    console.log(`🔄 Jugadores activos restantes: ${activePlayers.length}`);
    
    if (activePlayers.length === 0) {
      console.log(`🏁 No hay jugadores activos, terminando juego ${gameId}`);
      await this.endGame(gameId)
      return
    }

    if (activePlayers.length === 1) {
      const nextPlayer = activePlayers[0]
      console.log(`👤 Solo queda un jugador activo: ${nextPlayer.name} (ID: ${nextPlayer.id})`);
      game.currentPlayerTurn = nextPlayer.id
      await game.save()
      return
    }

  
    const sortedActivePlayers = activePlayers.sort((a, b) => a.id - b.id)
    
    let nextPlayerIndex = sortedActivePlayers.findIndex(p => p.id > leftPlayerId)
    
    if (nextPlayerIndex === -1) {
      nextPlayerIndex = 0
    }
    
    const nextPlayer = sortedActivePlayers[nextPlayerIndex]
    console.log(`🎯 Siguiente jugador en turno: ${nextPlayer.name} (ID: ${nextPlayer.id})`);
    
    game.currentPlayerTurn = nextPlayer.id
    await game.save()
  }

  public static async revealAndFinish(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players', (query) => {
        query.preload('cards')
      })
      .firstOrFail()

    game.status = 'finished'

    const players = game.players.filter((p) => !p.isHost)

    const validPlayers = players.filter((p) => p.totalPoints <= 21)

    let winners: typeof players = []
    let gameResult = ''

    if (validPlayers.length === 0) {
      winners = []
      gameResult = 'Todos los jugadores se pasaron de 21 - No hay ganador'
    } else {
      const maxPoints = Math.max(...validPlayers.map((p) => p.totalPoints))
      winners = validPlayers.filter((p) => p.totalPoints === maxPoints)

      if (winners.length === 1) {
        gameResult = `Gana ${winners[0].name} con ${maxPoints} puntos`
      } else {
        const winnerNames = winners.map((w) => w.name).join(', ')
        gameResult = `Empate entre ${winnerNames} con ${maxPoints} puntos`
      }
    }

    if (winners.length === 1 && winners[0]) {
      game.winnerId = winners[0].userId // ✅ Usar userId en lugar de player.id
    } else {
      game.winnerId = null
    }

    await game.save()

    return {
      game,
      winners,
      gameResult,
      message: 'Partida finalizada y cartas reveladas',
    }
  }

  public static async proposeRematch(gameId: number, hostPlayerId: number) {
    const game = await Game.query().where('id', gameId).preload('players').firstOrFail()

    const hostPlayer = game.players.find((p) => p.id === hostPlayerId && p.isHost)
    if (!hostPlayer) {
      throw new Error('Solo el anfitrión puede proponer revancha')
    }

    if (game.status !== 'finished') {
      throw new Error('Solo se puede proponer revancha cuando el juego ha terminado')
    }

    if (game.rematchProposed) {
      throw new Error('Ya se ha propuesto una revancha para esta partida')
    }

    // Marcar la revancha como propuesta e inicializar respuestas
    const nonHostPlayers = game.players.filter((p) => !p.isHost)
    const initialResponses = nonHostPlayers.map(player => ({
      playerId: player.id,
      userId: player.userId,
      playerName: player.name,
      accepted: null, // null = no ha respondido, true = aceptó, false = rechazó
      respondedAt: null
    }))

    game.rematchProposed = true
    game.rematchResponses = initialResponses
    await game.save()

    return {
      message: 'Revancha propuesta - esperando respuestas de todos los jugadores',
      gameId: gameId,
      hostPlayer: {
        id: hostPlayer.id,
        name: hostPlayer.name,
        userId: hostPlayer.userId
      },
      playersToNotify: nonHostPlayers.map(p => ({
        id: p.id,
        name: p.name,
        userId: p.userId
      })),
      totalPlayersNeeded: nonHostPlayers.length,
      rematchRound: game.rematchRound
    }
  }

  public static async respondToRematch(gameId: number, playerId: number, accepted: boolean) {
    console.log(`🎯 respondToRematch: gameId=${gameId}, playerId=${playerId}, accepted=${accepted}`)
    
    const game = await Game.query().where('id', gameId).preload('players').firstOrFail()
    const player = await Player.findOrFail(playerId)

    console.log(`📊 Estado actual: rematchProposed=${game.rematchProposed}, status=${game.status}`)

    // ✅ VALIDACIÓN MEJORADA: Verificar estados válidos
    if (game.status === 'lobby_redirect') {
      throw new Error('La revancha ya fue rechazada y todos los jugadores fueron redirigidos al lobby')
    }

    if (!game.rematchProposed) {
      throw new Error('No hay una propuesta de revancha activa')
    }

    if (!game.rematchResponses || !Array.isArray(game.rematchResponses)) {
      throw new Error('Estado de revancha inválido')
    }

    // Buscar la respuesta del jugador
    const playerResponseIndex = game.rematchResponses.findIndex(
      (response: any) => response.playerId === playerId
    )

    if (playerResponseIndex === -1) {
      throw new Error('Jugador no encontrado en las respuestas de revancha')
    }

    // ✅ VALIDACIÓN: Evitar respuestas duplicadas
    const currentResponse = game.rematchResponses[playerResponseIndex]
    if (currentResponse.accepted !== null) {
      console.log(`⚠️ Jugador ${player.name} ya respondió: ${currentResponse.accepted}`)
      throw new Error(`Ya has respondido a esta revancha con: ${currentResponse.accepted ? 'Sí' : 'No'}`)
    }

    // Actualizar la respuesta del jugador
    game.rematchResponses[playerResponseIndex].accepted = accepted
    game.rematchResponses[playerResponseIndex].respondedAt = new Date().toISOString()

    console.log(`✅ Respuesta guardada para ${player.name}: ${accepted}`)

    if (!accepted) {
      // Si alguien rechaza, cancelar toda la revancha y terminar la partida completamente
      console.log(`❌ ${player.name} rechazó la revancha - Cancelando para todos`)
      
      game.rematchProposed = false
      game.rematchResponses = null
      game.status = 'lobby_redirect' // Nuevo estado para indicar que todos van al lobby
      await game.save()

      console.log(`🚪 Partida ${gameId} marcada para redirección al lobby`)

      return {
        message: 'Revancha rechazada - Todos los jugadores serán redirigidos al lobby',
        gameId,
        playerId,
        playerName: player.name,
        accepted: false,
        rematchCancelled: true,
        redirectToLobby: true, // Bandera para el frontend
        allPlayersGoToLobby: true
      }
    }

    // Si acepta, verificar si todos han aceptado
    const allAccepted = game.rematchResponses.every((response: any) => response.accepted === true)
    const allResponded = game.rematchResponses.every((response: any) => response.accepted !== null)

    console.log(`📋 Estado respuestas: allAccepted=${allAccepted}, allResponded=${allResponded}`)
    console.log(`📊 Respuestas actuales:`, game.rematchResponses.map((r: any) => `${r.playerName}: ${r.accepted}`).join(', '))

    await game.save()

    if (allAccepted && allResponded) {
      // ¡Todos aceptaron! Reiniciar la partida
      console.log(`🎉 ¡Todos aceptaron! Reiniciando partida ${gameId}`)
      await this.restartGameForRematch(gameId)

      return {
        message: 'Revancha aceptada - ¡Todos aceptaron! La partida se está reiniciando...',
        gameId,
        playerId,
        playerName: player.name,
        accepted: true,
        allPlayersAccepted: true,
        gameRestarting: true
      }
    }

    const remainingCount = game.rematchResponses.filter((r: any) => r.accepted === null).length
    console.log(`⏳ Esperando ${remainingCount} respuestas más`)

    return {
      message: 'Revancha aceptada - Esperando que otros jugadores respondan',
      gameId,
      playerId,
      playerName: player.name,
      accepted: true,
      waitingForOthers: true,
      responsesRemaining: remainingCount
    }
  }
  /**
   * Reinicia la misma partida cuando todos aceptaron la revancha
   * Limpia cartas, puntos, ganador y genera nueva baraja
   */
  private static async restartGameForRematch(gameId: number) {
    const game = await Game.query().where('id', gameId).preload('players').firstOrFail()
    
    console.log(`🔄 Reiniciando partida ${gameId} para revancha (Ronda ${game.rematchRound + 1})`)
    
    // Limpiar todas las cartas de todos los jugadores
    for (const player of game.players) {
      await PlayerCard.query().where('player_id', player.id).delete()
      
      // Resetear estadísticas del jugador (excepto host status)
      player.totalPoints = 0
      player.isStand = false
      player.hasCardRequest = false
      await player.save()
    }
    
    // Generar nueva baraja barajada
    const newDeck = this.createFullDeck()
    
    // Resetear estado del juego
    game.status = 'waiting'
    game.winnerId = null
    game.currentPlayerTurn = null
    game.deck = JSON.stringify(newDeck)
    game.rematchProposed = false
    game.rematchResponses = null
    game.rematchRound = (game.rematchRound || 1) + 1
    
    await game.save()
    
    console.log(`✅ Partida ${gameId} reiniciada exitosamente para Ronda ${game.rematchRound}`)
    
    return game
  }

  // ✅ NUEVO método: Solo crear la partida cuando TODOS hayan aceptado
  public static async createRematchIfAllAccepted(gameId: number, acceptedPlayerIds: number[]) {
    const originalGame = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    const hostPlayer = originalGame.players.find(p => p.isHost)
    if (!hostPlayer) {
      throw new Error('No se encontró el host de la partida original')
    }

    const originalNonHostPlayers = originalGame.players.filter(p => !p.isHost)
    
    // Verificar que TODOS los jugadores no-host hayan aceptado
    if (acceptedPlayerIds.length !== originalNonHostPlayers.length) {
      return {
        allAccepted: false,
        acceptedCount: acceptedPlayerIds.length,
        totalCount: originalNonHostPlayers.length,
        message: `Esperando más respuestas: ${acceptedPlayerIds.length}/${originalNonHostPlayers.length}`,
      }
    }

    // Verificar que todos los IDs de jugadores aceptados sean válidos
    const validPlayerIds = originalNonHostPlayers.map(p => p.id)
    const allValid = acceptedPlayerIds.every(id => validPlayerIds.includes(id))
    if (!allValid) {
      throw new Error('Algunos jugadores aceptados no pertenecen a la partida original')
    }

    // ✅ TODOS aceptaron - ahora sí crear la nueva partida
    console.log('🎉 TODOS los jugadores aceptaron la revancha - Creando nueva partida')
    
    // Crear una nueva baraja para la revancha
    const fullDeck = this.createFullDeck()

    const newGame = await Game.create({
      hostName: originalGame.hostName,
      status: 'waiting',
      maxPlayers: originalGame.maxPlayers,
      deck: JSON.stringify(fullDeck),
    })

    // Crear el host en la nueva partida
    const newHostPlayer = await Player.create({
      gameId: newGame.id,
      userId: hostPlayer.userId,
      name: hostPlayer.name,
      isHost: true,
      totalPoints: 0,
      isStand: false,
    })

    // Agregar todos los jugadores que aceptaron
    const acceptedPlayers = originalNonHostPlayers.filter(p => acceptedPlayerIds.includes(p.id))
    
    for (const originalPlayer of acceptedPlayers) {
      await Player.create({
        gameId: newGame.id,
        userId: originalPlayer.userId,
        name: originalPlayer.name,
        isHost: false,
        totalPoints: 0,
        isStand: false,
      })
    }

    // Recargar la partida con todos los jugadores
    const finalNewGame = await Game.query()
      .where('id', newGame.id)
      .preload('players', (query) => {
        query.preload('user')
      })
      .firstOrFail()

    return {
      allAccepted: true,
      newGameId: newGame.id,
      newGame: finalNewGame,
      message: 'Nueva partida creada - Todos los jugadores aceptaron la revancha',
      acceptedCount: acceptedPlayerIds.length,
      totalCount: originalNonHostPlayers.length,
    }
  }

  public static async createRematch(originalGameId: number, _acceptedPlayers: number[]) {
    const originalGame = await Game.query()
      .where('id', originalGameId)
      .preload('players')
      .firstOrFail()

    return {
      message: 'Usar proposeRematch en su lugar',
      originalGame,
    }
  }

  public static async listAvailableGames() {
    return this.getAvailableGames()
  }

  public static async getPlayersForRematch(gameId: number) {
    const game = await Game.query().where('id', gameId).preload('players').firstOrFail()

    if (game.status !== 'finished') {
      throw new Error('El juego debe estar terminado para obtener jugadores para revancha')
    }

    const players = game.players.filter((p) => !p.isHost)

    return {
      gameId,
      players: players.map((p) => ({
        id: p.id,
        userId: p.userId,
        name: p.name,
        totalPoints: p.totalPoints,
      })),
    }
  }

  public static async getPendingCardRequests(gameId: number) {
    const game = await Game.query().where('id', gameId).preload('players').firstOrFail()

    if (game.status !== 'playing') {
      return {
        gameId,
        pendingRequests: [],
        message: 'El juego no está en progreso',
      }
    }

    // Solo jugadores que no son host, tienen solicitud pendiente, no están plantados y no se han pasado de 21
    const playersWithRequests = game.players.filter((p) => 
      !p.isHost && 
      p.hasCardRequest === true && 
      !p.isStand && 
      p.totalPoints <= 21
    )

    return {
      gameId,
      pendingRequests: playersWithRequests.map((p) => ({
        playerId: p.id,
        playerName: p.name,
        totalPoints: p.totalPoints,
        isCurrentTurn: p.id === game.currentPlayerTurn,
        isStand: p.isStand,
      })),
      currentPlayerTurn: game.currentPlayerTurn,
      totalActivePlayers: game.players.filter(p => !p.isHost && !p.isStand && p.totalPoints <= 21).length,
    }
  }
}
