import { Server as SocketServer } from 'socket.io'

class Ws {
  public io: SocketServer

  constructor() {
    this.io = new SocketServer({
      cors: {
        origin: '*'
      }
    })
  }

  public attach(httpServer: any) {
    this.io.attach(httpServer)
  }
}

export default new Ws()