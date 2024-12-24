// src/types/config.ts
export interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Config {
  mcpServers: Record<string, ServerConfig>;
}