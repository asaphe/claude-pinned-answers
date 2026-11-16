export type Pin = { id: string; at: number; question: string; answer: string; clearAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'pinned-answers': {
      pins: Shaped<Pin[]>
      question: string
      asked: string
      askedIn: string
      answered: string
    }
  }
}
