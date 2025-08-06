import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, belongsTo } from '@adonisjs/lucid/orm'
import type { HasMany, BelongsTo } from '@adonisjs/lucid/types/relations'
import Player from './player.js'

export default class Game extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare hostName: string

  @column()
  declare status: 'waiting' | 'starting' | 'playing' | 'finished'

  @column()
  declare maxPlayers: number

  @column()
  declare currentPlayerTurn: number | null

  @column()
  declare winnerId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => Player)
  declare players: HasMany<typeof Player>

  @belongsTo(() => Player, {
    foreignKey: 'winnerId'
  })
  declare winner: BelongsTo<typeof Player>
}