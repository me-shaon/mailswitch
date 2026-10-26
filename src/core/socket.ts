// The TCP socket capability. Core code never imports `cloudflare:sockets`. A Worker
// passes its `connect` function in, and tests pass the mock SMTP server.

/**
 * How a socket starts: `off` is plain TCP, `on` is TLS from the first byte (implicit
 * TLS, port 465), and `starttls` is plain TCP that `startTls()` upgrades later.
 */
export type SecureTransport = "off" | "on" | "starttls";

/** Where a socket connects to. */
export interface SocketTarget {
  hostname: string;
  port: number;
  secureTransport: SecureTransport;
}

/**
 * A TCP socket: the subset of a `cloudflare:sockets` socket that adapters use. The
 * platform validates TLS certificates, and adapters cannot turn that off.
 */
export interface ProviderSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Settles when the socket closes. */
  readonly closed: Promise<void>;
  /**
   * Upgrades a `starttls` socket to TLS and returns the new socket. Release the reader
   * and the writer of this socket first, and use only the new one after it.
   */
  startTls(): ProviderSocket;
  close(): Promise<void>;
}

/** Opens a socket, like `connect()` of `cloudflare:sockets` with `allowHalfOpen: false`. */
export type SocketConnect = (target: SocketTarget) => ProviderSocket;
