// A test-only `connect` function on node:net and node:tls. It shows that the SMTP
// adapter works over a real socket, not only over the mock. The repository has no
// @types/node, so this file loads the modules at run time and gives them small local
// types. It is not part of the package: on Workers, the app passes `connect` from
// cloudflare:sockets instead.

import type { ProviderSocket, SocketConnect } from "../../src/core/socket";

/** The part of a Node socket that the shim and the test server use. */
export interface NodeSocket {
  write(data: Uint8Array | string, callback?: (error?: Error | null) => void): boolean;
  on(event: "data", listener: (chunk: Uint8Array) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
  once(event: "close", listener: () => void): this;
  end(): void;
  destroy(): void;
}

export interface NodeServer {
  listen(port: number, host: string, callback: () => void): void;
  address(): { port: number };
  close(callback?: () => void): void;
}

export interface NodeNet {
  connect(options: { host: string; port: number }): NodeSocket;
  createServer(listener: (socket: NodeSocket) => void): NodeServer;
}

export interface NodeTls {
  connect(options: {
    socket?: NodeSocket;
    host?: string;
    port?: number;
    servername: string;
    ca?: string;
  }): NodeSocket;
  TLSSocket: new (
    socket: NodeSocket,
    options: { isServer: true; key: string; cert: string },
  ) => NodeSocket;
}

export interface NodeSocketApis {
  net: NodeNet;
  tls: NodeTls;
}

async function load<T>(name: string): Promise<T> {
  return (await import(/* @vite-ignore */ name)) as T;
}

/** Loads node:net and node:tls. Call it only in the Node test project. */
export async function loadNodeSockets(): Promise<NodeSocketApis> {
  return { net: await load<NodeNet>("node:net"), tls: await load<NodeTls>("node:tls") };
}

/** Wraps a Node socket in the `ProviderSocket` shape. */
function wrap(
  socket: NodeSocket,
  upgrade: ((raw: NodeSocket) => NodeSocket) | null,
): ProviderSocket {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const onData = (chunk: Uint8Array) => controller?.enqueue(new Uint8Array(chunk));
  const onEnd = () => {
    try {
      controller?.close();
    } catch {
      // Closed already.
    }
  };
  const onError = (error: Error) => {
    try {
      controller?.error(error);
    } catch {
      // Closed already.
    }
  };
  const readable = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
      socket.on("data", onData);
      socket.on("end", onEnd);
      socket.on("close", onEnd);
      socket.on("error", onError);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        socket.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    },
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", resolve);
  });
  return {
    readable,
    writable,
    closed,
    startTls() {
      if (!upgrade) throw new TypeError("startTls() needs a socket opened with starttls.");
      // The TLS socket reads the raw socket from now on.
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
      return wrap(upgrade(socket), null);
    },
    async close() {
      socket.end();
      socket.destroy();
    },
  };
}

/**
 * A `connect` function on Node. `ca` is the PEM certificate to trust, for a test server
 * with a self-signed certificate. Node checks the certificate and the host name.
 */
export function nodeConnect(apis: NodeSocketApis, options: { ca?: string } = {}): SocketConnect {
  const ca = options.ca === undefined ? {} : { ca: options.ca };
  return (target) => {
    const servername = target.hostname;
    if (target.secureTransport === "on") {
      return wrap(
        apis.tls.connect({ host: target.hostname, port: target.port, servername, ...ca }),
        null,
      );
    }
    const raw = apis.net.connect({ host: target.hostname, port: target.port });
    const upgrade =
      target.secureTransport === "starttls"
        ? (socket: NodeSocket) => apis.tls.connect({ socket, servername, ...ca })
        : null;
    return wrap(raw, upgrade);
  };
}
