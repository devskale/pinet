/**
 * PiNet — Shared types and constants
 */

import * as path from "node:path";

export interface Identity {
  name: string;
  created: string;
}

export interface PersonalMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

export interface TeamMessage {
  id: string;
  from: string;
  team: string;
  body: string;
  timestamp: string;
}

export interface PresenceEntry {
  name: string;
  status: "online" | "offline";
  pid: number;
  lastSeen: string;
}

export interface TeamMeta {
  name: string;
  members: string[];
  created: string;
}

export interface Binding {
  name: string;
  teams: string[];
  path: string;
  bound: string;
}

export const PINET_DIR = path.join(process.env.HOME || "~", ".pinet");

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
