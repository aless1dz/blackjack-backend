import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AddWinnerIdToGames extends BaseSchema {
  protected tableName = 'games'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.integer('winner_id').unsigned().references('id').inTable('players').nullable().onDelete('SET NULL')
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('winner_id')
    })
  }
}
