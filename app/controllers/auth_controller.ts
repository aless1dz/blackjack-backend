import type { HttpContext } from '@adonisjs/core/http'
import User from '../models/user.js'
import hash from '@adonisjs/core/services/hash'

export default class AuthController {

  /**
   * Registro de usuario
   */
  public async register({ request, response }: HttpContext) {
    try {
      const { fullName, email, password } = request.only(['fullName', 'email', 'password'])

      // Verificar si el usuario ya existe
      const existingUser = await User.findBy('email', email)
      if (existingUser) {
        return response.badRequest({ 
          message: 'El email ya está registrado' 
        })
      }

      // Crear el usuario
      const user = await User.create({
        fullName,
        email,
        password
      })

      // Crear token de acceso
      const token = await User.accessTokens.create(user)

      return response.created({
        message: 'Usuario registrado exitosamente',
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          createdAt: user.createdAt
        },
        token: {
          type: 'bearer',
          value: token.value!.release()
        }
      })
    } catch (error) {
      return response.badRequest({ 
        message: 'Error al registrar usuario',
        error: error.message 
      })
    }
  }

  /**
   * Login de usuario
   */
  public async login({ request, response }: HttpContext) {
    try {
      const { email, password } = request.only(['email', 'password'])

      // Buscar usuario por email
      const user = await User.findBy('email', email)
      if (!user) {
        return response.badRequest({ 
          message: 'Credenciales inválidas' 
        })
      }

      // Verificar contraseña
      const isPasswordValid = await hash.verify(user.password, password)
      if (!isPasswordValid) {
        return response.badRequest({ 
          message: 'Credenciales inválidas' 
        })
      }

      // Crear token de acceso
      const token = await User.accessTokens.create(user)

      return response.ok({
        message: 'Login exitoso',
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          createdAt: user.createdAt
        },
        token: {
          type: 'bearer',
          value: token.value!.release()
        }
      })
    } catch (error) {
      return response.badRequest({ 
        message: 'Error al iniciar sesión',
        error: error.message 
      })
    }
  }

  /**
   * Obtener perfil del usuario autenticado
   */
  public async me({ auth, response }: HttpContext) {
    try {
      const user = auth.user!

      return response.ok({
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        }
      })
    } catch (error) {
      return response.unauthorized({ 
        message: 'No autenticado' 
      })
    }
  }

  /**
   * Logout del usuario
   */
  public async logout({ auth, response }: HttpContext) {
    try {
      const user = auth.user!
      
      // Eliminar el token actual
      await User.accessTokens.delete(user, user.currentAccessToken.identifier)

      return response.ok({
        message: 'Logout exitoso'
      })
    } catch (error) {
      return response.badRequest({ 
        message: 'Error al cerrar sesión',
        error: error.message 
      })
    }
  }

  /**
   * Logout de todos los dispositivos
   */
  public async logoutAll({ auth, response }: HttpContext) {
    try {
      const user = auth.user!
      
      // Eliminar todos los tokens del usuario
      await User.accessTokens.all(user).then(tokens => {
        return Promise.all(tokens.map(token => 
          User.accessTokens.delete(user, token.identifier)
        ))
      })

      return response.ok({
        message: 'Logout de todos los dispositivos exitoso'
      })
    } catch (error) {
      return response.badRequest({ 
        message: 'Error al cerrar sesión en todos los dispositivos',
        error: error.message 
      })
    }
  }
}