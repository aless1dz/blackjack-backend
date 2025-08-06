import { execSync } from 'child_process';

console.log('🔍 Verificando si las cartas se están guardando en la base de datos...\n');

try {
  // Obtener información de juegos activos
  console.log('📊 JUEGOS EN LA BASE DE DATOS:');
  const gamesResult = execSync('mysql -u root -p -e "SELECT id, status, current_player_turn, max_players FROM blackjack_development.games ORDER BY created_at DESC LIMIT 5;"', { encoding: 'utf8' });
  console.log(gamesResult);

  console.log('\n👥 JUGADORES EN LA BASE DE DATOS:');
  const playersResult = execSync('mysql -u root -p -e "SELECT id, game_id, name, is_host, total_points, is_stand FROM blackjack_development.players ORDER BY created_at DESC LIMIT 10;"', { encoding: 'utf8' });
  console.log(playersResult);

  console.log('\n🃏 CARTAS EN LA BASE DE DATOS:');
  const cardsResult = execSync('mysql -u root -p -e "SELECT pc.id, pc.player_id, pc.card, p.name as player_name FROM blackjack_development.player_cards pc JOIN blackjack_development.players p ON pc.player_id = p.id ORDER BY pc.created_at DESC LIMIT 10;"', { encoding: 'utf8' });
  console.log(cardsResult);

} catch (error) {
  console.error('❌ Error al consultar la base de datos:');
  console.error('Asegúrate de que MySQL esté corriendo y que tengas acceso a la base de datos blackjack_development');
  console.error('Puedes probar manualmente con: mysql -u root -p');
}

console.log('\n💡 Si las cartas aparecen en la base de datos pero no en el frontend, el problema está en la respuesta del backend.');
console.log('💡 Si las cartas NO aparecen en la base de datos, el problema está en el método dealCard().');
