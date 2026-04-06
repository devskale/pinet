/**
 * Type stubs for pi SDK modules.
 * These are provided at runtime by the pi host — declarations here are for type-checking only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionAPI {
    registerCommand(name: string, config: {
      description: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: any) => Promise<void>;
    }): void;
    registerTool(config: {
      name: string;
      label: string;
      description: string;
      parameters: any;
      execute: (id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }): void;
    sendMessage(msg: { customType: string; content: string; display?: boolean }, options?: { triggerTurn?: boolean }): void;
    on(event: string, handler: (...args: any[]) => void): void;
  }
}

declare module "@mariozechner/pi-tui" {
  export interface AutocompleteItem {
    value: string;
    label: string;
  }
}
