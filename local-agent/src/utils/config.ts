/**
 * Config — Persistent agent configuration (room token, etc.)
 *
 * Stores config in app.getPath('userData')/config.json
 * (~/Library/Application Support/WFA Agent/config.json on macOS).
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

export interface AgentConfig {
  roomId: string;
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): AgentConfig | null {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.roomId === 'string' && parsed.roomId.length > 0) {
      return parsed as AgentConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: AgentConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  log(`[config] Saved to ${configPath}`);
}
