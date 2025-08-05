import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'games'

  public async up() {
  this.schema.createTable(this.tableName, (table) => {
    table.increments('id')
    table.string('host_name').notNullable()
    table.enum('status', ['waiting', 'playing', 'finished']).defaultTo('waiting')
    table.timestamp('created_at', { useTz: true }).defaultTo(this.now())
    table.timestamp('updated_at', { useTz: true }).defaultTo(this.now())
  })
}

  async down() {
    this.schema.dropTable(this.tableName)
  }
}