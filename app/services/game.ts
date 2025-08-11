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
    
    // Mezclar la baraja usando el algoritmo Fisher-Yates
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[deck[i], deck[j]] = [deck[j], deck[i]]
    }
    
    return deck
  }
  
  // Obtener una carta de la baraja del juego
  private static async drawCardFromDeck(gameId: number, trx?: any): Promise<{ cardKey: string; formattedCard: string }> {
    const game = await Game.query(trx ? { client: trx } : {})
      .where('id', gameId)
      .firstOrFail()
    
    if (!game.deck) {
      throw new Error('No hay baraja en el juego')
    }
    
    // Deserializar la baraja
    let currentDeck: string[]
    try {
      currentDeck = JSON.parse(game.deck)
    } catch (error) {
      throw new Error('Error al leer la baraja del juego')
    }
    
    if (currentDeck.length === 0) {
      throw new Error('No hay más cartas en la baraja')
    }
    
    // Tomar la primera carta de la baraja
    const cardKey = currentDeck.shift()!
    
    // Actualizar la baraja en la base de datos
    const updatedDeckJson = JSON.stringify(currentDeck)
    if (trx) {
      await Game.query({ client: trx }).where('id', gameId).update({ deck: updatedDeckJson })
    } else {
      game.deck = updatedDeckJson
      await game.save()
    }
    
    // Convertir la clave de carta a formato visual
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
    // ✅ Validar límites de jugadores: mínimo 3, máximo 6 (sin contar host)
    if (maxPlayers < 3) {
      throw new Error('Se necesitan mínimo 3 jugadores además del host (4 jugadores total)')
    }
    if (maxPlayers > 6) {
      throw new Error('Máximo 6 jugadores además del host (7 jugadores total)')
    }
    
    // Crear la baraja completa de 52 cartas
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
      io.to(`game:${gameId}`).emit('chisme:gameStarted', { game: result })
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

    // Obtener una carta de la baraja del juego
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

    // Verificar si el jugador se planta automáticamente
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

    // Lógica de turnos
    if (!skipTurnLogic) {
      const remainingPlayers = await Player.query(trx ? { client: trx } : {})
        .where('game_id', player.gameId)
        .where('is_host', false) // Solo considerar jugadores, no el host
        .where('is_stand', false)
        .where('total_points', '<=', 21)

      if (remainingPlayers.length === 0) {
        const endResult = await this.endGame(player.gameId)
        const gameWithPlayers = await this.getGameWithPlayers(player.gameId)
        
        // ✅ Emitir evento cuando el juego termina automáticamente
        console.log('🔍 DEBUG AUTO FINISH - Enviando evento chisme:gameFinished:')
        console.log('  - gameId:', player.gameId)
        console.log('  - winners:', endResult.winners)
        console.log('  - gameResult:', endResult.gameResult)
        console.log('  - winnerId en BD:', gameWithPlayers.winnerId)
        
        const eventData = {
          game: gameWithPlayers,
          winners: endResult.winners,
          gameResult: endResult.gameResult,
          message: 'Partida terminada automáticamente'
        }
        
        const { io } = await import('#start/socket')
        io.to(`game:${player.gameId}`).emit('chisme:gameFinished', eventData)
        console.log('📡 Evento AUTO FINISH emitido:', eventData)
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
      
      // ✅ Emitir evento cuando el juego termina automáticamente por stand
      const { io } = await import('#start/socket')
      io.to(`game:${player.gameId}`).emit('chisme:gameFinished', { 
        game: gameWithPlayers,
        winners: endResult.winners,
        gameResult: endResult.gameResult,
        message: 'Partida terminada - Todos los jugadores se plantaron'
      })
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
      
      // ✅ Emitir evento cuando el juego termina desde nextTurn
      const { io } = await import('#start/socket')
      io.to(`game:${gameId}`).emit('chisme:gameFinished', { 
        game: gameWithPlayers,
        winners: endResult.winners,
        gameResult: endResult.gameResult,
        message: 'Partida terminada - No hay más jugadores activos'
      })
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

    // Crear una nueva baraja para la revancha
    const fullDeck = this.createFullDeck()

    const newGame = await Game.create({
      hostName: game.hostName,
      status: 'waiting',
      maxPlayers: game.maxPlayers,
      deck: JSON.stringify(fullDeck),
    })

    const newHostPlayer = await Player.create({
      gameId: newGame.id,
      userId: hostPlayer.userId,
      name: hostPlayer.name,
      isHost: true,
      totalPoints: 0,
      isStand: false,
    })

    return {
      message: 'Nueva partida creada para revancha',
      originalGameId: gameId,
      newGameId: newGame.id,
      newGame: await Game.query().where('id', newGame.id).preload('players').firstOrFail(),
      playersToNotify: game.players.filter((p) => !p.isHost),
      rematchInfo: {
        hostPlayer: newHostPlayer,
        maxPlayers: newGame.maxPlayers,
        waitingForPlayers: true,
      },
    }
  }

  public static async respondToRematch(gameId: number, playerId: number, accepted: boolean) {
    const player = await Player.findOrFail(playerId)
    const originalGame = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    if (!accepted) {
      return {
        message: 'Revancha rechazada',
        gameId,
        playerId,
        accepted: false,
      }
    }

    // Si acepta, intentar encontrar si ya existe una partida de revancha activa
    const hostPlayer = originalGame.players.find(p => p.isHost)
    if (!hostPlayer) {
      throw new Error('No se encontró el host de la partida original')
    }

    // Buscar partida de revancha activa creada por este host
    const rematchGame = await Game.query()
      .where('status', 'waiting')
      .whereHas('players', (query) => {
        query.where('user_id', hostPlayer.userId).where('is_host', true)
      })
      .preload('players', (query) => {
        query.preload('user')
      })
      .orderBy('created_at', 'desc')
      .first()

    if (rematchGame) {
      // Verificar si el jugador ya está en la partida de revancha
      const existingPlayer = rematchGame.players.find(p => p.userId === player.userId)
      
      if (!existingPlayer) {
        // Agregar el jugador a la partida de revancha
        console.log(`🔄 ANTES de agregar: Jugadores en revancha ${rematchGame.id}: ${rematchGame.players.length}`)
        console.log(`🔄 Agregando jugador ${player.name} (userID: ${player.userId}) a revancha`)
        
        const newPlayer = await Player.create({
          gameId: rematchGame.id,
          userId: player.userId,
          name: player.name,
          isHost: false,
          totalPoints: 0,
          isStand: false,
        })

        console.log(`✅ Jugador ${player.name} (ID: ${newPlayer.id}) unido a partida de revancha ${rematchGame.id}`)
        
        // Recargar la partida de revancha con todos los jugadores
        const updatedRematchGame = await Game.query()
          .where('id', rematchGame.id)
          .preload('players', (query) => {
            query.preload('user')
          })
          .firstOrFail()

        return {
          message: 'Revancha aceptada - Te has unido a la nueva partida',
          gameId,
          playerId,
          playerName: player.name,
          accepted: true,
          newGameId: rematchGame.id,
          newGame: updatedRematchGame,
        }
      } else {
        return {
          message: 'Revancha aceptada - Ya estás en la partida',
          gameId,
          playerId,
          playerName: player.name,
          accepted: true,
          newGameId: rematchGame.id,
          newGame: rematchGame,
        }
      }
    } else {
      throw new Error('No se encontró una partida de revancha activa')
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
