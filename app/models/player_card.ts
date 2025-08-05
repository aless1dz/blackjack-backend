import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Player from './player.js'

export default class PlayerCard extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare playerId: number

  @column()
  declare card: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @belongsTo(() => Player)
  declare player: BelongsTo<typeof Player>
}