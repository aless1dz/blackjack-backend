import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'games'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Campos para manejar estado de revancha
      table.boolean('rematch_proposed').defaultTo(false)
      table.json('rematch_responses').nullable() // Almacena las respuestas de los jugadores
      table.integer('rematch_round').defaultTo(1) // Número de ronda/revancha
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('rematch_proposed')
      table.dropColumn('rematch_responses')
      table.dropColumn('rematch_round')
    })
  }
}
