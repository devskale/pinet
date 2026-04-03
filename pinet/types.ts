/**
 * PiNet — Shared types, constants, and path configuration.
 *
 * This module has zero runtime dependencies beyond Node path module.
 * All interfaces here are pure data — no behavior.
 */

import * as path from "node:path";

// =============================================================================
// Path configuration
// =============================================================================

/** Root directory for all PiNet state */
export const PINET_DIR = path.join(process.env.HOME || "~", ".pinet");

/** Valid name pattern for agents and teams */
export const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// =============================================================================
// Interfaces
// =============================================================================

/** An agent's identity — append-only log entry */
export interface Identity {
  name: string;
  created: string;
}

/** A personal (DM) message between two agents */
export interface PersonalMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

/** A message in a team chat */
export interface TeamMessage {
  id: string;
  from: string;
  team: string;
  body: string;
  timestamp: string;
}

/** Current online/offline state of an agent */
export interface PresenceEntry {
  name: string;
  status: "online" | "offline";
  pid: number;
  lastSeen: string;
}

/** Team metadata — the roster */
export interface TeamMeta {
  name: string;
  members: string[];
  created: string;
}

/** Folder → identity binding for auto-login */
export interface Binding {
  name: string;
  teams: string[];
  path: string;
  bound: string;
}

// =============================================================================
// Name generation word lists
// =============================================================================

export const ADJECTIVES = [
  "Swift", "Bold", "Calm", "Dark", "Fast", "Gold", "Iron", "Jade",
  "Keen", "Late", "Neon", "Oak", "Pale", "Red", "Sage", "Teal",
  "Warm", "Wild", "Zen", "Aero", "Blue", "Cyan", "Deep", "Edge",
  "Fine", "Gray", "High", "Icy", "Jet", "Kind", "Low", "Mint",
];

export const NOUNS = [
  "Fox", "Wolf", "Hawk", "Bear", "Elm", "Owl", "Pine", "Reed",
  "Star", "Tide", "Wind", "Ash", "Birch", "Cliff", "Dawn", "Echo",
  "Fern", "Gale", "Haze", "Iris", "Jade", "Kite", "Lake", "Moss",
  "Peak", "Rain", "Stone", "Thorn", "Vale", "Wave", "Yew", "Ridge",
];
