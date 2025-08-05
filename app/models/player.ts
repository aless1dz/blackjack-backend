import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import Game from './game.js'
import PlayerCard from './player_card.js'
import User from './user.js'

export default class Player extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare gameId: number

  @column()
  declare userId: number

  @column()
  declare name: string

  @column()
  declare isHost: boolean

  @column()
  declare totalPoints: number

  @column()
  declare isStand: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => Game)
  declare game: BelongsTo<typeof Game>

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>

  @hasMany(() => PlayerCard)
  declare cards: HasMany<typeof PlayerCard>
}