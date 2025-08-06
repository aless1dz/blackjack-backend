import Game from '../models/game.js'
import Player from '../models/player.js'
import PlayerCard from '../models/player_card.js'
import db from '@adonisjs/lucid/services/db'

export default class GameService {

  public static async createGame(user: any, maxPlayers: number = 4, hostName?: string) {
    const game = await Game.create({ 
      hostName: hostName || user.fullName || user.email,
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
    // Usar una transacción con timeout más corto para evitar condiciones de carrera
    try {
      const joinResult = await db.transaction(async (trx) => {
        // Configurar timeout de transacción a 10 segundos para auto-start
        await trx.raw('SET innodb_lock_wait_timeout = 10')
        
        const game = await Game.query({ client: trx })
        .where('id', gameId)
        .preload('players')
        .forUpdate() // Bloquear la fila para evitar condiciones de carrera
        .firstOrFail()

      console.log(`Attempting to join game ${gameId}:`)
      console.log(`Game status: ${game.status}`)
      console.log(`Max players: ${game.maxPlayers}`)
      console.log(`Current players: ${game.players.length}`)
      console.log(`Current non-host players: ${game.players.filter(p => !p.isHost).length}`)

      if (game.status !== 'waiting') {
        throw new Error('La partida ya ha comenzado')
      }

      // Verificar que el usuario no esté ya en la partida
      const existingPlayer = game.players.find(p => p.userId === user.id)
      if (existingPlayer) {
        throw new Error('Ya estás en esta partida')
      }

      // La lógica correcta: el host NO cuenta como jugador
      // Entonces si maxPlayers = 2, puede haber 1 host + 2 jugadores normales
      // Solo contamos los jugadores no-host
      const currentNonHostPlayers = game.players.filter(p => !p.isHost).length
      if (currentNonHostPlayers >= game.maxPlayers) {
        throw new Error(`La partida está llena. Máximo ${game.maxPlayers} jugadores (sin contar el anfitrión). Actualmente hay ${currentNonHostPlayers} jugadores.`)
      }

      // Doble verificación: contar solo jugadores NO-HOST directamente de la base de datos dentro de la transacción
      const currentPlayerCount = await Player.query({ client: trx })
        .where('gameId', gameId)
        .where('isHost', false)
        .count('* as total')
      
      const currentCount = Number((currentPlayerCount[0] as any).$extras.total)
      if (currentCount >= game.maxPlayers) {
        throw new Error(`La partida está llena. Máximo ${game.maxPlayers} jugadores (sin contar el anfitrión). Actualmente hay ${currentCount} jugadores.`)
      }

      const player = await Player.create({
        gameId: game.id,
        userId: user.id,
        name: user.fullName || user.email,
        isHost: false,
        totalPoints: 0,
        isStand: false
      }, { client: trx })

      console.log(`Player ${user.fullName || user.email} joined successfully`)

      // Verificar si la sala se llenó después de agregar el jugador
      const updatedGame = await Game.query({ client: trx })
        .where('id', gameId)
        .preload('players')
        .firstOrFail()

      const newNonHostPlayers = updatedGame.players.filter(p => !p.isHost).length
      console.log(`After joining - Non-host players: ${newNonHostPlayers}, Max players: ${updatedGame.maxPlayers}`)

      let autoStarted = false
      if (newNonHostPlayers === updatedGame.maxPlayers) {
        console.log(`🎯 ¡Sala llena! Auto-start activado para game ${gameId}`)
        // Cambiar el estado del juego pero NO auto-iniciar dentro de la transacción
        // Esto evita condiciones de carrera con múltiples jugadores uniéndose al mismo tiempo
        await Game.query({ client: trx })
          .where('id', gameId)
          .update({
            status: 'starting' // Estado intermedio para evitar más uniones
          })
        
        // Marcar que se debe auto-iniciar después de la transacción
        autoStarted = true
      }

      return { 
        player, 
        autoStarted,
        message: autoStarted ? 'Te uniste y la partida se iniciará automáticamente' : 'Te uniste exitosamente a la partida',
        gameStatus: autoStarted ? 'starting' : updatedGame.status,
        currentPlayers: updatedGame.players.length,
        maxPlayers: updatedGame.maxPlayers
      }
    }) // Cierre correcto del transaction

    // Si se debe auto-iniciar, hacerlo DESPUÉS de que la transacción se complete
    if (joinResult.autoStarted) {
      console.log(`⏰ Programando auto-start para game ${gameId} en 1 segundo...`)
      setTimeout(async () => {
        try {
          console.log(`⚡ Ejecutando auto-start para game ${gameId}...`)
          await this.performAutoStart(gameId)
          console.log(`🎊 Auto-start completado exitosamente para game ${gameId}`)
        } catch (error) {
          console.error(`💥 Auto-start falló para game ${gameId}:`, error)
          // No es crítico si el auto-start falla, el juego puede iniciarse manualmente
        }
      }, 1000) // Retraso de 1 segundo para asegurar que la transacción se complete
    }

    return joinResult
  } catch (error: any) {
    // Manejar errores específicos de base de datos
    if (error.message?.includes('Lock wait timeout exceeded')) {
      throw new Error('Servicio temporalmente no disponible. Inténtalo de nuevo.', { cause: { retry: true } })
    }
    
    // Re-lanzar otros errores tal como están
    throw error
  }
}

  // Función separada para manejar el auto-start sin parámetros de host
  public static async performAutoStart(gameId: number) {
    console.log(`🚀 INICIANDO performAutoStart para game ${gameId}`)
    
    return await db.transaction(async (trx) => {
      // Usar timeout más corto para auto-start para evitar deadlocks
      await trx.raw('SET innodb_lock_wait_timeout = 3')
      
      const game = await Game.query({ client: trx })
        .where('id', gameId)
        .preload('players')
        .forUpdate()
        .firstOrFail()

      console.log(`🎮 Auto-start para game ${gameId}`)
      console.log(`📊 Estado del juego: ${game.status}`)
      console.log(`👥 Jugadores: ${game.players.length}`)

      if (game.status !== 'starting') {
        console.log('⚠️ Juego no está en estado starting, auto-start cancelado')
        return game
      }

      // Verificar nuevamente que tenemos jugadores suficientes
      const nonHostPlayers = game.players.filter(p => !p.isHost)
      console.log(`🎯 Jugadores no-host: ${nonHostPlayers.length}/${game.maxPlayers}`)
      
      if (nonHostPlayers.length < game.maxPlayers) {
        console.log('⚠️ No hay suficientes jugadores para auto-start, cancelando')
        await Game.query({ client: trx })
          .where('id', gameId)
          .update({ status: 'waiting' })
        return game
      }

      console.log('🃏 Repartiendo cartas iniciales...')
      // Repartir cartas iniciales: 1 carta SOLO a los jugadores (NO al host/dealer)
      const playersOnly = game.players.filter(p => !p.isHost)
      
      for (const gamePlayer of playersOnly) {
        console.log(`🎴 Repartiendo carta a jugador ${gamePlayer.id} (${gamePlayer.name})`)
        await this.dealCard(gamePlayer.id, trx, true) // skipTurnLogic = true durante auto-start
      }

      // El anfitrión (dealer) NO recibe cartas al inicio, solo reparte
      console.log('🎯 Estableciendo turno del primer jugador...')

      // Establecer el turno del primer jugador (que no sea host)
      const firstPlayer = game.players.find(p => !p.isHost)
      if (!firstPlayer) {
        throw new Error('No hay jugadores válidos para iniciar el juego')
      }
      
      console.log(`🎮 Cambiando estado a 'playing' y turno a jugador ${firstPlayer.id}`)
      await Game.query({ client: trx })
        .where('id', gameId)
        .update({
          status: 'playing',
          currentPlayerTurn: firstPlayer.id,
          updatedAt: new Date()
        })
      
      console.log('✅ Auto-start completado exitosamente')
      
      // Recargar el juego con las cartas actualizadas
      const updatedGame = await Game.query({ client: trx })
        .where('id', gameId)
        .preload('players', (query) => {
          query.preload('cards')
        })
        .firstOrFail()
      
      console.log(`🎉 Juego actualizado - Estado: ${updatedGame.status}, Cartas totales: ${updatedGame.players.reduce((total, p) => total + p.cards.length, 0)}`)
      
      return updatedGame
    })
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
      throw new Error('La partida ya ha comenzado')
    }

    if (game.players.length < 2) {
      throw new Error('Se necesitan al menos 2 jugadores para iniciar la partida')
    }

    // Cambiar estado del juego
    game.status = 'playing'
    
    // Repartir cartas iniciales: 1 carta SOLO a los jugadores (NO al host/dealer)
    const playersOnly = game.players.filter(p => !p.isHost)
    for (const player of playersOnly) {
      await this.dealCard(player.id, undefined, true) // skipTurnLogic = true durante inicio manual también
    }

    // El anfitrión (dealer) NO recibe cartas al inicio, solo reparte

    // Establecer el turno del primer jugador (que no sea host)
    const firstPlayer = game.players.find(p => !p.isHost)
    if (!firstPlayer) {
      throw new Error('No hay jugadores válidos para iniciar el juego')
    }
    game.currentPlayerTurn = firstPlayer.id
    
    await game.save()

    // Devolver el juego completo con cartas formateadas
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
    console.log(`🎲 dealCard iniciado para jugador ${playerId}, transacción: ${trx ? 'SÍ' : 'NO'}, skipTurnLogic: ${skipTurnLogic}`)
    
    // Generar una carta aleatoria
    const suits = ['hearts', 'diamonds', 'clubs', 'spades']
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
    
    const suit = suits[Math.floor(Math.random() * suits.length)]
    const value = values[Math.floor(Math.random() * values.length)]
    const card = `${value}_${suit}` // Formato interno: "A_hearts", "K_spades", etc.

    console.log(`🃏 Carta generada: ${card} para jugador ${playerId}`)

    // Crear la carta del jugador
    const playerCard = await PlayerCard.create({
      playerId,
      card
    }, trx ? { client: trx } : {})

    console.log(`💾 Carta guardada en BD con ID: ${playerCard.id}`)

    // Actualizar los puntos del jugador
    const player = await Player.query(trx ? { client: trx } : {})
      .where('id', playerId)
      .preload('cards')
      .firstOrFail()

    console.log(`👤 Jugador cargado: ${player.name}, cartas actuales: ${player.cards.length}`)

    // Calcular puntos de todas las cartas del jugador
    // NO agregar playerCard porque ya está incluido en player.cards
    let totalPoints = 0
    let aces = 0
    
    console.log(`🧮 Calculando puntos para ${player.cards.length} cartas:`)
    
    for (const cardItem of player.cards) {
      const [cardValue] = cardItem.card.split('_') // Extraer valor de "A_hearts"
      let cardPoints = 0
      
      console.log(`   Procesando carta: ${cardItem.card}`)
      console.log(`   Valor extraído: "${cardValue}"`)
      
      if (cardValue === 'A') {
        aces++
        cardPoints = 11 // Inicialmente contar As como 11
      } else if (['J', 'Q', 'K'].includes(cardValue)) {
        cardPoints = 10
      } else {
        cardPoints = parseInt(cardValue)
        if (isNaN(cardPoints)) {
          console.error(`❌ Error: No se pudo parsear el valor "${cardValue}" de la carta ${cardItem.card}`)
          cardPoints = 0
        }
      }
      
      console.log(`   ${cardItem.card} = ${cardPoints} puntos`)
      totalPoints += cardPoints
    }
    
    // Ajustar los Ases si es necesario
    while (totalPoints > 21 && aces > 0) {
      totalPoints -= 10 // Cambiar un As de 11 a 1
      aces--
    }

    console.log(`📊 Puntos calculados: ${totalPoints} para jugador ${playerId}`)

    player.totalPoints = totalPoints
    
    // Limpiar la solicitud de carta si existe
    player.hasCardRequest = false
    
    // Si se pasa de 21, se planta automáticamente
    if (totalPoints > 21) {
      player.isStand = true
      console.log(`🚫 Jugador ${playerId} se pasó (${totalPoints} > 21), plantado automáticamente`)
    }
    // Si obtiene exactamente 21 (blackjack), se planta automáticamente
    else if (totalPoints === 21) {
      player.isStand = true
      console.log(`🎉 ¡Blackjack! Jugador ${playerId} obtuvo 21, plantado automáticamente`)
    }
    
    if (trx) {
      player.useTransaction(trx)
    }
    await player.save()
    
    console.log(`💾 Jugador ${playerId} guardado con ${totalPoints} puntos`)

    // Solo manejar lógica de turnos si NO estamos en auto-start
    if (!skipTurnLogic) {
      console.log(`🎯 Verificando estado del juego para posibles turnos...`)

      // Verificar si todos los jugadores (NO HOST) se han plantado o pasado de 21
      const remainingPlayers = await Player.query(trx ? { client: trx } : {}).where('game_id', player.gameId)
        .where('is_host', false) // Solo considerar jugadores, no el host
        .where('is_stand', false)
        .where('total_points', '<=', 21)

      console.log(`🎮 Jugadores restantes activos: ${remainingPlayers.length}`)

      if (remainingPlayers.length === 0) {
        console.log(`🏁 No quedan jugadores activos, terminando juego...`)
        // Terminar el juego cuando todos los jugadores han terminado
        await this.endGame(player.gameId)
      } else {
        console.log(`⏭️ Pasando al siguiente turno...`)
        // Pasar al siguiente jugador (solo entre jugadores, no el host)
        await this.nextTurn(player.gameId)
      }
    } else {
      console.log(`⏭️ Saltando lógica de turnos (auto-start en progreso)`)
    }

    // Convertir carta a formato legible en español
    const cardDisplay = this.formatCardToSpanish(value, suit)
    
    console.log(`✅ dealCard completado para jugador ${playerId}: ${cardDisplay.display}`)

    return { totalPoints, card: cardDisplay, cardRaw: card }
  }

  // Método para convertir cartas a formato visual realista
  private static formatCardToSpanish(value: string, suit: string): { value: string, suit: string, display: string, emoji: string, card: string } {
    const valueNames: { [key: string]: string } = {
      'A': 'A',
      '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '10': '10',
      'J': 'J',
      'Q': 'Q', 
      'K': 'K'
    }

    const suitSymbols: { [key: string]: string } = {
      'hearts': '♥',
      'diamonds': '♦', 
      'clubs': '♣',
      'spades': '♠'
    }

    const suitEmojis: { [key: string]: string } = {
      'hearts': '❤️',
      'diamonds': '💎', 
      'clubs': '♣️',
      'spades': '♠️'
    }

    const suitNames: { [key: string]: string } = {
      'hearts': 'Corazones',
      'diamonds': 'Diamantes', 
      'clubs': 'Tréboles',
      'spades': 'Espadas'
    }

    const displayValue = valueNames[value] || value
    const symbol = suitSymbols[suit] || '?'
    const emoji = suitEmojis[suit] || '❓'
    const suitName = suitNames[suit] || suit

    // Crear representación visual de carta
    const cardVisual = this.createCardVisual(displayValue, symbol)
    
    // Display simple con emoji para casos compactos
    const display = `${displayValue}${emoji}`

    return {
      value: displayValue,
      suit: suitName,
      display,
      emoji,
      card: cardVisual
    }
  }

  // Método para crear la representación visual ASCII de la carta
  private static createCardVisual(value: string, symbol: string): string {
    // Ajustar el espaciado dependiendo del valor
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
    const player = await Player.query()
      .where('id', playerId)
      .preload('game')
      .firstOrFail()

    if (player.game.status !== 'playing') {
      throw new Error('El juego no está en progreso')
    }

    if (player.game.currentPlayerTurn !== playerId) {
      throw new Error('No es tu turno')
    }

    player.isStand = true
    await player.save()

    // Verificar si todos los jugadores (NO HOST) se han plantado
    const remainingPlayers = await Player.query()
      .where('game_id', player.gameId)
      .where('is_host', false) // Solo considerar jugadores, no el host
      .where('is_stand', false)

    if (remainingPlayers.length === 0) {
      // Terminar el juego cuando todos los jugadores han terminado
      await this.endGame(player.gameId)
    } else {
      // Pasar al siguiente jugador (solo entre jugadores, no el host)
      await this.nextTurn(player.gameId)
    }

    // Devolver el estado completo del juego
    const gameState = await this.getGameWithPlayers(player.gameId)
    return { success: true, game: gameState }
  }

  private static async nextTurn(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    // Solo considerar jugadores activos (NO HOST)
    const activePlayers = game.players.filter(p => !p.isHost && !p.isStand && p.totalPoints <= 21)
    
    if (activePlayers.length === 0) {
      await this.endGame(gameId)
      return
    }

    const currentIndex = activePlayers.findIndex(p => p.id === game.currentPlayerTurn)
    const nextIndex = (currentIndex + 1) % activePlayers.length
    
    game.currentPlayerTurn = activePlayers[nextIndex].id
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

    // Solo considerar jugadores (NO al host/dealer) para determinar ganador
    const players = game.players.filter(p => !p.isHost)
    
    console.log('🏆 Determinando ganador...')
    console.log(`📊 Jugadores en el juego: ${players.length}`)
    
    for (const player of players) {
      console.log(`🎯 ${player.name}: ${player.totalPoints} puntos, plantado: ${player.isStand}`)
    }
    
    // Jugadores válidos (que no se pasaron de 21)
    const validPlayers = players.filter(p => p.totalPoints <= 21)
    
    console.log(`✅ Jugadores válidos (≤21): ${validPlayers.length}`)
    
    let winners: typeof players = []
    let gameResult = ''
    
    if (validPlayers.length === 0) {
      // Todos los jugadores se pasaron, no hay ganador
      winners = []
      gameResult = 'Todos los jugadores se pasaron de 21 - No hay ganador'
      console.log('❌ Todos los jugadores se pasaron de 21')
    } else {
      // Encontrar el puntaje más alto entre los jugadores válidos
      const maxPoints = Math.max(...validPlayers.map(p => p.totalPoints))
      winners = validPlayers.filter(p => p.totalPoints === maxPoints)
      
      console.log(`🎯 Puntaje más alto: ${maxPoints}`)
      console.log(`🏆 Ganadores potenciales: ${winners.map(w => `${w.name}(${w.totalPoints})`).join(', ')}`)
      
      if (winners.length === 1) {
        gameResult = `Gana ${winners[0].name} con ${maxPoints} puntos`
        console.log(`🎉 Ganador único: ${winners[0].name} con ${maxPoints} puntos`)
      } else {
        const winnerNames = winners.map(w => w.name).join(', ')
        gameResult = `Empate entre ${winnerNames} con ${maxPoints} puntos`
        console.log(`🤝 Empate entre: ${winnerNames} con ${maxPoints} puntos`)
      }
    }

    // Guardar el ganador en la base de datos (si hay un solo ganador)
    if (winners.length === 1 && winners[0]) {
      game.winnerId = winners[0].id
      console.log(`💾 Guardando winnerId: ${winners[0].id}`)
    } else {
      // En caso de empate o no hay ganador, dejamos null
      game.winnerId = null
      console.log(`💾 Guardando winnerId: null (empate o sin ganador)`)
    }

    await game.save()
    console.log(`📋 Resultado final: ${gameResult}`)

    return { winners, gameResult }
  }

  public static async restartGame(gameId: number, hostPlayerId: number) {
    // Verificar que el juego original existe y que el host es válido
    const originalGame = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    const hostPlayer = originalGame.players.find(p => p.id === hostPlayerId && p.isHost)
    if (!hostPlayer) {
      throw new Error('Solo el anfitrión puede reiniciar la partida')
    }

    // Crear un nuevo juego con la misma configuración
    const newGame = await Game.create({
      hostName: originalGame.hostName,
      status: 'waiting',
      maxPlayers: originalGame.maxPlayers
    })

    // Crear jugadores para el nuevo juego manteniendo los mismos usuarios
    for (const player of originalGame.players) {
      await Player.create({
        gameId: newGame.id,
        userId: player.userId,
        name: player.name,
        isHost: player.isHost,
        totalPoints: 0,
        isStand: false
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

    // Formatear las cartas de todos los jugadores para mostrar en español
    for (const player of game.players) {
      // Agregar las cartas formateadas directamente al jugador
      const formattedCards = []
      
      for (const playerCard of player.cards) {
        const [value, suit] = playerCard.card.split('_')
        const formattedCard = this.formatCardToSpanish(value, suit)
        
        // Agregar la información formateada como propiedad adicional a la carta
        ;(playerCard as any).formatted = formattedCard
        
        // También agregar al array de cartas formateadas del jugador
        formattedCards.push(formattedCard)
      }
      
      // Agregar array de cartas formateadas al jugador
      ;(player as any).formattedCards = formattedCards
    }

    return game
  }

  public static async getAvailableGames() {
    const games = await Game.query()
      .where('status', 'waiting')
      .preload('players')
      .orderBy('created_at', 'desc')

    // Filtrar juegos que no estén llenos (sin contar el host)
    const availableGames = games.filter(game => {
      const nonHostPlayers = game.players.filter(p => !p.isHost).length
      return nonHostPlayers < game.maxPlayers
    })

    return availableGames
  }

  public static async dealCardToPlayer(hostPlayerId: number, targetPlayerId: number) {
    // Verificar que el host es válido
    const hostPlayer = await Player.query()
      .where('id', hostPlayerId)
      .preload('game', (query) => {
        query.preload('players')
      })
      .firstOrFail()

    if (!hostPlayer.isHost) {
      throw new Error('Solo el anfitrión puede dar cartas')
    }

    // Verificar que el jugador objetivo existe y tiene una solicitud pendiente
    const targetPlayer = hostPlayer.game.players.find(p => p.id === targetPlayerId)
    if (!targetPlayer) {
      throw new Error('Jugador no encontrado')
    }

    if (!targetPlayer.hasCardRequest) {
      throw new Error('El jugador no ha solicitado una carta')
    }

    // Dar la carta
    const result = await this.dealCard(targetPlayerId)

    return result
  }

  // Métodos adicionales para el controller
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
    return this.endGame(gameId)
  }

  public static async leaveGame(playerId: number) {
    const player = await Player.query()
      .where('id', playerId)
      .preload('game', (query) => {
        query.preload('players')
      })
      .firstOrFail()

    const game = player.game

    // Si el juego está en progreso, terminarlo automáticamente
    if (game.status === 'playing') {
      game.status = 'finished'
      await game.save()
      
      // Eliminar el jugador después de terminar el juego
      await player.delete()
      
      return { 
        message: 'Has salido de la partida. La partida se ha terminado automáticamente.',
        gameEnded: true
      }
    }

    // Eliminar el jugador
    await player.delete()

    // Si era el host, cancelar el juego
    if (player.isHost) {
      game.status = 'finished'
      await game.save()
      return { 
        message: 'Partida cancelada porque el anfitrión se fue',
        gameEnded: true
      }
    }

    return { 
      message: 'Has salido de la partida',
      gameEnded: false
    }
  }

  public static async revealAndFinish(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players', (query) => {
        query.preload('cards')
      })
      .firstOrFail()

    game.status = 'finished'

    // Solo considerar jugadores (NO al host/dealer) para determinar ganador
    const players = game.players.filter(p => !p.isHost)
    
    // Jugadores válidos (que no se pasaron de 21)
    const validPlayers = players.filter(p => p.totalPoints <= 21)
    
    let winners: typeof players = []
    let gameResult = ''
    
    if (validPlayers.length === 0) {
      // Todos los jugadores se pasaron, no hay ganador
      winners = []
      gameResult = 'Todos los jugadores se pasaron de 21 - No hay ganador'
    } else {
      // Encontrar el puntaje más alto entre los jugadores válidos
      const maxPoints = Math.max(...validPlayers.map(p => p.totalPoints))
      winners = validPlayers.filter(p => p.totalPoints === maxPoints)
      
      if (winners.length === 1) {
        gameResult = `Gana ${winners[0].name} con ${maxPoints} puntos`
      } else {
        const winnerNames = winners.map(w => w.name).join(', ')
        gameResult = `Empate entre ${winnerNames} con ${maxPoints} puntos`
      }
    }

    // Guardar el ganador en la base de datos (si hay un solo ganador)
    if (winners.length === 1 && winners[0]) {
      game.winnerId = winners[0].id
    } else {
      // En caso de empate o no hay ganador, dejamos null
      game.winnerId = null
    }

    await game.save()

    return { 
      game,
      winners,
      gameResult,
      message: 'Partida finalizada y cartas reveladas' 
    }
  }

  public static async proposeRematch(gameId: number, hostPlayerId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    const hostPlayer = game.players.find(p => p.id === hostPlayerId && p.isHost)
    if (!hostPlayer) {
      throw new Error('Solo el anfitrión puede proponer revancha')
    }

    if (game.status !== 'finished') {
      throw new Error('Solo se puede proponer revancha cuando el juego ha terminado')
    }

    // Crear nueva partida inmediatamente con la misma configuración
    const newGame = await Game.create({
      hostName: game.hostName,
      status: 'waiting',
      maxPlayers: game.maxPlayers
    })

    // Agregar solo al host inicialmente
    const newHostPlayer = await Player.create({
      gameId: newGame.id,
      userId: hostPlayer.userId,
      name: hostPlayer.name,
      isHost: true,
      totalPoints: 0,
      isStand: false
    })

    return { 
      message: 'Nueva partida creada para revancha',
      originalGameId: gameId,
      newGameId: newGame.id,
      newGame: await Game.query()
        .where('id', newGame.id)
        .preload('players')
        .firstOrFail(),
      playersToNotify: game.players.filter(p => !p.isHost), // Solo notificar a los jugadores, no al host
      rematchInfo: {
        hostPlayer: newHostPlayer,
        maxPlayers: newGame.maxPlayers,
        waitingForPlayers: true
      }
    }
  }

  public static async respondToRematch(gameId: number, playerId: number, accepted: boolean) {
    // Este método ahora es más simple - solo confirma la respuesta
    // La nueva partida ya fue creada en proposeRematch
    await Player.findOrFail(playerId) // Validar que el jugador existe
    
    return { 
      message: accepted ? 'Revancha aceptada - Puedes unirte a la nueva partida' : 'Revancha rechazada',
      gameId,
      playerId,
      accepted
    }
  }

  // Método simplificado - ya no es necesario crear la revancha aquí
  public static async createRematch(originalGameId: number, _acceptedPlayers: number[]) {
    // Este método se mantiene por compatibilidad pero la lógica principal está en proposeRematch
    const originalGame = await Game.query()
      .where('id', originalGameId)
      .preload('players')
      .firstOrFail()

    return { 
      message: 'Usar proposeRematch en su lugar',
      originalGame
    }
  }

  public static async listAvailableGames() {
    return this.getAvailableGames()
  }

  // Nuevo método para obtener jugadores que pueden ser invitados a revancha
  public static async getPlayersForRematch(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    if (game.status !== 'finished') {
      throw new Error('El juego debe estar terminado para obtener jugadores para revancha')
    }

    // Retornar solo los jugadores (no el host) con información para notificarles
    const players = game.players.filter(p => !p.isHost)
    
    return {
      gameId,
      players: players.map(p => ({
        id: p.id,
        userId: p.userId,
        name: p.name,
        totalPoints: p.totalPoints
      }))
    }
  }

  // Nuevo método para obtener solo las solicitudes de cartas pendientes
  public static async getPendingCardRequests(gameId: number) {
    const game = await Game.query()
      .where('id', gameId)
      .preload('players')
      .firstOrFail()

    if (game.status !== 'playing') {
      return {
        gameId,
        pendingRequests: [],
        message: 'El juego no está en progreso'
      }
    }

    // Obtener solo jugadores con solicitudes pendientes
    const playersWithRequests = game.players.filter(p => 
      !p.isHost && p.hasCardRequest === true
    )

    return {
      gameId,
      pendingRequests: playersWithRequests.map(p => ({
        playerId: p.id,
        playerName: p.name,
        totalPoints: p.totalPoints,
        isCurrentTurn: p.id === game.currentPlayerTurn
      })),
      currentPlayerTurn: game.currentPlayerTurn
    }
  }
}
