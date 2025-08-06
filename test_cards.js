// Script de prueba para mostrar el diseño de cartas

function formatCardToSpanish(value, suit) {
  const valueNames = {
    'A': 'A',
    '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '10': '10',
    'J': 'J',
    'Q': 'Q', 
    'K': 'K'
  }

  const suitSymbols = {
    'hearts': '♥',
    'diamonds': '♦', 
    'clubs': '♣',
    'spades': '♠'
  }

  const suitEmojis = {
    'hearts': '❤️',
    'diamonds': '💎', 
    'clubs': '♣️',
    'spades': '♠️'
  }

  const displayValue = valueNames[value] || value
  const symbol = suitSymbols[suit] || '?'
  const emoji = suitEmojis[suit] || '❓'
  
  // Crear representación visual de carta
  const cardVisual = createCardVisual(displayValue, symbol)
  
  // Display simple con emoji para casos compactos
  const display = `${displayValue}${emoji}`

  return {
    value: displayValue,
    display,
    emoji,
    card: cardVisual
  }
}

function createCardVisual(value, symbol) {
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

// Ejemplos de cartas
console.log('🃏 EJEMPLOS DE CARTAS CON NUEVO DISEÑO:\n')

const examples = [
  ['A', 'spades'],
  ['K', 'hearts'], 
  ['Q', 'diamonds'],
  ['J', 'clubs'],
  ['10', 'hearts'],
  ['7', 'spades']
]

examples.forEach(([value, suit]) => {
  const card = formatCardToSpanish(value, suit)
  console.log(`${card.display} - ${suit}:`)
  console.log(card.card)
  console.log('')
})

console.log('✅ Las cartas ahora tienen un diseño realista como cartas físicas!')
