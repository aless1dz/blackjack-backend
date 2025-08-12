/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

router.get('/', async () => {
  return {
    hello: 'world',
  }
})

// Rutas de autenticación públicas
router.group(() => {
  router.post('/register', '#controllers/auth_controller.register')
  router.post('/login', '#controllers/auth_controller.login')
}).prefix('/api/auth')

// Rutas de autenticación protegidas
router.group(() => {
  router.get('/me', '#controllers/auth_controller.me')
  router.post('/logout', '#controllers/auth_controller.logout')
  router.post('/logout-all', '#controllers/auth_controller.logoutAll')
}).prefix('/api/auth').use(middleware.auth())

// Rutas de juegos (requieren autenticación)
router.group(() => {
  router.get('/games/available', '#controllers/games_controller.listAvailable')
  router.post('/games', '#controllers/games_controller.create')
  router.post('/games/:id/join', '#controllers/games_controller.join')
  router.post('/games/:id/start', '#controllers/games_controller.start')
  router.get('/games/:id/info', '#controllers/games_controller.info')
  router.post('/games/request-card', '#controllers/games_controller.requestCard')
  router.post('/games/deal-card', '#controllers/games_controller.dealCard')
  router.post('/games/stand', '#controllers/games_controller.stand')
  router.post('/games/stand-player', '#controllers/games_controller.standPlayer')
  router.post('/games/leave', '#controllers/games_controller.leave')
  router.get('/games/:id/status', '#controllers/games_controller.status')
  router.post('/games/:id/finish', '#controllers/games_controller.finish')
  router.post('/games/:id/reveal-finish', '#controllers/games_controller.revealAndFinish')
  router.post('/games/:id/propose-rematch', '#controllers/games_controller.proposeRematch')
  router.post('/games/:id/respond-rematch', '#controllers/games_controller.respondToRematch')
  router.get('/games/:id/players-for-rematch', '#controllers/games_controller.getPlayersForRematch')
  router.get('/games/:id/pending-card-requests', '#controllers/games_controller.getPendingCardRequests')
}).prefix('/api').use(middleware.auth())
