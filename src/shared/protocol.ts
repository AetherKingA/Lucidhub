// Messages exchanged over the WebSocket. Shared by server and client so both stay in sync.

export interface UserInfo {
  id: number;
  username: string;
  avatarUrl: string;
  isAdmin: boolean;
}

export type ServerMessage =
  | { type: "hello"; user: UserInfo; online: number }
  | { type: "online"; count: number }
  | { type: "pong"; t: number }
  | { type: "error"; message: string };

export type ClientMessage = { type: "ping"; t: number };
