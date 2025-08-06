import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'games'

  async up() {
    // Modificar la columna status para incluir 'starting'
    this.schema.alterTable(this.tableName, (table) => {
      table.enum('status', ['waiting', 'starting', 'playing', 'finished']).defaultTo('waiting').alter()
    })
  }

  async down() {
    // Revertir a los valores originales
    this.schema.alterTable(this.tableName, (table) => {
      table.enum('status', ['waiting', 'playing', 'finished']).defaultTo('waiting').alter()
    })
  }
}