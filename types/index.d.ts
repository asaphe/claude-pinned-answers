export type Pin = { id: string; at: number; question: string; answer: string }

declare module 'claude-code' {
  interface PluginState {
    'pinned-answers': { pins: Shaped<Pin[]>; question: string }
  }
}
